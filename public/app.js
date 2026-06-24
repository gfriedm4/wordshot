const $ = (id) => document.getElementById(id);
const SIZE = 512;

const targetCanvas = $("targetCanvas");
const resultCanvas = $("resultCanvas");
const tctx = targetCanvas.getContext("2d");
const rctx = resultCanvas.getContext("2d");

let days = []; // [{date, puzzleId, name, banned, day, today}]
let current = null; // the selected day object

// Mirror of the server's banned-word matcher so we can warn the player before
// they spend their one shot. The server stays the source of truth; this is UX.
// Pass 1 is normal spelling; pass 2 catches devoweled abbreviations ("crcl")
// without tripping normal vowel-bearing words. Keep in sync with server.js.
const devowel = (s) =>
  String(s).toLowerCase().replace(/[^a-z]/g, "").replace(/[aeiou]/g, "");

function bannedWordHit(prompt, banned) {
  if (!Array.isArray(banned) || !banned.length) return null;
  const text = (prompt || "").toLowerCase();
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

// Re-run on every keystroke: update the char count, and if the prompt uses a
// banned word, surface which one and lock the Paint button so the shot isn't
// wasted on a guaranteed rejection.
function refreshPrompt() {
  const ta = $("prompt");
  const val = ta.value.trim();
  $("chars").textContent = val.length;
  if (!current || ta.disabled) return;
  const hit = bannedWordHit(val, current.banned);
  $("bannedWarn").style.display = hit ? "inline" : "none";
  $("bannedWarn").textContent = hit ? `“${hit}” is off-limits here` : "";
  $("paint").disabled = !!hit;
}

function renderBanned(banned) {
  const row = $("bannedRow");
  if (!banned || !banned.length) {
    row.style.display = "none";
    return;
  }
  row.style.display = "flex";
  $("bannedWords").innerHTML = banned
    .map((w) => `<span class="word">${String(w).replace(/[<>&]/g, "")}</span>`)
    .join("");
}

// --- Identity: stable playerId (the real key) + display nickname ---
const PID_KEY = "dp:pid";
const NICK_KEY = "dp:nick";
function getPlayerId() {
  let id = localStorage.getItem(PID_KEY);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
    localStorage.setItem(PID_KEY, id);
  }
  return id;
}
const getNick = () => localStorage.getItem(NICK_KEY) || "";
const setNick = (n) => localStorage.setItem(NICK_KEY, n);

// --- Nickname modal: open/close with focus management ---
let lastFocused = null;

// Keep Tab inside the dialog and let Escape cancel it. Attached only while open.
function onModalKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeNickModal();
    return;
  }
  if (e.key !== "Tab") return;
  const focusables = Array.from(
    $("nickModal").querySelectorAll("input, button")
  ).filter((el) => !el.disabled);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function showNickModal() {
  lastFocused = document.activeElement;
  $("nickInput").value = getNick();
  $("nickErr").style.display = "none";
  // Take the rest of the page out of the tab order and the a11y tree.
  const wrap = document.querySelector(".wrap");
  if (wrap) {
    wrap.setAttribute("inert", "");
    wrap.setAttribute("aria-hidden", "true");
  }
  $("nickModal").classList.add("show");
  $("nickModal").addEventListener("keydown", onModalKeydown);
  $("nickInput").focus();
}

function closeNickModal() {
  $("nickModal").classList.remove("show");
  $("nickModal").removeEventListener("keydown", onModalKeydown);
  const wrap = document.querySelector(".wrap");
  if (wrap) {
    wrap.removeAttribute("inert");
    wrap.removeAttribute("aria-hidden");
  }
  if (lastFocused && lastFocused.focus) lastFocused.focus();
  lastFocused = null;
}
async function saveNickFromModal() {
  const n = $("nickInput").value.trim().slice(0, 20);
  const err = $("nickErr");
  err.style.display = "none";
  if (!n) return;
  // Validate against the server (also relabels any existing rows). This is the
  // single source of truth for what's allowed, so first-timers and renames both
  // get checked here.
  try {
    const r = await fetch("/api/player/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: getPlayerId(), nickname: n }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      err.textContent = d.error || "that nickname isn't allowed — pick another";
      err.style.display = "block";
      return; // keep the modal open
    }
  } catch {
    /* network hiccup — let them through; submit will re-check */
  }
  setNick(n);
  $("whoName").textContent = n;
  closeNickModal();
  if (current) loadLeaderboard(current.date);
}

// --- Best-of-3 state, keyed by day (date) ---
// A day's saved record: { shots: Shot[], locked, pickIdx }, where a Shot is
// { prompt, svg, score, chars, token, eligible }. pickIdx is the one shot the
// player chose to submit.
const SHOTS_MAX = 3;
let FLOOR = 80; // brevity match floor, synced from the leaderboard payload
let dayShots = []; // shots painted for the current day
let dayLocked = false; // submitted/finalized for the current day
let pickIdx = null; // chosen shot index to submit

const saveKey = (date) => `dp:v3:${date}`;
const legacyKey = (date) => `dp:v2:${date}`;
function getAttempt(date) {
  try {
    const v3 = JSON.parse(localStorage.getItem(saveKey(date)) || "null");
    if (v3 && Array.isArray(v3.shots)) return v3;
  } catch {
    /* fall through to legacy */
  }
  // Migrate a pre-best-of-3 single play so an earlier shot today isn't lost.
  try {
    const v2 = JSON.parse(localStorage.getItem(legacyKey(date)) || "null");
    if (v2 && v2.svg) {
      return {
        shots: [{ prompt: v2.prompt, svg: v2.svg, score: v2.score, chars: v2.chars, token: null, eligible: false }],
        locked: true,
        pickIdx: 0,
      };
    }
  } catch {
    /* no usable prior */
  }
  return null;
}
const saveAttempt = (date, a) =>
  localStorage.setItem(saveKey(date), JSON.stringify(a));
function persistDay() {
  if (!current) return;
  saveAttempt(current.date, { shots: dayShots, locked: dayLocked, pickIdx });
}

// The shot pre-selected for the player: highest score, ties to fewer chars.
// They can change it before locking.
function defaultPick(shots) {
  if (!shots.length) return null;
  let best = 0;
  for (let i = 1; i < shots.length; i++) {
    const s = shots[i], b = shots[best];
    if (s.score > b.score || (s.score === b.score && s.chars < b.chars)) best = i;
  }
  return best;
}

function drawSvg(ctx, svg) {
  return new Promise((resolve, reject) => {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, SIZE, SIZE);
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, SIZE, SIZE);
      resolve();
    };
    img.onerror = () => reject(new Error("couldn't render that SVG"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

// Paint button text + disabled state + the shots-left pips.
function updateShotControls() {
  const btn = $("paint");
  const pips = $("shotPips");
  if (pips) {
    pips.innerHTML = Array.from({ length: SHOTS_MAX }, (_, i) =>
      `<span class="pip${i < dayShots.length ? " spent" : ""}"></span>`).join("");
  }
  if (dayLocked) {
    $("prompt").disabled = true;
    btn.disabled = true;
    btn.textContent = "Locked in";
    return;
  }
  if (dayShots.length >= SHOTS_MAX) {
    $("prompt").disabled = true;
    btn.disabled = true;
    btn.textContent = "All 3 shots used";
    return;
  }
  $("prompt").disabled = false;
  btn.disabled = false;
  btn.textContent = `Paint shot ${dayShots.length + 1} of ${SHOTS_MAX}`;
  refreshPrompt(); // re-evaluate the banned-word lock on the live prompt
}

// Choose which shot to submit. No-op once locked.
function selectShot(i) {
  if (dayLocked || i < 0 || i >= dayShots.length) return;
  pickIdx = i;
  persistDay();
  renderShots();
  renderSubmitPanel();
}

// The shots tray: one selectable card/row per painted shot. The chosen shot is
// highlighted; after locking, only the submitted shot keeps the mark.
function renderShots() {
  const tray = $("shotsTray");
  if (!dayShots.length) { tray.hidden = true; return; }
  tray.hidden = false;
  const hint = $("shotsHint");
  if (hint) hint.textContent = dayLocked ? "" : (dayShots.length > 1 ? "tap the one to submit" : "");
  const list = $("shotList");
  list.innerHTML = "";
  const selectable = current && current.today && !dayLocked;
  dayShots.forEach((shot, i) => {
    const chosen = i === pickIdx;
    const el = document.createElement(selectable ? "label" : "div");
    el.className = "shot" + (chosen ? " selected" : "") + (selectable ? " selectable" : "");

    if (selectable) {
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "pickShot";
      radio.className = "shot-radio";
      radio.value = String(i);
      radio.checked = chosen;
      radio.addEventListener("change", () => selectShot(i));
      el.appendChild(radio);
    }

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const cv = document.createElement("canvas");
    cv.width = SIZE; cv.height = SIZE;
    cv.setAttribute("role", "img");
    cv.setAttribute("aria-label", `Shot ${i + 1}: ${shot.score.toFixed(1)} percent match, ${shot.chars} characters`);
    thumb.appendChild(cv);

    const tag = dayLocked && chosen ? `<span class="shot-pick on">✓ submitted</span>`
      : (!dayLocked && chosen ? `<span class="shot-pick on">✓ submitting this</span>` : "");
    const body = document.createElement("div");
    body.className = "shot-body";
    body.innerHTML =
      `<div class="shot-top"><span class="shot-n">Shot ${i + 1}</span>${tag}</div>` +
      `<div class="shot-prompt"></div>` +
      `<div class="shot-nums">` +
        `<span class="acc"><b>${shot.score.toFixed(0)}%</b> <span class="lbl">match</span></span>` +
        `<span class="brev"><b>${shot.chars}</b> <span class="lbl">chars</span></span>` +
      `</div>`;
    body.querySelector(".shot-prompt").textContent = `“${shot.prompt}”`;

    el.appendChild(thumb);
    el.appendChild(body);
    list.appendChild(el);
    drawSvg(cv.getContext("2d"), shot.svg).catch(() => {});
  });
}

// The submit button. Today only (past days can't reach the board).
function renderSubmitPanel() {
  const panel = $("submitPanel");
  if (!current || !current.today || !dayShots.length) { panel.hidden = true; return; }
  panel.hidden = false;
  const btn = $("lockBtn");
  btn.classList.toggle("done", dayLocked);
  if (dayLocked) {
    btn.disabled = true;
    btn.textContent = "Locked in ✓";
  } else if (pickIdx == null) {
    btn.disabled = true;
    btn.textContent = "Pick a shot to submit";
  } else {
    btn.disabled = false;
    btn.textContent = `Submit Shot ${pickIdx + 1}`;
  }
}

// Submit the chosen shot.
async function lockIn() {
  if (!current || !current.today || dayLocked || pickIdx == null) return;
  const shot = dayShots[pickIdx];
  const btn = $("lockBtn");
  // Token expired after an hour idle — lock locally so the UI doesn't stall.
  if (!shot || !shot.eligible || !shot.token) {
    dayLocked = true; persistDay(); renderShots(); renderSubmitPanel(); updateShotControls();
    return;
  }
  btn.disabled = true; btn.textContent = "Submitting…";
  try {
    const r = await fetch("/api/leaderboard/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: shot.token, nickname: getNick(), playerId: getPlayerId() }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `error ${r.status}`);
    dayLocked = true;
    persistDay();
    applyBoards(data);
    renderShots();
    renderSubmitPanel();
    updateShotControls();
    announce("Submitted. Your score is on the board.");
  } catch (e) {
    btn.disabled = false; btn.textContent = `Submit Shot ${pickIdx + 1}`;
    const note = $("submitPanel").querySelector(".panel-note");
    if (note) note.textContent = e.message;
    announce(`Couldn't submit: ${e.message}`);
  }
}

// Score bars in half-square units (0–10). Linear: pct/10 is a score out of 10,
// each half-box worth one point, rounded to the nearest half. 92% -> 9 -> 4.5 boxes,
// 95% -> 10 -> 5.0 boxes.
function scoreHalves(score) {
  return Math.max(0, Math.min(10, Math.round(score / 10)));
}

let lastResult = null; // for the share card

// Draw a shot onto the "Your painting" board and show its score line + share.
async function showShot(shot) {
  const { svg, score, chars } = shot;
  $("resultPh").style.display = "none";
  resultCanvas.style.display = "block";
  await drawSvg(rctx, svg);
  $("resultTag").textContent = `${chars} chars`;
  lastResult = { score, chars, name: current?.name };
  const halves = scoreHalves(score);
  const squares = Array.from({ length: 5 }, (_, i) => {
    const cls = halves >= (i + 1) * 2 ? "fill on" : halves >= i * 2 + 1 ? "fill half" : "";
    return `<i class="${cls}"></i>`;
  }).join("");
  $("result").innerHTML = `
    <div class="score">
      <span class="big" id="scoreNum">0.0%</span>
      <span class="meta">match · <b>${chars}</b> chars</span>
      <span class="squares" role="img" aria-label="${(halves / 2).toFixed(1)} out of 5">${squares}</span>
    </div>
    <button id="shareBtn">Share image</button>`;
  $("shareBtn").addEventListener("click", shareCard);
  countUp($("scoreNum"), score);
}

const prefersReducedMotion = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Announce a short, clean line to screen readers via the polite live region.
// Kept separate from #result so the per-frame count-up animation never spams AT.
function announce(msg) {
  const el = $("srStatus");
  if (el) el.textContent = msg;
}

// Animate the score number from 0 to its value for a little reveal.
function countUp(el, target) {
  if (prefersReducedMotion()) {
    el.textContent = `${target.toFixed(1)}%`;
    return;
  }
  const dur = 650, start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = `${(target * eased).toFixed(1)}%`;
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Compose a result card (target + painting + score) and either invoke the native
// share sheet or download it. Drawn from the two canvases already on screen.
function buildShareCard() {
  const W = 1200, H = 630, S = 300, pad = 60, top = 188;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d");
  x.fillStyle = "#fbf9f4"; x.fillRect(0, 0, W, H); // warm paper
  x.fillStyle = "#e8e4d8"; x.fillRect(0, H - 8, W, 8); // baseline strip

  // Logo mark: black square, vermilion dot
  roundRect(x, pad, 34, 46, 46, 12); x.fillStyle = "#1b1a17"; x.fill();
  x.fillStyle = "#ff5436"; x.beginPath(); x.arc(pad + 23, 57, 9, 0, 7); x.fill();

  x.fillStyle = "#1b1a17"; x.font = "700 40px 'Space Grotesk', system-ui, sans-serif";
  x.fillText("Wordshot", pad + 62, 68);
  const when = current?.today ? "Today" : current?.date || "";
  x.fillStyle = "#8c8678"; x.font = "24px Inter, system-ui, sans-serif";
  x.fillText(when, pad, 128);

  const panel = (cv, px, label) => {
    x.fillStyle = "#8c8678"; x.font = "600 18px Inter, system-ui, sans-serif";
    x.fillText(label.toUpperCase(), px, top - 14);
    x.fillStyle = "#fff"; roundRect(x, px, top, S, S, 16); x.fill();
    x.save(); roundRect(x, px, top, S, S, 16); x.clip();
    x.drawImage(cv, px, top, S, S); x.restore();
    x.strokeStyle = "#e7e2d5"; x.lineWidth = 2; roundRect(x, px, top, S, S, 16); x.stroke();
  };
  panel(targetCanvas, pad, "Target");
  panel(resultCanvas, pad + S + 36, "Your painting");

  const rx = pad + 2 * S + 36 + 52;
  x.fillStyle = "#1b1a17"; x.font = "700 100px 'Space Grotesk', system-ui, sans-serif";
  x.fillText(`${lastResult.score.toFixed(1)}%`, rx, top + 94);
  x.fillStyle = "#8c8678"; x.font = "28px Inter, system-ui, sans-serif";
  x.fillText("match", rx, top + 134);
  x.fillStyle = "#1b1a17"; x.font = "600 32px 'Space Grotesk', system-ui, sans-serif";
  x.fillText(`${lastResult.chars} chars`, rx, top + 194);
  // Draw the 5 score squares directly (no emoji font dependency on the card).
  // Half-filled boxes get a left-half green fill clipped to the rounded corners.
  const halves = scoreHalves(lastResult.score);
  const sq = 38, gap = 10, sy = top + 224;
  for (let i = 0; i < 5; i++) {
    const bx = rx + i * (sq + gap);
    x.fillStyle = "#e7e2d5"; roundRect(x, bx, sy, sq, sq, 7); x.fill();
    const full = halves >= (i + 1) * 2;
    const half = !full && halves >= i * 2 + 1;
    if (full || half) {
      x.save();
      roundRect(x, bx, sy, sq, sq, 7); x.clip();
      x.fillStyle = "#2fa56a";
      x.fillRect(bx, sy, half ? sq / 2 : sq, sq);
      x.restore();
    }
  }
  x.fillStyle = "#8c8678"; x.font = "24px Inter, system-ui, sans-serif";
  x.fillText(`as ${getNick() || "guest"}`, rx, top + 310);

  return c;
}

function roundRect(x, rx, ry, w, h, r) {
  x.beginPath();
  x.moveTo(rx + r, ry);
  x.arcTo(rx + w, ry, rx + w, ry + h, r);
  x.arcTo(rx + w, ry + h, rx, ry + h, r);
  x.arcTo(rx, ry + h, rx, ry, r);
  x.arcTo(rx, ry, rx + w, ry, r);
  x.closePath();
}

async function shareCard() {
  if (!lastResult) return;
  const c = buildShareCard();
  c.toBlob(async (blob) => {
    if (!blob) return;
    const file = new File([blob], "daily-puzzle.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Wordshot" });
        return;
      } catch {
        /* fell through to download */
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "daily-puzzle.png";
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}

function renderBoard(elId, rows, emptyMsg) {
  const list = $(elId);
  if (!rows || !rows.length) {
    list.innerHTML = `<li class="lb-empty">${emptyMsg}</li>`;
    return;
  }
  list.innerHTML = rows
    .map((r, i) => {
      const nick = r.nickname.replace(/[<>&]/g, "");
      const cls = [r.mine ? "me" : "", i < 3 ? `rank-${i + 1}` : ""].filter(Boolean).join(" ");
      return `<li class="${cls}">
        <span class="rank">${i + 1}</span>
        <span class="nick">${nick}</span>
        <span class="pct">${r.score.toFixed(1)}%</span>
        <span class="ch">${r.chars} ch</span>
      </li>`;
    })
    .join("");
}

function applyBoards(data) {
  if (data && typeof data.floor === "number") FLOOR = data.floor;
  $("lbFloor").textContent = `· ≥${data.floor}% to qualify`;
  renderBoard("lbAccuracy", data.accuracy, "No scores yet. Be first.");
  renderBoard("lbBrevity", data.brevity, "No qualifying scores yet.");
}

async function loadLeaderboard(date) {
  try {
    const data = await (
      await fetch(`/api/leaderboard/${date}?me=${encodeURIComponent(getPlayerId())}`)
    ).json();
    applyBoards(data);
  } catch {
    /* leave whatever's there */
  }
}

// Winning shots for a locked day: top 3 paintings + the prompts behind them.
// Hidden on today (would leak live answers) and on days with no winners.
async function loadShowcase(date, isToday) {
  const section = $("showcase");
  if (isToday) {
    section.style.display = "none";
    return;
  }
  let data;
  try {
    data = await (await fetch(`/api/showcase/${date}`)).json();
  } catch {
    section.style.display = "none";
    return;
  }
  const winners = (data && data.winners) || [];
  if (!winners.length) {
    section.style.display = "none";
    return;
  }
  $("showcaseDay").textContent = `· ${date}`;
  const grid = $("showcaseGrid");
  grid.innerHTML = "";
  winners.forEach((w, i) => {
    const card = document.createElement("div");
    card.className = `showcase-card rank-${i + 1}`;

    const frame = document.createElement("div");
    frame.className = "showcase-frame";
    if (w.svg) {
      const cv = document.createElement("canvas");
      cv.width = SIZE;
      cv.height = SIZE;
      cv.className = "showcase-canvas";
      cv.setAttribute("role", "img");
      cv.setAttribute("aria-label", `${w.nickname}'s painting, ${w.score.toFixed(1)}% match`);
      frame.appendChild(cv);
      drawSvg(cv.getContext("2d"), w.svg).catch(() => {});
    } else {
      const ph = document.createElement("div");
      ph.className = "showcase-ph";
      ph.textContent = "no image saved for this day";
      frame.appendChild(ph);
    }
    card.appendChild(frame);

    const meta = document.createElement("div");
    meta.className = "showcase-meta";
    meta.innerHTML =
      `<span class="rank">${i + 1}</span>` +
      `<span class="nick"></span>` +
      `<span class="pct">${w.score.toFixed(1)}%</span>` +
      `<span class="ch">${w.chars} ch</span>`;
    meta.querySelector(".nick").textContent = w.nickname;
    card.appendChild(meta);

    const quote = document.createElement("p");
    quote.className = "showcase-prompt";
    quote.textContent = w.prompt ? `“${w.prompt}”` : "(prompt not recorded)";
    card.appendChild(quote);

    grid.appendChild(card);
  });
  section.style.display = "block";
}

async function loadDay(date) {
  current = days.find((d) => d.date === date) || days[0];
  const { name, today } = current;
  $("lbPuzzle").textContent = `· ${today ? "Today" : current.date}`;

  // Past days are view-only: the board still shows that day's results, but a
  // late play is scored without being added.
  $("practiceTag").style.display = today ? "none" : "inline-block";
  $("practiceNote").style.display = today ? "none" : "block";
  renderCountdown();
  loadLeaderboard(current.date);
  loadShowcase(current.date, today);

  const svg = await (await fetch(`/api/target/${current.puzzleId}`)).text();
  await drawSvg(tctx, svg);

  renderBanned(current.banned);
  $("bannedWarn").style.display = "none";

  // Restore any saved shots for this day.
  const prior = getAttempt(current.date);
  dayShots = prior && prior.shots ? prior.shots.slice() : [];
  dayLocked = !!(prior && prior.locked);
  pickIdx = prior && prior.pickIdx != null ? prior.pickIdx : defaultPick(dayShots);
  // Guard against a stale index from an older save.
  if (pickIdx != null && pickIdx >= dayShots.length) pickIdx = defaultPick(dayShots);

  $("prompt").value = "";
  $("prompt").placeholder = "e.g. a red circle in the middle on white";
  $("chars").textContent = "0";

  if (dayShots.length) {
    await showShot(dayShots[dayShots.length - 1]); // show the latest painting
  } else {
    resultCanvas.style.display = "none";
    $("resultPh").style.display = "flex";
    $("resultTag").textContent = "";
    $("result").innerHTML = "";
  }
  renderShots();
  renderSubmitPanel();
  updateShotControls();
}

async function paint() {
  if (!current || dayLocked || dayShots.length >= SHOTS_MAX) return;
  if (!getNick()) return showNickModal();
  const prompt = $("prompt").value.trim();
  if (!prompt) return;
  const banned = bannedWordHit(prompt, current.banned);
  if (banned) {
    $("bannedWarn").style.display = "inline";
    $("bannedWarn").textContent = `“${banned}” is off-limits here`;
    return;
  }
  const btn = $("paint");
  btn.disabled = true;
  $("result").innerHTML = `<span class="spinner"></span> painting…`;
  announce("Painting your description…");
  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, date: current.date, playerId: getPlayerId() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `error ${res.status}`);

    const shot = {
      prompt,
      svg: data.svg,
      score: data.score,
      chars: data.chars,
      token: data.token || null,
      eligible: !!data.eligible,
    };
    dayShots.push(shot);
    // Pre-select the best shot so far; the player can change it before locking.
    pickIdx = defaultPick(dayShots);
    persistDay();

    await showShot(shot);
    renderShots();
    renderSubmitPanel();
    announce(`Shot ${dayShots.length}: scored ${data.score.toFixed(1)} percent using ${data.chars} characters.`);
  } catch (e) {
    $("result").innerHTML = `<span class="err">${e.message}</span>`;
    announce(`Something went wrong: ${e.message}`);
  } finally {
    updateShotControls();
  }
}

function dayLabel(d) {
  if (d.today) return "Today";
  return d.date;
}

// Puzzles reset at midnight US Eastern (server keys "today" to America/New_York).
// Show a live countdown so the rollover isn't a surprise. Only on today's puzzle.
let countdownTimer = null;
// Read the current wall clock in ET via Intl (DST-aware, matches the server's
// boundary exactly), then return ms until the next ET midnight.
const etTimeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
function msToNextEtMidnight() {
  const now = new Date();
  const parts = etTimeFmt.formatToParts(now);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  let h = get("hour");
  if (h === 24) h = 0; // some engines render midnight as "24"
  const secsIntoDay = h * 3600 + get("minute") * 60 + get("second");
  return (86400 - secsIntoDay) * 1000 - now.getMilliseconds();
}
function renderCountdown() {
  const el = $("countdown");
  if (!el) return;
  if (!current?.today) {
    el.style.display = "none";
    return;
  }
  let ms = msToNextEtMidnight();
  if (ms <= 0) {
    // Rolled over while the tab was open — pull the new day's puzzle.
    el.textContent = "New puzzle now…";
    init();
    return;
  }
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n) => String(n).padStart(2, "0");
  el.style.display = "inline-block";
  el.textContent = `Next puzzle in ${pad(h)}:${pad(m)}:${pad(s)} (midnight ET)`;
}
function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  renderCountdown();
  countdownTimer = setInterval(renderCountdown, 1000);
}

async function init() {
  getPlayerId();
  const data = await (await fetch("/api/days")).json();
  days = data.days || [];
  const sel = $("day");
  sel.innerHTML = days
    .map((d) => `<option value="${d.date}">${dayLabel(d)}</option>`)
    .join("");
  sel.addEventListener("change", () => loadDay(sel.value));

  const ta = $("prompt");
  ta.addEventListener("input", refreshPrompt);
  $("paint").addEventListener("click", paint);
  $("lockBtn").addEventListener("click", lockIn);
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") paint();
  });

  $("changeNick").addEventListener("click", (e) => {
    e.preventDefault();
    showNickModal();
  });
  $("nickSave").addEventListener("click", saveNickFromModal);
  $("nickInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveNickFromModal();
  });

  // New players get an auto-assigned starter name (no forced modal). They can
  // change it anytime via the header link.
  if (!getNick()) {
    try {
      const r = await fetch(`/api/nickname/suggest?playerId=${encodeURIComponent(getPlayerId())}`);
      if (r.ok) setNick((await r.json()).nickname);
    } catch {
      /* offline — leave unnamed, the modal still works via "change" */
    }
  }
  $("whoName").textContent = getNick() || "guest";

  if (days.length) await loadDay(days[0].date); // today first
  startCountdown();
}

init();
