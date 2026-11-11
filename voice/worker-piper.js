// Fast speech engine: Piper (VITS) voices running on-device with ONNX Runtime (WebAssembly).
import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/esm/ort.wasm.min.js";
import { createPiperPhonemize } from "https://cdn.jsdelivr.net/npm/@diffusionstudio/vits-web@1.0.3/dist/piper-DeOu3H9E.js";

const VOICES_BASE = "https://huggingface.co/diffusionstudio/piper-voices/resolve/main";
const PHONEMIZE_BASE = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize";
const MODEL_CACHE = "read-aloud-voices-v1";

ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/";
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)) : 1;

const sessions = new Map();   // voiceId -> Promise<{session, config}>
let phonemizer = null;
let activeJob = 0;

function voicePath(id) {
  // en_US-lessac-medium -> en/en_US/lessac/medium/en_US-lessac-medium.onnx
  const [locale, name, quality] = id.split("-");
  return `${locale.split("_")[0]}/${locale}/${name}/${quality}/${id}.onnx`;
}

async function cachedFetch(url, onProgress) {
  let cache = null;
  try { cache = await caches.open(MODEL_CACHE); } catch {}
  const hit = cache && (await cache.match(url));
  if (hit) return hit.arrayBuffer();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get("Content-Length")) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  const blob = new Blob(parts);
  try { await cache?.put(url, new Response(blob)); } catch {}
  return blob.arrayBuffer();
}

function loadVoice(id) {
  if (!sessions.has(id)) {
    const p = (async () => {
      const base = `${VOICES_BASE}/${voicePath(id)}`;
      const config = JSON.parse(new TextDecoder().decode(await cachedFetch(`${base}.json`)));
      const model = await cachedFetch(base, (loaded, total) => postMessage({ type: "loading", loaded, total }));
      const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
      return { session, config };
    })();
    p.catch(() => sessions.delete(id));
    sessions.set(id, p);
  }
  return sessions.get(id);
}

function getPhonemizer() {
  if (!phonemizer) {
    const state = { lines: [] };
    phonemizer = createPiperPhonemize({
      print: (line) => { try { state.lines.push(JSON.parse(line).phoneme_ids); } catch {} },
      printErr: () => {},
      locateFile: (f) => (f.endsWith(".wasm") ? `${PHONEMIZE_BASE}.wasm` : f.endsWith(".data") ? `${PHONEMIZE_BASE}.data` : f),
    }).then((mod) => ({ mod, state }));
    phonemizer.catch(() => { phonemizer = null; });
  }
  return phonemizer;
}

async function phonemize(text, espeakVoice) {
  const { mod, state } = await getPhonemizer();
  state.lines = [];
  mod.callMain(["-l", espeakVoice, "--input", JSON.stringify([{ text }]), "--espeak_data", "/espeak-ng-data"]);
  return state.lines.filter((ids) => ids && ids.length);
}

async function synthesize(text, voice, speed) {
  const [{ session, config }] = await Promise.all([loadVoice(voice), getPhonemizer()]);
  const sentences = await phonemize(text, config.espeak.voice);
  const inf = config.inference || {};
  const out = [];
  for (const ids of sentences) {
    const feeds = {
      input: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
      input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor("float32", Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / speed, inf.noise_w ?? 0.8]), [3]),
    };
    if (config.num_speakers > 1) feeds.sid = new ort.Tensor("int64", BigInt64Array.from([0n]), [1]);
    const result = await session.run(feeds);
    out.push(result.output.data);
  }
  const len = out.reduce((n, a) => n + a.length, 0);
  const samples = new Float32Array(len);
  let o = 0;
  for (const a of out) { samples.set(a, o); o += a.length; }
  return { samples, rate: config.audio.sample_rate };
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "load") {
    try { await Promise.all([loadVoice(msg.voice), getPhonemizer()]); postMessage({ type: "ready" }); }
    catch (err) { postMessage({ type: "error", message: String(err?.message || err) }); }
    return;
  }
  if (msg.type === "cancel") { activeJob = 0; return; }
  if (msg.type === "generate") {
    const { id, chunks, voice, speed } = msg;
    activeJob = id;
    try {
      await Promise.all([loadVoice(voice), getPhonemizer()]);
      postMessage({ type: "ready" });
      for (let i = 0; i < chunks.length; i++) {
        if (activeJob !== id) return;
        const { samples, rate } = await synthesize(chunks[i], voice, speed);
        if (activeJob !== id) return;
        postMessage({ type: "chunk", id, index: i, total: chunks.length, samples, rate }, [samples.buffer]);
      }
      postMessage({ type: "done", id });
    } catch (err) {
      postMessage({ type: "error", id, message: String(err?.message || err) });
    }
  }
};
