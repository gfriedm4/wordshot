const $ = (id) => document.getElementById(id);
const SIZE = 512;

const targetCanvas = $("targetCanvas");
const resultCanvas = $("resultCanvas");
const tctx = targetCanvas.getContext("2d");
const rctx = resultCanvas.getContext("2d");

let days = []; // [{date, puzzleId, name, day, today}]
let current = null; // the selected day object

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

function showNickModal() {
  $("nickInput").value = getNick();
  $("nickModal").classList.add("show");
  $("nickInput").focus();
}
async function saveNickFromModal() {
  const n = $("nickInput").value.trim().slice(0, 20);
  if (!n) return;
  const prev = getNick();
  setNick(n);
  $("whoName").textContent = n;
  $("nickModal").classList.remove("show");
  if (prev && prev !== n) {
    try {
      await fetch("/api/player/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId: getPlayerId(), nickname: n }),
      });
    } catch {
      /* non-fatal */
    }
  }
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
    <div class="share">Daily Puzzle — ${name}\n${starsFor(score)}  ${p}%  ·  ${chars} chars</div>
    <button id="shareBtn">Share image</button>`;
  $("shareBtn").addEventListener("click", shareCard);
  countUp($("scoreNum"), score);
}

// Animate the score number from 0 to its value for a little reveal.
function countUp(el, target) {
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
  x.fillText("Daily Puzzle", pad + 62, 68);
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
        await navigator.share({ files: [file], title: "Daily Puzzle" });
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
  loadLeaderboard(current.date);

  const svg = await (await fetch(`/api/target/${current.puzzleId}`)).text();
  await drawSvg(tctx, svg);

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
  const btn = $("paint");
  btn.disabled = true;
  $("result").innerHTML = `<span class="spinner"></span> painting…`;
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
    btn.disabled = false;
  }
}

function dayLabel(d) {
  if (d.today) return `Today · ${d.name}`;
  return `${d.date} · ${d.name}`;
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
  ta.addEventListener("input", () => ($("chars").textContent = ta.value.trim().length));
  $("paint").addEventListener("click", paint);
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") paint();
  });

  $("whoName").textContent = getNick() || "guest";
  $("changeNick").addEventListener("click", (e) => {
    e.preventDefault();
    showNickModal();
  });
  $("nickSave").addEventListener("click", saveNickFromModal);
  $("nickInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveNickFromModal();
  });

  if (days.length) await loadDay(days[0].date); // today first
  if (!getNick()) showNickModal();
}

init();
