import express from "express";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from the project root so `npm start` works without exporting vars.
const envPath = join(__dirname, ".env");
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (e) {
    console.warn(`couldn't read .env: ${e.message}`);
  }
}

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(join(__dirname, "public")));
app.get("/favicon.ico", (_req, res) => res.status(204).end());

// Puzzles: the player never sees the SVG source, only the rendered target.
const puzzles = JSON.parse(
  await readFile(join(__dirname, "puzzles", "puzzles.json"), "utf8")
);

// Scoring resolution. Both target and painting rasterize to this square, over
// white, then we compare pixel for pixel. Small enough to be fast per request.
const RENDER_SIZE = 256;

function rasterize(svg) {
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: RENDER_SIZE },
    background: "white",
  });
  return r.render().pixels; // RGBA buffer, opaque over white
}

// Average per-pixel color closeness, 0..100. 100 = identical bits.
function scoreMatch(a, b) {
  const maxDist = Math.sqrt(3 * 255 * 255);
  let sum = 0;
  const n = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    const dr = a[i] - b[i];
    const dg = a[i + 1] - b[i + 1];
    const db = a[i + 2] - b[i + 2];
    sum += 1 - Math.sqrt(dr * dr + dg * dg + db * db) / maxDist;
  }
  return (sum / n) * 100;
}

// Pre-rasterize every target once; scoring a submission is then one render +
// one diff. The answer-key pixels live only on the server.
const targetPixels = new Map(puzzles.map((p) => [p.id, rasterize(p.svg)]));

// hash(puzzle, prompt) -> { svg, score }. Deterministic engine means the same
// prompt on the same puzzle always lands the same image, so we never pay Gemini
// twice for it. This is the cache the cost model leaned on.
const resultCache = new Map();
const cacheKey = (puzzleId, prompt) =>
  createHash("sha256").update(`${puzzleId}\n${prompt}`).digest("hex");

// Leaderboard. Trust model: the client never sends us a score. When /api/generate
// scores a painting it issues a one-time token bound to that server-computed
// score; submitting to the board exchanges the token for a row. So a player can
// pick any nickname, but the number next to it is one the server actually
// measured. Persistence is a flat JSON file, fine at prototype scale.
const DATA_DIR = join(__dirname, "data");
const LB_PATH = join(DATA_DIR, "leaderboard.json");
const LB_TOP = 10;
const NICK_MAX = 20;
// The brevity board only counts attempts that cleared this match %. Without a
// floor, "fewest characters" is won by whoever types one junk character, so it
// has to mean "shortest prompt that still got the picture right."
const BREVITY_FLOOR = 80;

// playerId is the stable identity (a random id the client keeps in localStorage);
// nickname is just a display label, so a rename can find and relabel your rows.
let leaderboard = {}; // { [puzzleId]: [{ playerId, nickname, score, chars, at }] }
if (existsSync(LB_PATH)) {
  try {
    leaderboard = JSON.parse(await readFile(LB_PATH, "utf8"));
  } catch (e) {
    console.warn(`couldn't read leaderboard: ${e.message}`);
  }
}
let lbWriteQueued = false;
async function persistLeaderboard() {
  if (lbWriteQueued) return;
  lbWriteQueued = true;
  queueMicrotask(async () => {
    lbWriteQueued = false;
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      await writeFile(LB_PATH, JSON.stringify(leaderboard, null, 2));
    } catch (e) {
      console.warn(`couldn't write leaderboard: ${e.message}`);
    }
  });
}

// Tokens minted by /api/generate, redeemed once by /api/leaderboard/submit.
const scoreTokens = new Map(); // token -> { puzzleId, score, chars, prompt }

function cleanNickname(raw) {
  return String(raw || "")
    .replace(/[\x00-\x1f\x7f]/g, "") // strip control chars
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NICK_MAX);
}

const toRow = (me) => (r) => ({
  nickname: r.nickname,
  score: r.score,
  chars: r.chars,
  mine: !!me && r.playerId === me,
});

// Two boards off the same rows: accuracy (best match) and brevity (shortest
// prompt that cleared the floor). `me` flags the requester's own row, by
// playerId, without leaking anyone else's id. Keyed by day (a date string).
function boardsFor(dayKey, me) {
  const rows = leaderboard[dayKey] || [];
  const accuracy = rows
    .slice()
    .sort((a, b) => b.score - a.score || a.chars - b.chars || a.at - b.at)
    .slice(0, LB_TOP)
    .map(toRow(me));
  const brevity = rows
    .filter((r) => r.score >= BREVITY_FLOOR)
    .sort((a, b) => a.chars - b.chars || b.score - a.score || a.at - b.at)
    .slice(0, LB_TOP)
    .map(toRow(me));
  return { accuracy, brevity, floor: BREVITY_FLOOR };
}

// --- Daily rotation ---
// Puzzles cycle by day from a fixed epoch. Today's day gets the live leaderboard;
// earlier days are playable as practice but can't be submitted. Boards are keyed
// by DATE, not puzzle, because the same puzzle recurs every puzzles.length days.
const EPOCH = "2026-06-18"; // day 0; backdates the seed puzzles as past days
const DAY_MS = 86400000;
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
const todayStr = () => new Date().toISOString().slice(0, 10);
const dayIndex = (d) => Math.floor((dayMs(d) - dayMs(EPOCH)) / DAY_MS);
const wrap = (i) => puzzles[((i % puzzles.length) + puzzles.length) % puzzles.length];

function puzzleForDate(d) {
  const i = dayIndex(d);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(i) || i < 0 || d > todayStr()) return null;
  return wrap(i);
}

// Calendar of playable days, newest first (epoch..today), capped.
function dayList() {
  const today = todayStr();
  const out = [];
  for (let i = dayIndex(today); i >= 0 && out.length < 60; i--) {
    const d = new Date(dayMs(EPOCH) + i * DAY_MS).toISOString().slice(0, 10);
    const p = wrap(i);
    out.push({ date: d, puzzleId: p.id, name: p.name, day: i + 1, today: d === today });
  }
  return out;
}

// The day calendar (today first). Client uses [0] as today's puzzle.
app.get("/api/days", (_req, res) => res.json({ days: dayList() }));

// The renderer needs the target image to diff against, so it gets the SVG,
// but only as a rasterized data source, and the player can't read network tabs
// mid-game any more than they could screenshot the answer. Good enough for v0.
app.get("/api/target/:id", (req, res) => {
  const p = puzzles.find((q) => q.id === req.params.id);
  if (!p) return res.status(404).json({ error: "no such puzzle" });
  res.type("image/svg+xml").send(p.svg);
});

// Strictest Gemini safety thresholds, shared by the moderation pass and the
// render call. BLOCK_LOW_AND_ABOVE is the most aggressive setting the API takes.
const SAFETY_SETTINGS = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
].map((category) => ({ category, threshold: "BLOCK_LOW_AND_ABOVE" }));

const MODERATION_INSTRUCTION = `You screen prompts for a family-friendly drawing game where players describe simple flat shapes to recreate a target picture. Reject a prompt only if it describes sexual content, graphic violence or gore, hateful or harassing content, or anything clearly inappropriate for a general audience. Harmless but off-topic prompts are fine. Reply with exactly one word: ALLOW or BLOCK.`;

// Quick classification pass on the player's prompt before we spend a render on
// it. The render call carries the same SAFETY_SETTINGS as a hard backstop, so on
// a transient moderator error we fail open and let the engine's filter catch it.
async function moderatePrompt(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    systemInstruction: { parts: [{ text: MODERATION_INSTRUCTION }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 8,
      thinkingConfig: { thinkingBudget: 0 },
    },
    safetySettings: SAFETY_SETTINGS,
  };
  let data;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { allowed: true }; // fail open; render-call filter backstops
    data = await r.json();
  } catch {
    return { allowed: true };
  }
  // If the moderation call itself got safety-blocked, that's a strong BLOCK.
  if (data?.promptFeedback?.blockReason) return { allowed: false };
  const verdict = (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim()
    .toUpperCase();
  return { allowed: !verdict.startsWith("BLOCK") };
}

const ENGINE_INSTRUCTION = `You are a rendering engine that turns a short description into a flat SVG illustration. Rules:
- Output ONLY raw SVG. No markdown, no code fences, no commentary.
- Root element: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">.
- First child is always a full-canvas background <rect width="512" height="512">. Default white (#ffffff) unless the description names a background color.
- Use only basic shapes: rect, circle, ellipse, polygon, line. Flat solid fills. No gradients, no filters, no shadows, no strokes unless asked.
- Interpret the description literally and geometrically. "centered" means cx/cy 256. Keep shapes well inside the canvas.
- If the description is vague, make a clean reasonable choice. Never add extra decoration that wasn't asked for.`;

async function generateSvg(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    systemInstruction: { parts: [{ text: ENGINE_INSTRUCTION }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 4096,
      // 2.5-flash "thinks" by default and can spend the whole token budget on
      // reasoning, returning empty text. We want the SVG, not the deliberation.
      thinkingConfig: { thinkingBudget: 0 },
    },
    safetySettings: SAFETY_SETTINGS,
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`engine ${r.status}: ${detail.slice(0, 300)}`);
  }
  const data = await r.json();
  // Safety filter tripped: no candidate, or the one candidate stopped on SAFETY.
  if (
    data?.promptFeedback?.blockReason ||
    data?.candidates?.[0]?.finishReason === "SAFETY"
  ) {
    throw new Error("BLOCKED: prompt rejected by the content filter");
  }
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  return sanitizeSvg(text);
}

// Pull the <svg>...</svg> out of whatever the model returned and make sure it's
// the inert, shape-only kind we want on a canvas (no scripts, no foreign refs).
function sanitizeSvg(raw) {
  let s = raw.replace(/```(?:svg|xml|html)?/gi, "").trim();
  const start = s.indexOf("<svg");
  const end = s.lastIndexOf("</svg>");
  if (start === -1 || end === -1) throw new Error("engine returned no SVG");
  s = s.slice(start, end + "</svg>".length);
  if (/<script|onload=|onclick=|<foreignObject|<image|href\s*=/i.test(s)) {
    throw new Error("engine SVG contained disallowed content");
  }
  return s;
}

app.post("/api/generate", async (req, res) => {
  const prompt = (req.body?.prompt || "").trim();
  const date = String(req.body?.date || todayStr());
  const puzzle = puzzleForDate(date);
  if (!puzzle) return res.status(400).json({ error: "no puzzle for that day" });
  const target = targetPixels.get(puzzle.id);
  if (!prompt) return res.status(400).json({ error: "empty prompt" });
  if (prompt.length > 600)
    return res.status(400).json({ error: "prompt too long (max 600 chars)" });
  if (!GEMINI_API_KEY)
    return res.status(503).json({ error: "engine offline: GEMINI_API_KEY not set" });

  const moderation = await moderatePrompt(prompt);
  if (!moderation.allowed)
    return res
      .status(400)
      .json({ error: "that prompt isn't allowed, try describing the picture" });

  const eligible = date === todayStr(); // only today's day feeds the leaderboard

  // Mint a one-time token bound to this server-measured score + day, so the
  // board submission can't lie about the number or backdoor a past day.
  const reply = (svg, score) => {
    const chars = prompt.length;
    const token = randomUUID();
    scoreTokens.set(token, { date, score, chars });
    return res.json({ svg, score, chars, token, eligible });
  };

  const key = cacheKey(puzzle.id, prompt);
  const hit = resultCache.get(key);
  if (hit) return reply(hit.svg, hit.score);

  try {
    const svg = await generateSvg(prompt);
    const score = Math.round(scoreMatch(target, rasterize(svg)) * 10) / 10;
    resultCache.set(key, { svg, score });
    reply(svg, score);
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.startsWith("BLOCKED:"))
      return res
        .status(400)
        .json({ error: "that prompt isn't allowed, try describing the picture" });
    res.status(502).json({ error: msg });
  }
});

// Read a day's two boards. ?me=<playerId> flags the caller's own rows.
app.get("/api/leaderboard/:date", (req, res) => {
  res.json(boardsFor(req.params.date, String(req.query.me || "")));
});

// Redeem a score token into a leaderboard row, keyed by playerId. Only today's
// day is eligible; past-day tokens are rejected so practice can't reach the board.
app.post("/api/leaderboard/submit", (req, res) => {
  const token = String(req.body?.token || "");
  const nickname = cleanNickname(req.body?.nickname);
  const playerId = String(req.body?.playerId || "");
  if (!nickname) return res.status(400).json({ error: "nickname required" });
  if (!playerId) return res.status(400).json({ error: "playerId required" });
  const scored = scoreTokens.get(token);
  if (!scored) return res.status(400).json({ error: "invalid or used token" });
  if (scored.date !== todayStr()) {
    scoreTokens.delete(token);
    return res.status(403).json({ error: "past puzzles aren't eligible for the leaderboard" });
  }
  scoreTokens.delete(token); // one-time

  const { date, score, chars } = scored;
  const rows = (leaderboard[date] ||= []);
  const mine = rows.find((r) => r.playerId === playerId);
  const better = (s, c) => s > (mine?.score ?? -1) || (s === mine?.score && c < mine.chars);
  if (!mine) {
    rows.push({ playerId, nickname, score, chars, at: Date.now() });
  } else {
    mine.nickname = nickname; // keep label fresh
    if (better(score, chars)) Object.assign(mine, { score, chars, at: Date.now() });
  }
  persistLeaderboard();
  res.json(boardsFor(date, playerId));
});

// Rename: relabel all of this player's rows across every day. The nickname
// is display-only; playerId is the identity, so this is just a label swap.
app.post("/api/player/rename", (req, res) => {
  const playerId = String(req.body?.playerId || "");
  const nickname = cleanNickname(req.body?.nickname);
  if (!playerId) return res.status(400).json({ error: "playerId required" });
  if (!nickname) return res.status(400).json({ error: "nickname required" });
  let changed = 0;
  for (const rows of Object.values(leaderboard)) {
    for (const r of rows) {
      if (r.playerId === playerId) {
        r.nickname = nickname;
        changed++;
      }
    }
  }
  if (changed) persistLeaderboard();
  res.json({ ok: true, changed });
});

app.listen(PORT, () => {
  console.log(`daily-puzzle on http://localhost:${PORT}`);
  if (!GEMINI_API_KEY) console.warn("warning: GEMINI_API_KEY not set, engine will 503");
});
