const params = new URLSearchParams(location.search);
const roomCode = params.get("room");
const $ = (id) => document.getElementById(id);

$("room").textContent = "комната: " + (roomCode || "—");
if (!roomCode) $("status").textContent = "Нет кода комнаты";

const audio = new Audio();
audio.preload = "auto";

let state = { tracks: [], playing: null, queue: [], started_at: 0, paused: false, paused_position: 0 };
let localPos = 0;
let timer = null;

// --- WebSocket ---
const ws = new WebSocket( `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${roomCode}` );
let lastState = 0;

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  lastState = Date.now();

  // полное состояние — авторитетно, всегда применяем
  if (msg.action === "state" || msg.action === "fullstate") {
    applyState(msg);
    return;
  }

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
    updateUI();
    $("status").textContent = "пауза";
  }
};

function applyState(msg) {
  const prevTrackId = state.playing?.id;
  const prevStartedAt = state.started_at;
  state = { ...state, ...msg };
  if (msg.playing && msg.playing.id !== prevTrackId) {
    schedulePlay(msg.playing, msg.started_at);
  } else if (!msg.playing) {
    audio.pause(); $("now").textContent = "—"; $("status").textContent = "ожидание…";
  } else if (msg.paused !== audio.paused) {
    if (msg.paused) audio.pause(); else audio.play().catch(() => {});
  }
  if (msg.playing && msg.playing.id === prevTrackId && msg.started_at !== prevStartedAt) {
    const target = Date.now() / 1000 - msg.started_at;
    if (target > 0 && (!audio.duration || target < audio.duration)) audio.currentTime = Math.max(0, target);
  }
  renderAll();
}

function send(a) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(a)); }

// запрос состояния, если долго нет ответа
setInterval(() => {
  if (Date.now() - lastState > 4000) send({ action: "state" });
}, 3000);

// --- Playback ---
function schedulePlay(track, startedAt) {
  if (!track) return;
  clearTimeout(timer);
  audio.src = track.url;
  audio.load();
  $("now").textContent = track.name;
  $("status").textContent = "загружаю…";

  const doStart = () => {
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
    updateUI();
  };

  if (audio.readyState >= 3) doStart();
  else audio.oncanplaythrough = doStart;
}

audio.onended = () => {
  $("status").textContent = "закончен";
  send({ action: "track_ended" });
};

audio.onerror = () => { $("status").textContent = "ошибка трека"; };

// --- Seek slider ---
const seek = $("seek");
let seeking = false;

seek.addEventListener("input", () => { seeking = true; localPos = parseFloat(seek.value); $("current").textContent = fmtTime(localPos); });
seek.addEventListener("change", () => { seeking = false; audio.currentTime = parseFloat(seek.value); send({ action: "seek", position: parseFloat(seek.value) }); });

function updateSeek() {
  if (seeking) return;
  if (state.paused) localPos = state.paused_position;
  else if (state.playing) localPos = Date.now() / 1000 - state.started_at;
  if (localPos < 0) localPos = 0;
  const dur = audio.duration || 300;
  seek.max = dur;
  seek.value = Math.min(localPos, dur);
  $("current").textContent = fmtTime(localPos);
  $("duration").textContent = fmtTime(dur);
}

function fmtTime(s) { if (!s || s < 0) return "0:00"; return Math.floor(s / 60) + ":" + ("0" + Math.floor(s % 60)).slice(-2); }

setInterval(updateSeek, 100);

// --- Кнопки ---
function updateUI() {
  $("playbtn").textContent = (state.playing && !state.paused && !audio.paused) ? "⏸" : "▶";
}

$("playbtn").onclick = () => {
  if (!state.playing) return;
  if (state.paused) send({ action: "resume" });
  else send({ action: "pause" });
};

// --- Плейлист ---
function renderAll() {
  updateUI();
  const ul = $("plist");
  ul.innerHTML = "";
  $("trackcount").textContent = state.tracks.length;
  state.tracks.forEach((t) => {
    const li = document.createElement("li");
    li.className = t.id === state.playing?.id ? "active" : "";
    const name = document.createElement("span");
    name.textContent = t.name;
    name.className = "tr-name";
    const btn = document.createElement("button");
    btn.textContent = "▶"; btn.className = "tr-play";
    btn.onclick = () => {
      if (t.id === state.playing?.id) { $("playbtn").click(); return; }
      $("status").textContent = "загружаю…";
      send({ action: "play_track", trackId: t.id });
    };
    li.appendChild(name);
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

$("demo").onclick = () => fetch(`/api/demo/${roomCode}`, { method: "POST" });
