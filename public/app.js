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

// --- One-shot gate, keyed by day (date) ---
const saveKey = (date) => `dp:v2:${date}`;
const getAttempt = (date) => {
  try {
    return JSON.parse(localStorage.getItem(saveKey(date)) || "null");
  } catch {
    return null;
  }
};
const saveAttempt = (date, a) =>
  localStorage.setItem(saveKey(date), JSON.stringify(a));

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

function setLocked(locked, note) {
  $("prompt").disabled = locked;
  $("paint").disabled = locked;
  $("paint").textContent = locked ? "Played" : "Paint it";
  if (locked && note) $("prompt").placeholder = note;
}

function starCount(score) {
  return score >= 95 ? 5 : score >= 90 ? 4 : score >= 80 ? 3 : score >= 65 ? 2 : score >= 50 ? 1 : 0;
}

function starsFor(score) {
  return score >= 95 ? "🟩🟩🟩🟩🟩"
    : score >= 90 ? "🟩🟩🟩🟩⬜"
    : score >= 80 ? "🟩🟩🟩⬜⬜"
    : score >= 65 ? "🟩🟩⬜⬜⬜"
    : score >= 50 ? "🟩⬜⬜⬜⬜"
    : "⬜⬜⬜⬜⬜";
}

let lastResult = null; // for the share card

async function showResult(svg, score, chars, name) {
  $("resultPh").style.display = "none";
  resultCanvas.style.display = "block";
  await drawSvg(rctx, svg);
  $("resultTag").textContent = `${chars} chars`;
  const p = score.toFixed(1);
  lastResult = { score, chars, name };
  const filled = starCount(score);
  const squares = Array.from({ length: 5 }, (_, i) => `<i class="${i < filled ? "on" : ""}"></i>`).join("");
  $("result").innerHTML = `
    <div class="score">
      <span class="big" id="scoreNum">0.0%</span>
      <span class="meta">match · <b>${chars}</b> chars</span>
      <span class="squares">${squares}</span>
    </div>
    <div class="share">Wordshot — ${name}\n${starsFor(score)}  ${p}%  ·  ${chars} chars</div>
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
  x.fillText(`${when} · ${lastResult.name}`, pad, 128);

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
  const filled = starCount(lastResult.score);
  const sq = 38, gap = 10, sy = top + 224;
  for (let i = 0; i < 5; i++) {
    x.fillStyle = i < filled ? "#2fa56a" : "#e7e2d5";
    roundRect(x, rx + i * (sq + gap), sy, sq, sq, 7); x.fill();
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

async function loadDay(date) {
  current = days.find((d) => d.date === date) || days[0];
  const { name, today } = current;
  $("lbPuzzle").textContent = `· ${today ? "Today" : current.date} · ${name}`;

  // Past days are view-only: the board still shows that day's results, but a
  // late play is scored without being added.
  $("practiceTag").style.display = today ? "none" : "inline-block";
  $("practiceNote").style.display = today ? "none" : "block";
  renderCountdown();
  loadLeaderboard(current.date);

  const svg = await (await fetch(`/api/target/${current.puzzleId}`)).text();
  await drawSvg(tctx, svg);

  renderBanned(current.banned);
  $("bannedWarn").style.display = "none";

  const prior = getAttempt(current.date);
  if (prior) {
    $("prompt").value = prior.prompt;
    $("chars").textContent = prior.chars;
    setLocked(true, "You've already played this one.");
    await showResult(prior.svg, prior.score, prior.chars, name);
  } else {
    $("prompt").value = "";
    $("prompt").placeholder = "e.g. a red circle in the middle on white";
    $("chars").textContent = "0";
    setLocked(false);
    resultCanvas.style.display = "none";
    $("resultPh").style.display = "flex";
    $("resultTag").textContent = "";
    $("result").innerHTML = "";
  }
}

async function paint() {
  if (!current || getAttempt(current.date)) return;
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
      body: JSON.stringify({ prompt, date: current.date }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `error ${res.status}`);

    saveAttempt(current.date, {
      prompt,
      svg: data.svg,
      score: data.score,
      chars: data.chars,
    });
    setLocked(true, "You've already played this one.");
    await showResult(data.svg, data.score, data.chars, current.name);
    announce(`Scored ${data.score.toFixed(1)} percent match using ${data.chars} characters.`);

    // Only today's day is eligible; submit the token to claim a board row.
    if (data.eligible && data.token) {
      const r = await fetch("/api/leaderboard/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: data.token,
          nickname: getNick(),
          playerId: getPlayerId(),
        }),
      });
      if (r.ok) applyBoards(await r.json());
    }
  } catch (e) {
    $("result").innerHTML = `<span class="err">${e.message}</span>`;
    announce(`Something went wrong: ${e.message}`);
    btn.disabled = false;
  }
}

function dayLabel(d) {
  if (d.today) return `Today · ${d.name}`;
  return `${d.date} · ${d.name}`;
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
