// ============================================================
// 1) CONFIGURAÇÃO DO FIREBASE
// Crie um projeto em https://console.firebase.google.com,
// ative "Realtime Database" (modo teste para começar) e cole
// a config do seu projeto aqui:
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyA_SvpC_AOO8E_KNbfMsdTFrMdj7ZrnPLg",
  authDomain: "cmvp-810b9.firebaseapp.com",
  databaseURL: "https://cmvp-810b9-default-rtdb.firebaseio.com",
  projectId: "cmvp-810b9",
  storageBucket: "cmvp-810b9.firebasestorage.app",
  messagingSenderId: "492904974389",
  appId: "1:492904974389:web:d132efe4eb1c3bf489c97c"
};

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, set, update, push, remove, get, onValue, onDisconnect,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// id estável por navegador (sem precisar de login)
let myId = localStorage.getItem("mj_id");
if (!myId) { myId = Math.random().toString(36).slice(2, 10); localStorage.setItem("mj_id", myId); }
let myName = localStorage.getItem("mj_name") || ("Ouvinte-" + myId.slice(0, 4));

// offset entre relógio local e do servidor Firebase (pra sincronia real)
let serverOffset = 0;
onValue(ref(db, ".info/serverTimeOffset"), (snap) => { serverOffset = snap.val() || 0; });
function serverNow() { return Date.now() + serverOffset; }

const audio = document.getElementById("audio");
let roomCode = null, isHost = false, heartbeatTimer = null;
let currentPlaylist = {}, currentState = {};
let suppressSeek = false;
let loadedTrackId = null, localPlaying = false;
let currentTrackType = null;

// ---- Suporte a YouTube (player oficial via IFrame API — nunca extraímos o áudio bruto) ----
let ytPlayer = null, ytReady = false, pendingYtAction = null;
window.onYouTubeIframeAPIReady = function () {
  ytPlayer = new YT.Player("yt-player", {
    height: "100%", width: "100%",
    playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0 },
    events: {
      onReady: () => { ytReady = true; if (pendingYtAction) { pendingYtAction(); pendingYtAction = null; } },
      onStateChange: (e) => { if (e.data === YT.PlayerState.ENDED) handleTrackEnded(); }
    }
  });
};
function extractYouTubeId(url) {
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|music\.youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}
function ytCall(fn) { if (ytReady) fn(); else pendingYtAction = fn; }

// ---- Abstração de playback (esconde se é <audio> ou YouTube por trás) ----
function isYT() { return currentTrackType === "youtube"; }
function getCurrentTime() { return isYT() ? (ytReady ? ytPlayer.getCurrentTime() : 0) : audio.currentTime; }
function getDuration() { return isYT() ? (ytReady ? ytPlayer.getDuration() : 0) : audio.duration; }
function playMedia() { if (isYT()) ytCall(() => ytPlayer.playVideo()); else audio.play().catch(() => setRoomStatus("Clique em play para liberar o áudio.")); }
function pauseMedia() { if (isYT()) ytCall(() => ytPlayer.pauseVideo()); else audio.pause(); }
function seekMedia(t) { if (isYT()) ytCall(() => ytPlayer.seekTo(t, true)); else audio.currentTime = t; }

function loadTrack(track, startAt) {
  currentTrackType = track.type || "audio";
  if (currentTrackType === "youtube") {
    document.getElementById("art-icon").style.display = "none";
    document.getElementById("yt-wrap").style.display = "block";
    audio.pause(); audio.removeAttribute("src");
    ytCall(() => ytPlayer.loadVideoById({ videoId: track.videoId, startSeconds: startAt || 0 }));
  } else {
    document.getElementById("yt-wrap").style.display = "none";
    document.getElementById("art-icon").style.display = "flex";
    if (ytReady) ytPlayer.stopVideo();
    audio.src = track.url;
    audio.currentTime = startAt || 0;
  }
}

// só o host reage ao fim da faixa (ele é quem escreve o estado — evita várias pessoas escrevendo ao mesmo tempo)
function handleTrackEnded() {
  if (!isHost) return;
  if (currentState.loop) {
    seekMedia(0);
    playMedia();
    pushState({ position: 0, playing: true });
  } else {
    pauseMedia();
    pushState({ playing: false, position: getDuration() || currentState.position || 0 });
  }
}
audio.addEventListener("ended", handleTrackEnded);

function fmt(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return m + ":" + String(r).padStart(2, "0");
}
function genCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 5; i++) out += c[Math.floor(Math.random() * c.length)];
  return out;
}
function setHomeStatus(t) { document.getElementById("home-status").textContent = t; }
function setRoomStatus(t) { document.getElementById("room-status").textContent = t; }

// ============================================================
// Criar / entrar em sala
// ============================================================
async function createRoom() {
  const code = genCode();
  await set(ref(db, "rooms/" + code), {
    hostId: myId,
    state: { trackId: null, playing: false, position: 0, updatedAt: serverTimestamp() },
    playlist: {}
  });
  enterRoom(code, true);
}

async function joinRoom(code) {
  const snap = await get(ref(db, "rooms/" + code));
  if (!snap.exists()) { setHomeStatus("Sala não encontrada."); return; }
  enterRoom(code, snap.val().hostId === myId);
}

function enterRoom(code, host) {
  roomCode = code; isHost = host;
  document.getElementById("screen-home").style.display = "none";
  document.getElementById("screen-room").style.display = "block";
  document.getElementById("room-code-label").textContent =
    "SALA " + code + (isHost ? " · você é o host" : "");
  document.getElementById("host-panel").style.display = isHost ? "block" : "none";

  // presença
  const myPeerRef = ref(db, `rooms/${code}/peers/${myId}`);
  set(myPeerRef, { name: myName, ts: serverTimestamp() });
  onDisconnect(myPeerRef).remove();
  onValue(ref(db, `rooms/${code}/peers`), (snap) => renderPeers(snap.val() || {}, code));

  // playlist
  onValue(ref(db, `rooms/${code}/playlist`), (snap) => {
    currentPlaylist = snap.val() || {};
    renderPlaylist();
  });

  // estado (track ativa, play/pause, posição) — onValue = push via websocket, latência mínima
  onValue(ref(db, `rooms/${code}/state`), (snap) => {
    currentState = snap.val() || {};
    applyState();
  });

  // heartbeat do host: corrige deriva mesmo sem nenhuma ação manual
  if (isHost) {
    heartbeatTimer = setInterval(() => {
      if (localPlaying) pushState({ position: getCurrentTime(), playing: true });
    }, 3000);
  }
}

// ============================================================
// Renderização
// ============================================================
async function renderPeers(peersObj, code) {
  const snap = await get(ref(db, "rooms/" + code + "/hostId"));
  const hostId = snap.val();
  const wrap = document.getElementById("peers");
  wrap.innerHTML = "";
  Object.entries(peersObj).forEach(([id, p]) => {
    const div = document.createElement("div");
    div.className = "peer";
    div.innerHTML = `<span class="dot"></span><span>${p.name || "Participante"}${id === myId ? " (você)" : ""}</span>` +
      (id === hostId ? '<span class="host-tag">HOST</span>' : "");
    wrap.appendChild(div);
  });
}

function renderPlaylist() {
  const wrap = document.getElementById("playlist");
  wrap.innerHTML = "";
  Object.entries(currentPlaylist).forEach(([id, t]) => {
    const div = document.createElement("div");
    div.className = "track-item" + (currentState.trackId === id ? " active" : "");
    div.innerHTML = `<span class="name">${t.name || t.url}</span>` +
      (isHost ? '<span class="remove" data-id="' + id + '">✕</span>' : "");
    div.addEventListener("click", (e) => {
      if (e.target.classList.contains("remove")) {
        e.stopPropagation();
        remove(ref(db, `rooms/${roomCode}/playlist/${id}`));
        return;
      }
      if (isHost) playTrack(id);
    });
    wrap.appendChild(div);
  });
}

function applyState() {
  const track = currentState.trackId ? currentPlaylist[currentState.trackId] : null;
  document.getElementById("track-name").textContent = track ? (track.name || track.url) : "Nenhuma música tocando";

  if (currentState.trackId !== loadedTrackId) {
    loadedTrackId = currentState.trackId;
    if (track) loadTrack(track, currentState.position || 0);
  }

  if (!isHost && currentState.updatedAt && track) {
    const expected = currentState.playing
      ? currentState.position + (serverNow() - currentState.updatedAt) / 1000
      : currentState.position;
    if (Math.abs(getCurrentTime() - expected) > 0.8) seekMedia(expected);
  }

  if (currentState.playing && !localPlaying) { playMedia(); localPlaying = true; }
  if (!currentState.playing && localPlaying) { pauseMedia(); localPlaying = false; }

  document.getElementById("btn-play").textContent = currentState.playing ? "⏸" : "▶";
  document.getElementById("btn-loop").classList.toggle("active", !!currentState.loop);
  renderPlaylist();
}

function toggleLoop() {
  if (!isHost) { setRoomStatus("Só o host controla o loop."); return; }
  pushState({ loop: !currentState.loop });
}

// ============================================================
// Ações do host
// ============================================================
function pushState(patch) {
  update(ref(db, `rooms/${roomCode}/state`), Object.assign({ updatedAt: serverTimestamp() }, patch));
}

function playTrack(id) {
  // só empurra o estado — o listener de "state" (que roda pro host também) cuida de carregar e tocar
  pushState({ trackId: id, position: 0, playing: true });
}

function togglePlay() {
  if (!isHost) { setRoomStatus("Só o host controla a reprodução."); return; }
  pushState({ position: getCurrentTime(), playing: !currentState.playing });
}

async function fetchYouTubeTitle(url) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.title || null;
  } catch (e) { return null; }
}

async function addTrack() {
  const url = document.getElementById("input-track-url").value.trim();
  let name = document.getElementById("input-track-name").value.trim();
  if (!url) return;
  const videoId = extractYouTubeId(url);
  const btn = document.getElementById("btn-add-track");
  if (videoId && !name) {
    btn.textContent = "Buscando nome...";
    btn.disabled = true;
    name = (await fetchYouTubeTitle(url)) || "";
    btn.textContent = "+ Adicionar";
    btn.disabled = false;
  }
  const track = videoId ? { url, name, type: "youtube", videoId } : { url, name, type: "audio" };
  push(ref(db, `rooms/${roomCode}/playlist`), track);
  document.getElementById("input-track-url").value = "";
  document.getElementById("input-track-name").value = "";
}

function onSeekInput() { suppressSeek = true; }
function onSeekCommit(e) {
  suppressSeek = false;
  if (!isHost) return;
  const t = (e.target.value / 100) * (getDuration() || 0);
  seekMedia(t);
  pushState({ position: t, playing: currentState.playing });
}

function copyInvite() {
  const url = location.origin + location.pathname + "?room=" + roomCode;
  navigator.clipboard.writeText(url).then(() => setRoomStatus("Link copiado!"))
    .catch(() => setRoomStatus(url));
}

// ============================================================
// Eventos de UI
// ============================================================
document.getElementById("btn-create").onclick = createRoom;
document.getElementById("btn-join").onclick = () => {
  const v = document.getElementById("input-code").value.trim().toUpperCase();
  if (v) joinRoom(v); else setHomeStatus("Digite um código de sala.");
};
document.getElementById("btn-play").onclick = togglePlay;
document.getElementById("btn-loop").onclick = toggleLoop;
document.getElementById("btn-add-track").onclick = addTrack;
document.getElementById("btn-copy").onclick = copyInvite;
document.getElementById("seek").addEventListener("input", onSeekInput);
document.getElementById("seek").addEventListener("change", onSeekCommit);

// loop único de UI (necessário pro YouTube, que não emite "timeupdate" como o <audio>)
setInterval(() => {
  if (!roomCode) return;
  const cur = getCurrentTime() || 0, dur = getDuration() || 0;
  document.getElementById("time-cur").textContent = fmt(cur);
  document.getElementById("time-dur").textContent = fmt(dur);
  if (!suppressSeek) document.getElementById("seek").value = (cur / (dur || 1)) * 100;
}, 400);

const params = new URLSearchParams(location.search);
const pre = params.get("room");
if (pre) { document.getElementById("input-code").value = pre.toUpperCase(); joinRoom(pre.toUpperCase()); }
