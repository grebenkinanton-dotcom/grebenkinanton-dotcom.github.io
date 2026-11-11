// Speech engine: Kokoro-82M running fully on-device (WebAssembly).
import { KokoroTTS } from "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
let ttsPromise = null;
let activeJob = 0;

function load() {
  if (!ttsPromise) {
    const files = new Map();
    ttsPromise = KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: "q8",
      device: "wasm",
      progress_callback: (p) => {
        if (p.status === "progress" && p.total) {
          files.set(p.file, { loaded: p.loaded, total: p.total });
          let loaded = 0, total = 0;
          for (const f of files.values()) { loaded += f.loaded; total += f.total; }
          postMessage({ type: "loading", loaded, total });
        }
      },
    }).then((tts) => { postMessage({ type: "ready" }); return tts; })
      .catch((err) => { ttsPromise = null; throw err; });
  }
  return ttsPromise;
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "load") {
    try { await load(); } catch (err) { postMessage({ type: "error", message: String(err?.message || err) }); }
    return;
  }
  if (msg.type === "cancel") { activeJob = 0; return; }
  if (msg.type === "generate") {
    const { id, chunks, voice, speed } = msg;
    activeJob = id;
    try {
      const tts = await load();
      for (let i = 0; i < chunks.length; i++) {
        if (activeJob !== id) return;
        const out = await tts.generate(chunks[i], { voice, speed });
        if (activeJob !== id) return;
        const samples = new Float32Array(out.audio);
        postMessage({ type: "chunk", id, index: i, total: chunks.length, samples, rate: out.sampling_rate }, [samples.buffer]);
      }
      postMessage({ type: "done", id });
    } catch (err) {
      postMessage({ type: "error", id, message: String(err?.message || err) });
    }
  }
};
