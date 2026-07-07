const params = new URLSearchParams(location.search);
const roomCode = params.get("room");
const $ = (id) => document.getElementById(id);

$("room").textContent = "комната: " + (roomCode || "—");
if (!roomCode) $("status").textContent = "Нет кода комнаты";

const audio = new Audio();
audio.preload = "auto";

let state = { tracks: [], playing: null, queue: [], started_at: 0, paused: false, paused_position: 0 };
let timer = null, localPos = 0;

// --- WebSocket ---
const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${roomCode}`);
let lastState = 0;

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  lastState = Date.now();

  if (msg.action === "play") {
    state.playing = msg.track;
    state.started_at = msg.startedAt;
    state.paused = false;
    schedulePlay(msg.track, msg.startedAt);
    renderAll();
    return;
  }

  if (msg.action === "pause") {
    state.paused = true;
    state.paused_position = msg.position;
    audio.pause();
    renderAll();
    $("status").textContent = "пауза";
    return;
  }

  if (msg.action === "state") {
    const prevId = state.playing?.id;
    state = { ...state, ...msg };
    if (msg.playing && msg.playing.id !== prevId) schedulePlay(msg.playing, msg.started_at);
    else if (!msg.playing) { audio.pause(); $("now").textContent = "—"; $("status").textContent = "ожидание…"; }
    renderAll();
  }
};

function send(a) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(a)); }
setInterval(() => { if (Date.now() - lastState > 4000) send({ action: "state" }); }, 3000);

// --- Playback ---
function schedulePlay(track, startedAt) {
  if (!track) return;
  clearTimeout(timer);
  audio.src = track.url;
  audio.load();
  $("now").textContent = track.name;
  $("status").textContent = "загружаю…";

  const play = () => {
    const now = Date.now() / 1000;
    const delay = (startedAt - now) * 1000;
    if (delay > 80) {
      $("status").textContent = delay.toFixed(0) + " мс…";
      timer = setTimeout(() => { audio.currentTime = 0; audio.play().catch(() => {}); $("status").textContent = "играет"; }, delay);
    } else {
      audio.currentTime = Math.max(0, now - startedAt);
      audio.play().catch(() => {});
      $("status").textContent = "играет";
    }
    renderAll();
  };

  if (audio.readyState >= 3) play();
  else audio.oncanplaythrough = play;
}

audio.onended = () => { $("status").textContent = "закончен"; send({ action: "track_ended" }); };
audio.onerror = () => { $("status").textContent = "ошибка трека"; };

// --- Seek slider ---
const seek = $("seek");
let seeking = false;

seek.addEventListener("input", () => { seeking = true; const v = parseFloat(seek.value); $("current").textContent = fmtTime(v); });
seek.addEventListener("change", () => {
  seeking = false;
  const pos = parseFloat(seek.value);
  audio.currentTime = pos;
  send({ action: "seek", position: pos });
});

setInterval(() => {
  if (seeking) return;
  const now = Date.now() / 1000;
  if (state.paused) localPos = state.paused_position;
  else if (state.playing) localPos = now - state.started_at;
  else localPos = 0;
  if (localPos < 0) localPos = 0;
  const dur = audio.duration || 300;
  seek.max = dur; seek.value = Math.min(localPos, dur);
  $("current").textContent = fmtTime(localPos);
  $("duration").textContent = fmtTime(dur);
}, 100);

function fmtTime(s) { if (!s || s < 0) return "0:00"; return Math.floor(s / 60) + ":" + ("0" + Math.floor(s % 60)).slice(-2); }

// --- Кнопки + Плейлист ---
function renderAll() {
  $("playbtn").textContent = (state.playing && !state.paused && !audio.paused) ? "⏸" : "▶";
  const ul = $("plist");
  ul.innerHTML = "";
  $("trackcount").textContent = state.tracks.length;
  state.tracks.forEach((t) => {
    const li = document.createElement("li");
    li.className = t.id === state.playing?.id ? "active" : "";
    const name = document.createElement("span"); name.textContent = t.name; name.className = "tr-name";
    const btn = document.createElement("button");
    btn.textContent = "▶"; btn.className = "tr-play";
    btn.onclick = () => {
      if (t.id === state.playing?.id) { $("playbtn").click(); return; }
      $("status").textContent = "загружаю…";
      send({ action: "play_track", trackId: t.id });
    };
    li.appendChild(name); li.appendChild(btn);
    ul.appendChild(li);
  });
}

$("playbtn").onclick = () => {
  if (!state.playing) return;
  send(state.paused ? { action: "resume" } : { action: "pause" });
};

$("demo").onclick = () => fetch(`/api/demo/${roomCode}`, { method: "POST" });
