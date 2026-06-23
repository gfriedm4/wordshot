# Wordshot

(repo is `daily-puzzle`; the game is named **Wordshot**.)

A one-shot prompt-to-picture game. You're shown a simple target picture (a red
circle, a star on purple, three overlapping RGB circles). You describe it in
words, an LLM paints what you said as a flat SVG, and you're scored on how
closely the result matches the target. One shot per attempt, and the game is
saying the most with the fewest words, like CSS Battle but with language instead
of code.

## Why LLM-to-SVG and not image generation

We bake-tested diffusion models (Imagen 4 Fast, Flux 1.1 Pro, Flux Schnell,
Gemini Flash Image) against flat geometric targets. They all lose to the same
problem: an aesthetic prior. They add lighting, shadows, "art direction," and
worse, they're non-deterministic, so the same prompt scores differently run to
run, which is poison for a competition. Routing the prompt through an LLM that
emits SVG gives flat, exact shapes and removes model randomness from the score
(temperature 0). The only variation left is the player's wording, which is
exactly the variable the game is about.

## Run it

```bash
npm install
cp .env.example .env   # then paste your Gemini key into .env
npm start              # http://localhost:3000
```

The server reads `.env` from the project root on startup, so pasting the key
into `.env` is all you need. Get a `GEMINI_API_KEY` at
https://aistudio.google.com/apikey (free tier works fine). Without it the
engine returns 503 and the rest of the UI still loads.

## How it works

- `server.js` — Express. Serves the static frontend and exposes the hidden
  engine at `POST /api/generate`. The engine prompt forces flat, shape-only,
  fence-free SVG and the response is sanitized (no scripts, images, or external
  refs) before it reaches the browser.
- `public/` — the play loop: target on the left, your painting on the right, a
  prompt box, and a pixel-diff score. Both SVGs are rasterized to a 512×512
  canvas over white and compared per pixel.
- `puzzles/puzzles.json` — the targets. The browser only ever gets the rendered
  image, never the source shapes.

## Scoring

Scoring happens on the server. Both the target and your painting are rasterized
to a 256×256 square over white (via `@resvg/resvg-js`) and compared pixel for
pixel; match % is the average per-pixel color closeness (100 = identical). The
target pixels never leave the server, so the score can't be forged from the
browser. Character count is shown alongside — the design intent is to rank by
match first, prompt length as the tiebreaker, so a shorter prompt at the same
accuracy wins.

Because the engine is deterministic, results are cached by `hash(puzzle, prompt)`:
the same prompt on the same puzzle is scored once and served from cache after,
so we never pay the model twice for it.

## One shot

You get a single attempt per puzzle. The gate is `localStorage` (the Wordle
model): once you submit, your attempt is saved and the input locks, and it stays
locked across reloads. It's clearable in devtools, so honest players get one try
and that's the level of enforcement an anonymous game can honestly claim.

## Nickname + leaderboards

There's no login. You pick a nickname and it labels your rows. Identity is a
stable `playerId` (a random id kept in `localStorage`); the nickname is just a
display label on top of it. That split is what lets a rename work: change your
name and `/api/player/rename` relabels all of your existing rows, because they're
keyed by `playerId`, not by the name.

Two boards per puzzle, top 10 each:

- *Best match* — ranked by match %, character count as the tiebreaker.
- *Shortest prompt* — ranked by fewest characters, but only counting attempts
  that cleared an accuracy floor (`BREVITY_FLOOR`, currently 80%). Without the
  floor, "fewest characters" is won by whoever types one junk character, so the
  board has to mean "shortest prompt that still got the picture right."

The score is trustworthy even without auth. The client never sends a score: when
`/api/generate` measures your painting it issues a one-time token bound to that
server-computed score, and `/api/leaderboard/submit` exchanges
`{token, nickname, playerId}` for a row. So you can pick any nickname, but the
number beside it is one the server measured, and the token can't be replayed or
forged. Best score per player per puzzle wins; resubmitting only improves your
own row. Boards persist to `data/leaderboard.json` (gitignored).

This is casual-grade integrity, right for the stakes. The nickname is claimable
(two people can both be "greg" — they're separate rows by `playerId`), and the
`playerId` is a bearer token in localStorage, so clearing storage loses your
rows. Both are things real accounts would fix once there's something worth
protecting.

## Daily rotation

There's one puzzle per day. Puzzles cycle by day from a fixed epoch (`EPOCH` in
`server.js`), so "today" advances on its own and the six seed puzzles are
backdated as the most recent past days. The day picker lists today plus the
archive, newest first.

You can play any past day for practice, and a past day still shows its
leaderboard (how that day finished). What a late play can't do is get *added* to
it. That rule is enforced server-side, not just hidden in the UI: the score token
is bound to the day it was played, and `/api/leaderboard/submit` rejects any
token whose day isn't today. So a past day still scores, shows your result, and
offers the share card, but the historical board stays read-only.

Boards are keyed by *date*, not by puzzle, because the same puzzle recurs every
six days as the cycle wraps; keying by date keeps each day's competition its own.
The one-shot gate is per day too.

The bank currently holds 30 puzzles, so the cycle runs about a month before it
repeats. Add more to `puzzles/puzzles.json` (flat shapes only — circle, rect,
ellipse, polygon, solid fills) and the rotation lengthens automatically. Append,
don't reorder: day indexing counts from the epoch, so inserting in the middle
would shift which puzzle a past day maps to.

## Sharing

After you play, "Share image" builds a result card (target vs your painting,
score, character count, your nickname) on a canvas. On devices that support the
Web Share API with files it opens the native share sheet; everywhere else it
downloads a PNG. The score squares are drawn directly, not emoji, so the card
renders the same on any system.

## Status

v0 prototype: single-shot with server-side scoring, a localStorage one-shot gate,
nickname chooser, two per-day leaderboards (accuracy + brevity), daily rotation
with a playable past-day archive (30-puzzle bank), and a shareable result card.
Next obvious step: real accounts if/when the leaderboard gets competitive enough
to need them.
