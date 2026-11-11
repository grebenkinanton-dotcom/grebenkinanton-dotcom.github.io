const $ = (id) => document.getElementById(id);
const els = {
  text: $("text"), meta: $("text-meta"), paste: $("paste-btn"), clear: $("clear-btn"),
  voice: $("voice"), voiceMeta: $("voice-meta"), speed: $("speed"), speedOut: $("speed-out"),
  go: $("go-btn"), goLabel: $("go-label"),
  status: $("status"), statusText: $("status-text"), bar: $("bar-fill"), stop: $("stop-btn"),
  result: $("result"), player: $("player"), resultMeta: $("result-meta"),
  exportBtn: $("export-btn"), share: $("share-btn"),
};

const GAP_SECONDS = 0.12;   // short pause between sentences
const MAX_CHUNK = 240;      // characters per synthesis step

/* ---------- saved preferences ---------- */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
els.text.value = store.get("ra:text") || "";
const savedVoice = store.get("ra:voice");
if (savedVoice && [...els.voice.options].some((o) => o.value === savedVoice)) els.voice.value = savedVoice;
if (store.get("ra:speed")) els.speed.value = store.get("ra:speed");

function updateMeta() {
  const words = (els.text.value.match(/\S+/g) || []).length;
  const minutes = words / 150 / Number(els.speed.value);
  els.meta.textContent = words
    ? `${words.toLocaleString("en-US")} words · about ${formatDuration(minutes * 60)} of audio`
    : "0 words";
}
const engineOf = (v) => v.split(":")[0];
const voiceIdOf = (v) => v.split(":")[1];
const readyVoices = new Set();
function updateVoiceMeta() {
  const v = els.voice.value;
  els.voiceMeta.textContent = readyVoices.has(v)
    ? "Ready on this device."
    : engineOf(v) === "kokoro"
      ? "Most natural sound, but slow on most phones. One-time download: about 90 MB."
      : "Fast. One-time download the first time you use this voice: about 60 MB.";
}
function updateSpeed() { els.speedOut.textContent = `${Number(els.speed.value).toFixed(1)}×`; }

els.text.addEventListener("input", () => { store.set("ra:text", els.text.value); updateMeta(); });
els.voice.addEventListener("change", () => { store.set("ra:voice", els.voice.value); updateVoiceMeta(); });
els.speed.addEventListener("input", () => { store.set("ra:speed", els.speed.value); updateSpeed(); updateMeta(); });
updateSpeed(); updateMeta(); updateVoiceMeta();

els.paste.addEventListener("click", async () => {
  try {
    const clip = await navigator.clipboard.readText();
    if (clip) {
      els.text.value = clip;
      els.text.dispatchEvent(new Event("input"));
    }
  } catch {
    els.text.focus();
    showStatus("Press and hold in the text box, then choose Paste.");
  }
});
els.clear.addEventListener("click", () => {
  els.text.value = "";
  els.text.dispatchEvent(new Event("input"));
  els.text.focus();
});

/* ---------- text splitting ---------- */
function splitText(text) {
  const clean = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
  const sentences = clean.match(/[^.!?…\n]+(?:[.!?…]+["')\]]*|\n+|$)/g) || [];
  const pieces = [];
  for (let s of sentences) {
    s = s.trim();
    if (!s) continue;
    while (s.length > MAX_CHUNK) {
      let cut = Math.max(s.lastIndexOf(", ", MAX_CHUNK), s.lastIndexOf("; ", MAX_CHUNK), s.lastIndexOf(": ", MAX_CHUNK));
      if (cut < MAX_CHUNK / 3) cut = s.lastIndexOf(" ", MAX_CHUNK);
      if (cut < 1) cut = MAX_CHUNK;
      pieces.push(s.slice(0, cut + 1).trim());
      s = s.slice(cut + 1).trim();
    }
    if (s) pieces.push(s);
  }
  // Merge very short sentences so the voice flows naturally.
  const chunks = [];
  for (const p of pieces) {
    const last = chunks[chunks.length - 1];
    if (last && last.length + p.length + 1 <= MAX_CHUNK / 2) chunks[chunks.length - 1] = `${last} ${p}`;
    else chunks.push(p);
  }
  return chunks.filter((c) => /[\p{L}\p{N}]/u.test(c));
}

/* ---------- engine ---------- */
// Each engine runs in its own background thread.
const ENGINE_FILES = { piper: "worker-piper.js", kokoro: "worker.js" };
const workers = {};
function getWorker(engine) {
  if (!workers[engine]) {
    const w = new Worker(new URL(ENGINE_FILES[engine], import.meta.url), { type: "module" });
    w.onmessage = onWorkerMessage;
    w.onerror = (e) => { delete workers[engine]; fail(e.message || "The voice engine could not start."); };
    workers[engine] = w;
  }
  return workers[engine];
}

/* ---------- live playback while generating ---------- */
let ctx = null;
let liveSources = [];
let liveCursor = 0;
function startLive() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  if (!ctx) ctx = new AC();
  ctx.resume();
  stopLive();
}
function queueLive(samples, rate) {
  if (!ctx) return;
  const buf = ctx.createBuffer(1, samples.length, rate);
  buf.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const at = Math.max(ctx.currentTime + 0.05, liveCursor);
  src.start(at);
  liveCursor = at + buf.duration + GAP_SECONDS;
  liveSources.push(src);
  src.onended = () => { liveSources = liveSources.filter((s) => s !== src); };
}
function stopLive() {
  for (const s of liveSources) { try { s.stop(); } catch {} }
  liveSources = [];
  liveCursor = 0;
}
els.player.addEventListener("play", stopLive);

/* ---------- job state ---------- */
let job = null;   // { id, chunks, parts: [], rate, startedAt }
let jobCounter = 0;
let audioUrl = null;
let audioFile = null;

els.go.addEventListener("click", () => {
  if (job) return;
  const chunks = splitText(els.text.value);
  if (!chunks.length) {
    showStatus("Add some text first.", { error: true });
    els.text.focus();
    return;
  }
  // Pick a voice that matches the language of the text.
  const cyrillic = (els.text.value.match(/[Ѐ-ӿ]/g) || []).length;
  const latin = (els.text.value.match(/[A-Za-z]/g) || []).length;
  const russianVoice = els.voice.value.includes("ru_RU");
  if (cyrillic > latin !== russianVoice) {
    els.voice.value = russianVoice ? "piper:en_US-lessac-medium" : "piper:ru_RU-irina-medium";
    els.voice.dispatchEvent(new Event("change"));
    showStatus(`Your text looks ${russianVoice ? "English" : "Russian"}, so a matching voice is selected. Tap Create audio again.`);
    return;
  }
  startLive();
  els.player.pause();
  const voice = els.voice.value;
  job = { id: ++jobCounter, chunks, parts: [], rate: 24000, voice, engine: engineOf(voice) };
  setBusy(true);
  showStatus(readyVoices.has(voice) ? "Creating audio…" : "Loading voice…", { progress: 0, stoppable: true });
  getWorker(job.engine).postMessage({
    type: "generate", id: job.id, chunks,
    voice: voiceIdOf(voice), speed: Number(els.speed.value),
  });
});

els.stop.addEventListener("click", () => {
  if (!job) return;
  workers[job.engine]?.postMessage({ type: "cancel" });
  stopLive();
  const partial = job.parts.length ? job : null;
  job = null;
  setBusy(false);
  if (partial) { finish(partial, true); }
  else hideStatus();
});

function onWorkerMessage({ data: msg }) {
  if (msg.type === "loading") {
    if (!job) return;
    const mb = (n) => (n / 1048576).toFixed(0);
    showStatus(`Downloading voice (one time only): ${mb(msg.loaded)}${msg.total ? ` of ${mb(msg.total)}` : ""} MB`,
      { progress: msg.total ? msg.loaded / msg.total : 0, stoppable: true });
  } else if (msg.type === "ready") {
    if (job && !readyVoices.has(job.voice)) {
      readyVoices.add(job.voice);
      updateVoiceMeta();
      if (!job.parts.length) showStatus("Creating audio…", { progress: 0, stoppable: true });
    }
  } else if (msg.type === "chunk") {
    if (!job || msg.id !== job.id) return;
    job.parts[msg.index] = msg.samples;
    job.rate = msg.rate;
    queueLive(msg.samples, msg.rate);
    const done = msg.index + 1;
    showStatus(`Creating audio… ${done} of ${msg.total} — playing as it's ready`,
      { progress: done / msg.total, stoppable: true });
  } else if (msg.type === "done") {
    if (!job || msg.id !== job.id) return;
    const finished = job;
    job = null;
    setBusy(false);
    finish(finished, false);
  } else if (msg.type === "error") {
    if (msg.id && job && msg.id !== job.id) return;
    fail(msg.message);
  }
}

function fail(message) {
  console.error(message);
  job = null;
  setBusy(false);
  stopLive();
  showStatus("Something went wrong. Check your internet connection for the first download, then try again.", { error: true });
}

function finish(j, partial) {
  const parts = j.parts.filter(Boolean);
  const blob = encodeWav(parts, j.rate, GAP_SECONDS);
  const seconds = parts.reduce((n, p) => n + p.length, 0) / j.rate + GAP_SECONDS * (parts.length - 1);
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(blob);
  const name = fileName(els.text.value);
  audioFile = new File([blob], name, { type: "audio/wav" });
  els.player.src = audioUrl;
  els.resultMeta.textContent = `${formatDuration(seconds)} · ${(blob.size / 1048576).toFixed(1)} MB · WAV${partial ? " · stopped early" : ""}`;
  els.result.hidden = false;
  els.share.hidden = !(navigator.canShare && navigator.canShare({ files: [audioFile] }));
  if (partial) hideStatus();
  else showStatus("Done. Your audio is ready to play or export.", { progress: 1 });
  if (!liveSources.length) els.result.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

els.exportBtn.addEventListener("click", () => {
  if (!audioUrl) return;
  const a = document.createElement("a");
  a.href = audioUrl;
  a.download = audioFile.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

els.share.addEventListener("click", async () => {
  try { await navigator.share({ files: [audioFile], title: audioFile.name }); } catch {}
});

/* ---------- UI helpers ---------- */
function setBusy(busy) {
  els.go.disabled = busy;
  els.goLabel.textContent = busy ? "Working…" : "Create audio";
}
function showStatus(text, { progress = null, error = false, stoppable = false } = {}) {
  els.status.hidden = false;
  els.statusText.textContent = text;
  els.statusText.classList.toggle("error", error);
  els.bar.parentElement.hidden = progress === null;
  if (progress !== null) els.bar.style.width = `${Math.round(progress * 100)}%`;
  els.stop.hidden = !stoppable;
}
function hideStatus() { els.status.hidden = true; }

function formatDuration(sec) {
  sec = Math.max(1, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m} min ${s ? `${s} s` : ""}`.trim() : `${s} s`;
}
function fileName(text) {
  const slug = (text.match(/[A-Za-z0-9]+/g) || []).slice(0, 6).join("-").toLowerCase().slice(0, 48);
  return `${slug || "read-aloud"}.wav`;
}

/* ---------- WAV encoder (16-bit PCM, mono) ---------- */
function encodeWav(parts, rate, gapSec) {
  const gap = Math.round(gapSec * rate);
  const total = parts.reduce((n, p) => n + p.length, 0) + gap * Math.max(0, parts.length - 1);
  const buffer = new ArrayBuffer(44 + total * 2);
  const v = new DataView(buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + total * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, total * 2, true);
  let o = 44;
  parts.forEach((p, i) => {
    for (let k = 0; k < p.length; k++, o += 2) {
      const x = Math.max(-1, Math.min(1, p[k]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    if (i < parts.length - 1) o += gap * 2;
  });
  return new Blob([buffer], { type: "audio/wav" });
}

/* ---------- offline support + multi-core speed-up ---------- */
// The service worker adds headers that let the engine use several CPU cores.
// They only apply after a reload, so reload once when it first takes over.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then(() => {
    let tried = false;
    try { tried = sessionStorage.getItem("ra:reloaded") === "1"; } catch {}
    if (window.crossOriginIsolated || tried) return;
    const reload = () => {
      try { sessionStorage.setItem("ra:reloaded", "1"); } catch {}
      if (!job) location.reload();
    };
    if (navigator.serviceWorker.controller) reload();
    else navigator.serviceWorker.addEventListener("controllerchange", reload, { once: true });
  }).catch(() => {});
}
