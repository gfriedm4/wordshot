import express from "express";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
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
// One reverse proxy (Caddy) sits in front, so trust its X-Forwarded-For to get
// the real client IP for rate limiting.
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));
app.use(express.static(join(__dirname, "public")));
app.get("/favicon.ico", (_req, res) => res.status(204).end());

// Lightweight in-memory per-IP rate limiter (single instance, no dependency).
// Returns Express middleware enforcing `max` requests per `windowMs` per IP.
function rateLimit({ windowMs, max, message }) {
  const hits = new Map(); // ip -> { count, reset }
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 5000) for (const [k, e] of hits) if (now > e.reset) hits.delete(k);
    const ip = req.ip || "?";
    let e = hits.get(ip);
    if (!e || now > e.reset) { e = { count: 0, reset: now + windowMs }; hits.set(ip, e); }
    e.count++;
    if (e.count > max) {
      const retry = Math.ceil((e.reset - now) / 1000);
      res.set("Retry-After", String(retry));
      return res.status(429).json({ error: message || `slow down — try again in ${retry}s` });
    }
    next();
  };
}

// The expensive path (each miss = a paid Gemini call) gets the tightest caps:
// a per-minute burst limit and a per-day ceiling, both per IP.
const generateLimits = [
  rateLimit({ windowMs: 60_000, max: Number(process.env.RL_GEN_PER_MIN) || 20 }),
  rateLimit({ windowMs: 86_400_000, max: Number(process.env.RL_GEN_PER_DAY) || 400 }),
];
// Writes (name set/score submit) are cheap but spammable; looser cap.
const writeLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.RL_WRITE_PER_MIN) || 40 });
// The admin endpoint is a single high-entropy token, but an open POST is still
// worth a tight per-IP cap so it can't be hammered.
const adminLimit = rateLimit({ windowMs: 60_000, max: 10, message: "forbidden" });

// Global circuit breaker on the paid render path. Per-IP limits stop one client,
// but nothing stops a swarm of IPs from running up the Gemini bill, so we also
// cap total paid renders per UTC day across everyone. Cache hits don't count
// (they cost nothing). When the ceiling trips, generate returns 503 until the
// day rolls over. Set GEN_GLOBAL_DAILY_MAX=0 to disable.
const GEN_GLOBAL_DAILY_MAX = process.env.GEN_GLOBAL_DAILY_MAX != null
  ? Number(process.env.GEN_GLOBAL_DAILY_MAX)
  : 2000;
let genDayKey = "";
let genDayCount = 0;
// Returns false when the global daily ceiling is already spent. Call right
// before a paid render; rolls the counter when the UTC day changes.
function globalRenderBudgetOk() {
  if (!GEN_GLOBAL_DAILY_MAX) return true; // disabled
  const key = new Date().toISOString().slice(0, 10);
  if (key !== genDayKey) { genDayKey = key; genDayCount = 0; }
  return genDayCount < GEN_GLOBAL_DAILY_MAX;
}

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
// Append-only play log: one JSON line per painting the engine produced, win or
// not, submitted to the board or not. This is the model dataset — every
// (target, prompt, score, image) the game has ever generated — and the source
// the "yesterday's top prompts" display reads from. Captured at generate time
// because that's the only point the prompt and svg exist together; the
// leaderboard only ever kept the score. Whatever isn't written here is lost.
const PLAYS_PATH = join(DATA_DIR, "plays.jsonl");
async function logPlay(record) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    await appendFile(PLAYS_PATH, JSON.stringify(record) + "\n");
  } catch (e) {
    console.warn(`couldn't write play log: ${e.message}`);
  }
}
const LB_TOP = 10;
const NICK_MAX = 20;
// The brevity board only counts attempts that cleared this match %. Without a
// floor, "fewest characters" is won by whoever types one junk character, so it
// has to mean "shortest prompt that still got the picture right."
const BREVITY_FLOOR = 80;

// playerId is the stable identity (a random id the client keeps in localStorage);
// nickname is just a display label, so a rename can find and relabel your rows.
// One submission per player per day: the shot they chose out of their three.
// Both boards read off that single row (accuracy from score, brevity from chars).
let leaderboard = {}; // { [date]: [{ playerId, nickname, score, chars, at }] }
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
// They carry an expiry so generating-without-submitting can't grow this map
// unbounded; a stale token is swept on the next mint and rejected on redemption.
const scoreTokens = new Map(); // token -> { date, score, chars, exp }
const SCORE_TOKEN_TTL_MS = 60 * 60_000; // 1h: plenty of time to type a nickname
function sweepScoreTokens(now) {
  for (const [t, v] of scoreTokens) if (now > v.exp) scoreTokens.delete(t);
}

// Per-player shot cap on today's competitive puzzle. A player gets a fixed
// number of distinct shots; retyping a prompt they already fired is a cache hit
// and doesn't burn a new one. Keyed by `${playerId}\n${date}` -> Set<cacheKey>,
// cleared wholesale when the ET day rolls over (practice on past days is uncapped
// here — only IP and global ceilings apply to those).
const SHOTS_PER_PUZZLE = Number(process.env.SHOTS_PER_PUZZLE) || 3;
// Best-of-3 turns on at the start of this ET puzzle day; earlier days (today at
// deploy time, and any past-day practice) stay one shot, so a puzzle already in
// play doesn't change rules mid-flight. Dates are YYYY-MM-DD, lexicographic.
const BEST_OF_3_DATE = process.env.BEST_OF_3_DATE || "2026-06-25";
const shotsAllowed = (date) => (date >= BEST_OF_3_DATE ? SHOTS_PER_PUZZLE : 1);
const shotsUsed = new Map();
let shotsDayKey = "";
function shotsFor(playerId, date) {
  const today = todayStr();
  if (today !== shotsDayKey) {
    shotsDayKey = today;
    shotsUsed.clear();
  }
  const k = `${playerId}\n${date}`;
  let s = shotsUsed.get(k);
  if (!s) {
    s = new Set();
    shotsUsed.set(k, s);
  }
  return s;
}

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
// "Today" is keyed to US Eastern, so the daily puzzle resets at midnight ET for
// everyone (one global boundary the shared leaderboard can agree on). en-CA
// formats as YYYY-MM-DD; the timeZone option is DST-aware, so this tracks the
// EST/EDT switch automatically without a date library.
const ET_ZONE = "America/New_York";
const etDateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: ET_ZONE });
const todayStr = () => etDateFmt.format(new Date());
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
    out.push({ date: d, puzzleId: p.id, name: p.name, banned: p.banned || [], day: i + 1, today: d === today });
  }
  return out;
}

// The day calendar (today first). Client uses [0] as today's puzzle.
app.get("/api/days", (_req, res) => res.json({ days: dayList() }));

// A puzzle id is only servable if it's the target for some date at or before
// today. Without this, /api/target/:id would hand out every future day's answer
// (ids are sequential 001..NNN), letting anyone pre-solve the whole rotation.
// Once we're a full cycle past the epoch, every id is reachable anyway.
function targetPlayable(id) {
  const limit = Math.min(dayIndex(todayStr()), puzzles.length - 1);
  for (let i = 0; i <= limit; i++) if (wrap(i).id === id) return true;
  return false;
}

// The renderer needs the target image to diff against, so it gets the SVG,
// but only as a rasterized data source, and the player can't read network tabs
// mid-game any more than they could screenshot the answer. Future-day targets
// are withheld so the leaderboard can't be pre-solved.
app.get("/api/target/:id", (req, res) => {
  const p = puzzles.find((q) => q.id === req.params.id);
  if (!p || !targetPlayable(p.id)) return res.status(404).json({ error: "no such puzzle" });
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

// Consonant skeleton: the word with vowels stripped. "circle" -> "crcl".
const devowel = (s) =>
  String(s).toLowerCase().replace(/[^a-z]/g, "").replace(/[aeiou]/g, "");

// Password-style twist: each puzzle bans the obvious name(s) of what it draws,
// so players have to describe it sideways. Two passes:
//   1. Normal spelling, inflection-tolerant, whole-word — "dot" catches "dots"
//      and "ringed" but stays inside word boundaries, so "star" won't trip
//      "start" or "starfish".
//   2. Devoweled disguise — players abbreviate ("blk crcl" for "black circle"),
//      which slips past pass 1. We compare consonant skeletons, but only against
//      tokens the player actually stripped of vowels (none left). That guard is
//      what keeps normal words safe: "data" and "range" keep their vowels, so
//      they never collide with "dot" ("dt") or "ring" ("rng").
// Returns the banned base word that was used, or null if the prompt is clean.
function bannedWordHit(prompt, banned) {
  if (!Array.isArray(banned) || !banned.length) return null;
  const text = prompt.toLowerCase();
  const tokens = text.split(/[^a-z]+/).filter(Boolean);
  for (const word of banned) {
    const base = String(word).toLowerCase().replace(/[^a-z]/g, "");
    if (!base) continue;
    const re = new RegExp(`\\b${base}(?:s|es|ed|ing|er|ers|y|ies)?\\b`, "i");
    if (re.test(text)) return word;
    const skel = devowel(base);
    if (skel.length >= 2 && tokens.some((t) => !/[aeiou]/.test(t) && t === skel))
      return word;
  }
  return null;
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
  // Skip the LLM for a name this player already holds — it was vetted when set
  // (or generated from the approved word list), so re-checking it on every
  // score submit is wasted cost.
  const alreadyMine = nickClaims[nickname.toLowerCase()] === playerId;
  if (!alreadyMine) {
    const mod = await moderateNickname(nickname);
    if (!mod.allowed)
      return { ok: false, error: "that nickname isn't allowed — pick another" };
  }
  if (!claimNickname(nickname, playerId))
    return { ok: false, error: "that nickname's taken — pick another" };
  return { ok: true };
}

// --- Starter nicknames: random approved adjective + noun. The word lists are
// curated clean, so generated names skip the LLM (only uniqueness is checked).
const NICK_ADJ = [
  "swift", "brave", "calm", "bold", "jolly", "keen", "lucky", "mellow", "nimble",
  "plucky", "quirky", "snappy", "sunny", "witty", "zesty", "breezy", "cosmic",
  "fuzzy", "giddy", "peppy", "spry", "merry", "clever", "dapper", "gentle",
  "noble", "rapid", "sleek", "vivid", "wild",
];
const NICK_NOUN = [
  "otter", "koala", "panda", "finch", "gecko", "heron", "lynx", "narwhal",
  "falcon", "badger", "comet", "pixel", "pebble", "maple", "cactus", "mango",
  "walnut", "pretzel", "noodle", "waffle", "puffin", "marmot", "willow",
  "ember", "meadow", "cobalt", "quartz", "robin", "tiger", "raven",
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Generate a unique starter name and claim it for the player. Tries adj-noun,
// then adds a number to break ties, so it always returns something available.
function suggestNickname(playerId) {
  for (let i = 0; i < 30; i++) {
    const name = `${pick(NICK_ADJ)}-${pick(NICK_NOUN)}`;
    if (!nickClaims[name.toLowerCase()] && claimNickname(name, playerId)) return name;
  }
  for (let i = 0; i < 100; i++) {
    const name = `${pick(NICK_ADJ)}-${pick(NICK_NOUN)}${Math.floor(Math.random() * 100)}`;
    if (!nickClaims[name.toLowerCase()] && claimNickname(name, playerId)) return name;
  }
  return `player-${Math.floor(Math.random() * 1e6)}`;
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

app.post("/api/generate", ...generateLimits, async (req, res) => {
  const prompt = (req.body?.prompt || "").trim();
  const date = String(req.body?.date || todayStr());
  const playerId = String(req.body?.playerId || "");
  const puzzle = puzzleForDate(date);
  if (!puzzle) return res.status(400).json({ error: "no puzzle for that day" });
  const target = targetPixels.get(puzzle.id);
  if (!prompt) return res.status(400).json({ error: "empty prompt" });
  if (prompt.length > 600)
    return res.status(400).json({ error: "prompt too long (max 600 chars)" });
  if (!GEMINI_API_KEY)
    return res.status(503).json({ error: "engine offline: GEMINI_API_KEY not set" });

  // Banned-word gate runs before the LLM moderation pass — it's a cheap local
  // check and there's no reason to spend a render on a prompt that breaks the
  // password rule. Names the offending word so the player can rephrase.
  const banHit = bannedWordHit(prompt, puzzle.banned);
  if (banHit)
    return res.status(400).json({
      error: `can't use "${banHit}" on this one — describe it another way`,
      bannedWord: banHit,
    });

  if (denylisted(prompt))
    return res
      .status(400)
      .json({ error: "that prompt isn't allowed, try describing the picture" });

  // Safety moderation only. The LLM naming judge used to run here too, catching
  // synonyms/disguises the regex misses, but it hard-blocked words that weren't
  // on the visible "Can't say" list — invisible false positives that cost the
  // player their shot (e.g. "round" on the circle puzzle). Pulled it: the local
  // bannedWordHit gate above (visible list + skeleton match for crcl/sircull) is
  // the whole twist now, and if a word isn't on the row, it works.
  const moderation = await moderatePrompt(prompt);
  if (!moderation.allowed)
    return res
      .status(400)
      .json({ error: "that prompt isn't allowed, try describing the picture" });

  const eligible = date === todayStr(); // only today's day feeds the leaderboard

  // Per-player shot cap on today's puzzle (date-gated: 3 from BEST_OF_3_DATE, 1
  // before). Distinct prompts only: a repeat of a prompt you already fired
  // returns the cached painting and doesn't cost a shot.
  const cap = shotsAllowed(date);
  const key = cacheKey(puzzle.id, prompt);
  const used = eligible && playerId ? shotsFor(playerId, date) : null;
  const isRepeat = used ? used.has(key) : false;
  if (used && !isRepeat && used.size >= cap)
    return res.status(429).json({
      error: cap === 1
        ? "you've already played today's puzzle"
        : `you've used all ${cap} shots for today's puzzle`,
      shotsLeft: 0,
    });

  // Mint a one-time token bound to this server-measured score + day, so the
  // board submission can't lie about the number or backdoor a past day.
  const reply = (svg, score, cached) => {
    const chars = prompt.length;
    const now = Date.now();
    // Record the play before we answer. Fire-and-forget so the append never
    // adds latency to the render round-trip; logPlay swallows its own errors.
    logPlay({
      at: new Date(now).toISOString(),
      date,
      puzzleId: puzzle.id,
      target: puzzle.name, // what they were trying to draw — the training label
      playerId,
      prompt,
      chars,
      score,
      cached,
      svg,
    });
    const token = randomUUID();
    sweepScoreTokens(now);
    scoreTokens.set(token, { date, score, chars, exp: now + SCORE_TOKEN_TTL_MS });
    const shotsLeft = used ? Math.max(0, cap - used.size) : null;
    return res.json({ svg, score, chars, token, eligible, shotsLeft });
  };

  const hit = resultCache.get(key);
  if (hit) {
    if (used && !isRepeat) used.add(key); // a new (if already-cached) shot still counts
    return reply(hit.svg, hit.score, true); // cache hit is free, no budget spent
  }

  // Past this point we pay Gemini. Stop here if the global daily ceiling is spent.
  if (!globalRenderBudgetOk())
    return res.status(503).json({ error: "the engine's resting — too many paintings today. try again tomorrow" });

  try {
    genDayCount++; // count the paid attempt before the call, so errors still spend
    if (used && !isRepeat) used.add(key); // burn the shot up front — a fired shot is fired
    const svg = await generateSvg(prompt);
    const score = Math.round(scoreMatch(target, rasterize(svg)) * 10) / 10;
    resultCache.set(key, { svg, score });
    reply(svg, score, false);
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.startsWith("BLOCKED:"))
      return res
        .status(400)
        .json({ error: "that prompt isn't allowed, try describing the picture" });
    res.status(502).json({ error: msg });
  }
});

// A starter nickname for new players: unique, approved, claimed for this player.
app.get("/api/nickname/suggest", writeLimit, (req, res) => {
  const playerId = String(req.query.playerId || "");
  if (!playerId) return res.status(400).json({ error: "playerId required" });
  res.json({ nickname: suggestNickname(playerId) });
});

// Read a day's two boards. ?me=<playerId> flags the caller's own rows.
app.get("/api/leaderboard/:date", (req, res) => {
  res.json(boardsFor(req.params.date, String(req.query.me || "")));
});

// Showcase: the top 3 accuracy finishers for a LOCKED (past) day, each shown
// with the prompt they typed and the painting the engine drew. Built by joining
// the trusted board (server-minted scores) to that player's best play in the
// append-only log — so the picture and words come from plays.jsonl, the number
// from the leaderboard. Today is withheld: surfacing live winners would hand out
// working prompts for the puzzle still in play.
async function bestPlaysByPlayer(date) {
  const best = new Map(); // playerId -> { prompt, svg, score, chars }
  if (!existsSync(PLAYS_PATH)) return best;
  let raw;
  try {
    raw = await readFile(PLAYS_PATH, "utf8");
  } catch {
    return best;
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let p;
    try {
      p = JSON.parse(line);
    } catch {
      continue; // skip a torn line rather than fail the whole request
    }
    if (p.date !== date || !p.playerId) continue;
    const cur = best.get(p.playerId);
    // Match the board's tiebreak: higher score wins, then fewer chars.
    if (!cur || p.score > cur.score || (p.score === cur.score && p.chars < cur.chars))
      best.set(p.playerId, { prompt: p.prompt, svg: p.svg, score: p.score, chars: p.chars });
  }
  return best;
}

app.get("/api/showcase/:date", async (req, res) => {
  const date = req.params.date;
  if (date === todayStr()) return res.json({ live: true, winners: [] });
  const rows = (leaderboard[date] || [])
    .slice()
    .sort((a, b) => b.score - a.score || a.chars - b.chars || a.at - b.at)
    .slice(0, 3);
  if (!rows.length) return res.json({ live: false, winners: [] });
  const plays = await bestPlaysByPlayer(date);
  const winners = rows.map((r) => {
    const play = plays.get(r.playerId);
    return {
      nickname: r.nickname,
      score: r.score,
      chars: r.chars,
      // null when this day predates capture — render the row, just no picture.
      prompt: play?.prompt ?? null,
      svg: play?.svg ?? null,
    };
  });
  res.json({ live: false, winners });
});

// Redeem a score token into a leaderboard row, keyed by playerId. The player
// paints up to three shots and chooses one to submit; this is that one shot's
// token. Both boards read off the single row. Only today's day is eligible;
// past-day tokens are rejected so practice can't reach the board.
app.post("/api/leaderboard/submit", writeLimit, async (req, res) => {
  const token = String(req.body?.token || "");
  const nickname = cleanNickname(req.body?.nickname);
  const playerId = String(req.body?.playerId || "");
  if (!playerId) return res.status(400).json({ error: "playerId required" });
  const scored = scoreTokens.get(token);
  if (!scored) return res.status(400).json({ error: "invalid or used token" });
  if (Date.now() > scored.exp) {
    scoreTokens.delete(token);
    return res.status(400).json({ error: "that score expired — play it again to submit" });
  }
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
app.post("/api/player/rename", writeLimit, async (req, res) => {
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
// Constant-time token check so a wrong guess leaks nothing through timing.
// Length-prefixed compare avoids timingSafeEqual throwing on mismatched sizes.
function adminTokenOk(supplied, expected) {
  const a = Buffer.from(String(supplied || ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.post("/api/admin/remove", adminLimit, (req, res) => {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return res.status(503).json({ error: "admin disabled: ADMIN_TOKEN not set" });
  if (!adminTokenOk(req.get("x-admin-token"), token))
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
