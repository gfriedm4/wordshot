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

// Nickname uniqueness: one display name per player at a time. Keyed by the
// lowercased name -> playerId that holds it. Renaming frees the old name (the
// player's prior claim is released), so it becomes available to others.
const CLAIMS_PATH = join(DATA_DIR, "claims.json");
let nickClaims = {}; // { [lowercasedName]: playerId }
if (existsSync(CLAIMS_PATH)) {
  try {
    nickClaims = JSON.parse(await readFile(CLAIMS_PATH, "utf8"));
  } catch (e) {
    console.warn(`couldn't read claims: ${e.message}`);
  }
}
// Seed from existing leaderboard rows so prior boards keep their names reserved.
for (const rows of Object.values(leaderboard)) {
  for (const r of rows) {
    const k = r.nickname.toLowerCase();
    if (!(k in nickClaims)) nickClaims[k] = r.playerId;
  }
}
let claimsWriteQueued = false;
function persistClaims() {
  if (claimsWriteQueued) return;
  claimsWriteQueued = true;
  queueMicrotask(async () => {
    claimsWriteQueued = false;
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      await writeFile(CLAIMS_PATH, JSON.stringify(nickClaims, null, 2));
    } catch (e) {
      console.warn(`couldn't write claims: ${e.message}`);
    }
  });
}

// Try to give `nickname` to `playerId`. Frees any name this player already held.
// Returns true if claimed, false if another player holds it.
function claimNickname(nickname, playerId) {
  const key = nickname.toLowerCase();
  const holder = nickClaims[key];
  if (holder && holder !== playerId) return false;
  for (const [k, pid] of Object.entries(nickClaims)) {
    if (pid === playerId && k !== key) delete nickClaims[k]; // free old name
  }
  nickClaims[key] = playerId;
  persistClaims();
  return true;
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

// Deterministic first-pass denylist: exact-term matches for known hate symbols
// and slurs, checked before the LLM moderator so the named cases are airtight
// even if the classifier has an off day. Light leetspeak folding defeats the
// obvious "n4zi" dodges. This catches NAMED terms only; geometric obfuscation
// (describing a symbol without naming it) still leans on the moderator. Edit the
// list to tune.
const DENY_PATTERNS = [
  /\bswastika\b/,
  /\bswastica\b/,
  /\bnazi/,
  /\bhitler\b/,
  /\bsieg\s*heil\b/,
  /\bheil\s*hitler\b/,
  /\bkkk\b/,
  /\bku\s*klux\s*klan\b/,
  /\bklan\b/,
  /\bwhite\s*power\b/,
  /\bwhite\s*supremac/,
  /\bss\s*bolts?\b/,
  /\bconfederate\s*flag\b/,
];

function denylisted(prompt) {
  return DENY_PATTERNS.some((re) => re.test(leetFold(prompt)));
}

function leetFold(s) {
  return s
    .toLowerCase()
    .replace(/[4@]/g, "a")
    .replace(/3/g, "e")
    .replace(/[1!|]/g, "i")
    .replace(/0/g, "o")
    .replace(/[$5]/g, "s")
    .replace(/7/g, "t");
}

// Nicknames are free text on a public board, so they get their own profanity
// gate. We collapse to letters/digits only (leet-folded) so "f.u.c.k" and
// "b_i_t_c_h" can't slip through, then substring-match a curated list. Terms are
// chosen long/unambiguous to avoid the Scunthorpe problem; hate terms reuse the
// prompt denylist. Not exhaustive by design — the admin remove endpoint is the
// backstop for anything creative that gets past it.
// Safe as substrings: these don't appear inside common innocent words, so we
// match them even through separators (collapsed form catches "f.u.c.k").
const NICK_COLLAPSE_DENY = [
  "fuck", "shit", "bitch", "cunt", "asshole", "dickhead", "motherfucker",
  "pussy", "faggot", "nigger", "nigga", "whore", "slut", "blowjob", "handjob",
  "cumshot", "jizz", "kike", "wetback", "tranny", "molest", "pedophile",
];
// Scunthorpe-prone: would wrongly flag therapist/grape/despicable/raccoon/
// torpedo as substrings, so these need a word boundary instead.
const NICK_WORD_DENY = [
  /\brape\b/, /\brapist\b/, /\bspic\b/, /\bcoon/, /\bpedo/, /\bchink/,
  /\bporn/, /\bretard/, /\bcum\b/,
  // \bjews?\b blocks the bare demonym/slur but leaves jewel/jewish/jewelry; the
  // rest are anatomy/sexual terms kept word-bounded to dodge uranus/openisland.
  /\bjews?\b/, /\bjew(boy|rat|bag)/, /\bpenis/, /\bvagina/, /\bdildo/, /\banus\b/, /\bscrotum/, /\bboner\b/,
];

function nicknameAllowed(nick) {
  if (denylisted(nick)) return false;
  const folded = leetFold(nick);
  if (NICK_WORD_DENY.some((re) => re.test(folded))) return false;
  const collapsed = folded.replace(/[^a-z0-9]/g, "");
  return !NICK_COLLAPSE_DENY.some((term) => collapsed.includes(term));
}

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

const NICK_MOD_INSTRUCTION = `You screen player nicknames for a family-friendly daily game. The nickname appears on a public leaderboard. BLOCK it if it contains or clearly evokes: profanity or slurs (any language, including creative/leetspeak spellings), sexual content, hate or harassment, violence, or impersonation of staff/admins. Plain harmless handles are fine. Reply with exactly one word: ALLOW or BLOCK.`;

async function moderateNickname(nick) {
  if (!GEMINI_API_KEY) return { allowed: true }; // engine offline; local list still applied
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    systemInstruction: { parts: [{ text: NICK_MOD_INSTRUCTION }] },
    contents: [{ role: "user", parts: [{ text: nick }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 8, thinkingConfig: { thinkingBudget: 0 } },
    safetySettings: SAFETY_SETTINGS,
  };
  let data;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { allowed: true }; // fail open; local denylist already ran
    data = await r.json();
  } catch {
    return { allowed: true };
  }
  if (data?.promptFeedback?.blockReason) return { allowed: false };
  const verdict = (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim()
    .toUpperCase();
  return { allowed: !verdict.startsWith("BLOCK") };
}

// Full nickname gate used by submit + rename: instant local denylist, then the
// LLM moderator (catches creative spellings the list misses), then uniqueness.
// Returns { ok } or { ok:false, error }. Claims the name on success.
async function vetNickname(nickname, playerId) {
  if (!nickname) return { ok: false, error: "nickname required" };
  if (!nicknameAllowed(nickname))
    return { ok: false, error: "that nickname isn't allowed — pick another" };
  const mod = await moderateNickname(nickname);
  if (!mod.allowed)
    return { ok: false, error: "that nickname isn't allowed — pick another" };
  if (!claimNickname(nickname, playerId))
    return { ok: false, error: "that nickname's taken — pick another" };
  return { ok: true };
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

  if (denylisted(prompt))
    return res
      .status(400)
      .json({ error: "that prompt isn't allowed, try describing the picture" });

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
app.post("/api/leaderboard/submit", async (req, res) => {
  const token = String(req.body?.token || "");
  const nickname = cleanNickname(req.body?.nickname);
  const playerId = String(req.body?.playerId || "");
  if (!playerId) return res.status(400).json({ error: "playerId required" });
  const scored = scoreTokens.get(token);
  if (!scored) return res.status(400).json({ error: "invalid or used token" });
  if (scored.date !== todayStr()) {
    scoreTokens.delete(token);
    return res.status(403).json({ error: "past puzzles aren't eligible for the leaderboard" });
  }
  // Gate the nickname (denylist + LLM + uniqueness) before consuming the token,
  // so a rejected name can be fixed and retried with the same token.
  const vet = await vetNickname(nickname, playerId);
  if (!vet.ok) return res.status(400).json({ error: vet.error });
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
app.post("/api/player/rename", async (req, res) => {
  const playerId = String(req.body?.playerId || "");
  const nickname = cleanNickname(req.body?.nickname);
  if (!playerId) return res.status(400).json({ error: "playerId required" });
  const vet = await vetNickname(nickname, playerId);
  if (!vet.ok) return res.status(400).json({ error: vet.error });
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

// Admin backstop: remove a single row, or clear a whole day's board. Guarded by
// the ADMIN_TOKEN env var (set it in .env); disabled if unset. Use to pull a
// nickname that slipped the filter, or to wipe test data before launch.
//   curl -X POST https://wordshot.art/api/admin/remove \
//     -H "x-admin-token: $ADMIN_TOKEN" -H "content-type: application/json" \
//     -d '{"date":"2026-06-23","nickname":"ross_test"}'   # one row
//     -d '{"date":"2026-06-23"}'                            # whole day
app.post("/api/admin/remove", (req, res) => {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return res.status(503).json({ error: "admin disabled: ADMIN_TOKEN not set" });
  if (req.get("x-admin-token") !== token)
    return res.status(403).json({ error: "forbidden" });

  const date = String(req.body?.date || "");
  const nickname = req.body?.nickname;
  const playerId = req.body?.playerId;
  if (!date || !leaderboard[date])
    return res.status(404).json({ error: "no such day" });

  const before = leaderboard[date].length;
  if (nickname == null && playerId == null) {
    delete leaderboard[date]; // clear the whole day
  } else {
    leaderboard[date] = leaderboard[date].filter(
      (r) => r.nickname !== nickname && r.playerId !== playerId
    );
  }
  persistLeaderboard();
  const after = leaderboard[date]?.length ?? 0;
  res.json({ ok: true, removed: before - after });
});

app.listen(PORT, () => {
  console.log(`daily-puzzle on http://localhost:${PORT}`);
  if (!GEMINI_API_KEY) console.warn("warning: GEMINI_API_KEY not set, engine will 503");
});
