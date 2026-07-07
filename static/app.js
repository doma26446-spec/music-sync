const params = new URLSearchParams(location.search);
const roomCode = params.get("room");
const $ = (id) => document.getElementById(id);

$("room").textContent = "комната: " + (roomCode || "—");
if (!roomCode) $("status").textContent = "Нет кода комнаты";

const audio = new Audio();
audio.preload = "auto";

let state = { tracks: [], playing: null, queue: [], started_at: 0, paused: false, paused_position: 0 };
let localPos = 0, syncTimer = null, localTrigger = false;

const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${roomCode}`);

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);

  if (msg.action === "state") {
    state = { ...state, ...msg };
    renderPlaylist();
    updatePlayBtn();
  } else if (msg.action === "play") {
    const isSame = state.playing?.id === msg.track.id;
    state.playing = msg.track;
    state.started_at = msg.startedAt;
    state.paused = false;

    if (isSame && localTrigger) {
      // Мы сами запросили трек — он уже загружен, подгоняем позицию
      localTrigger = false;
      const target = Date.now() / 1000 - msg.startedAt;
      if (target > 0 && (!audio.duration || target < audio.duration)) audio.currentTime = Math.max(0, target);
      audio.play().catch(() => {});
    } else if (!isSame) {
      // Другой трек — загружаем и стартуем по серверу
      schedulePlay(msg.track, msg.startedAt);
    } else {
      // Тот же трек (seek/resume от другого) — подгоняем
      const target = Date.now() / 1000 - msg.startedAt;
      if (target > 0 && (!audio.duration || target < audio.duration)) audio.currentTime = Math.max(0, target);
      audio.play().catch(() => {});
    }
    renderPlaylist();
    updatePlayBtn();
  } else if (msg.action === "pause") {
    state.paused = true;
    state.paused_position = msg.position;
    audio.pause();
    updatePlayBtn();
    $("status").textContent = "пауза";
  }
};

function send(a) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(a)); }

// --- Audio ---
let playTimer;

function schedulePlay(track, startedAt) {
  if (!track) return;
  stopSync();
  clearTimeout(playTimer);
  audio.src = track.url;
  audio.load();
  const now = Date.now() / 1000;
  const delay = (startedAt - now) * 1000;
  if (delay > 80) {
    $("status").textContent = delay.toFixed(0) + " мс…";
    playTimer = setTimeout(() => { audio.currentTime = 0; audio.play().catch(() => {}); startSync(); }, delay);
  } else {
    audio.currentTime = Math.max(0, now - startedAt);
    audio.play().catch(() => {});
    startSync();
  }
  $("now").textContent = track.name;
  $("status").textContent = "играет";
  updatePlayBtn();
}

function startSync() {
  stopSync();
  syncTimer = setInterval(() => {
    if (state.paused) localPos = state.paused_position;
    else if (state.playing) localPos = Date.now() / 1000 - state.started_at;
    if (localPos < 0) localPos = 0;
    updateSeek();
  }, 80);
}

function stopSync() { clearInterval(syncTimer); }
function updatePlayBtn() { $("playbtn").textContent = (state.playing && !state.paused && !audio.paused) ? "⏸" : "▶"; }

audio.onended = () => {
  stopSync();
  state.playing = null;
  $("status").textContent = "закончен";
  send({ action: "track_ended" });
};

// --- Pause/Resume ---
$("playbtn").onclick = () => {
  if (!state.playing) return;
  if (state.paused) {
    state.paused = false;
    const pos = state.paused_position || 0;
    state.started_at = Date.now() / 1000 - pos;
    audio.currentTime = pos;
    audio.play().catch(() => {});
    startSync();
    send({ action: "resume" });
    $("status").textContent = "играет";
  } else {
    state.paused = true;
    state.paused_position = Date.now() / 1000 - state.started_at;
    audio.pause();
    stopSync();
    send({ action: "pause" });
    $("status").textContent = "пауза";
  }
  updatePlayBtn();
};

// --- Seek ---
const seek = $("seek");
let seeking = false;

seek.addEventListener("input", () => {
  seeking = true;
  localPos = parseFloat(seek.value);
  $("current").textContent = fmtTime(localPos);
});

seek.addEventListener("change", () => {
  const pos = parseFloat(seek.value);
  seeking = false;
  audio.currentTime = pos;
  send({ action: "seek", position: pos });
});

function updateSeek() {
  if (seeking) return;
  const dur = audio.duration || 300;
  seek.max = dur;
  seek.value = Math.min(localPos, dur);
  $("current").textContent = fmtTime(localPos);
  $("duration").textContent = fmtTime(dur);
}

function fmtTime(s) {
  if (!s || s < 0) return "0:00";
  return Math.floor(s / 60) + ":" + ("0" + Math.floor(s % 60)).slice(-2);
}

// --- Playlist ---
function renderPlaylist() {
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
    btn.textContent = "▶";
    btn.className = "tr-play";
    btn.onclick = () => {
      if (t.id === state.playing?.id) { $("playbtn").click(); return; }
      // Загружаем трек сразу (для отзывчивости), ждём сервер для точного старта
      localTrigger = true;
      audio.src = t.url;
      audio.load();
      $("status").textContent = "загружаю…";
      state.playing = t;
      state.paused = false;
      state.paused_position = 0;
      state.started_at = 0;
      send({ action: "play_track", trackId: t.id });
      renderPlaylist();
    };
    li.appendChild(name);
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

$("demo").onclick = () => fetch(`/api/demo/${roomCode}`, { method: "POST" });
