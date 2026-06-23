# daily-puzzle

A one-shot prompt-to-picture game. You're shown a simple target picture (a red
circle, a star on purple, three overlapping RGB circles). You describe it in
words, an LLM paints what you said as a flat SVG, and you're scored on how
closely the result matches the target. One shot per attempt — the game is
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

Match % is the average per-pixel color closeness between your painting and the
target (100 = identical). Character count is shown alongside — the design intent
is to rank by match first, prompt length as the tiebreaker, so a shorter prompt
at the same accuracy wins.

## Status

v0 prototype. Single-shot, six built-in puzzles, no daily rotation or
leaderboard yet. Next obvious steps: a real "puzzle of the day," server-side
scoring so scores can't be faked, and a shareable result card.
