// MP4 -> JPG frames, off the main thread.
// mp4box.js reads the MP4's sample table, WebCodecs decodes every frame
// (hardware accelerated), OffscreenCanvas encodes each one as JPG.
// Frames are posted to the page one by one; the page writes them to disk
// and acks, which keeps memory flat on long videos.
/* global MP4Box, DataStream */
importScripts("vendor/mp4box.all.min.js");

const MAX_IN_FLIGHT = 6;      // JPGs posted but not yet written by the page
const MAX_DECODE_QUEUE = 8;

let cancelled = false;
let inFlight = 0;
let waiters = [];

self.onmessage = (e) => {
  const m = e.data;
  const fail = (err) => post({ type: "error", message: String(err && err.message || err) });
  if (m.type === "start") run(m).catch(fail);
  else if (m.type === "probe") probe(m.file).catch(fail);
  else if (m.type === "ack") { inFlight--; poke(); }
  else if (m.type === "cancel") { cancelled = true; poke(); }
};

function post(msg, transfer) { self.postMessage(msg, transfer || []); }
function poke() { const w = waiters; waiters = []; w.forEach((r) => r()); }
function waitTick() { return new Promise((r) => { waiters.push(r); setTimeout(r, 20); }); }

// ---------------------------------------------------------------- parsing

async function readMovie(file) {
  const mp4 = MP4Box.createFile(false); // don't keep media data in memory
  let info = null, failed = null;
  mp4.onReady = (i) => { info = i; };
  mp4.onError = (e) => { failed = e; };
  const CHUNK = 4 * 1024 * 1024;
  let pos = 0;
  while (!info && !failed && pos < file.size) {
    const buf = await file.slice(pos, pos + CHUNK).arrayBuffer();
    buf.fileStart = pos;
    const next = mp4.appendBuffer(buf, pos + buf.byteLength >= file.size);
    pos = next && next > pos ? next : pos + buf.byteLength;
  }
  if (!info) mp4.flush();
  if (failed) throw new Error("Could not read the MP4: " + failed);
  if (!info) throw new Error("This file does not look like a playable MP4.");
  return { mp4, info };
}

function codecDescription(mp4, trackId) {
  const trak = mp4.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const s = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(s);
      return new Uint8Array(s.buffer, 8); // drop the box header
    }
  }
  return undefined;
}

// Untagged SD video is BT.601 by convention (what ffmpeg and <video> assume);
// WebCodecs would otherwise treat it as BT.709 and shift the colors.
function colorSpaceFor(mp4, trackId, height) {
  const trak = mp4.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const tagged = entry.colr || (entry.boxes || []).some((b) => b.type === "colr");
    if (tagged) return undefined;
  }
  if (height && height < 720) {
    return { primaries: "smpte170m", transfer: "smpte170m", matrix: "smpte170m", fullRange: false };
  }
  return undefined;
}

function rotationOf(track) {
  const m = track.matrix;
  if (!m) return 0;
  const deg = Math.round(Math.atan2(m[1], m[0]) * 180 / Math.PI);
  return ((deg % 360) + 360) % 360;
}

// ---------------------------------------------------------------- movie facts

const usOf = (s) => Math.round(1e6 * s.cts / s.timescale);

// Frame list in display order: times (seconds from the first frame) and the
// exact timestamps the decoder will report, so frame N means the same frame
// in the timeline, the preview and the conversion.
async function describe(file) {
  const { mp4, info } = await readMovie(file);
  const track = info.videoTracks && info.videoTracks[0];
  if (!track) throw new Error("No video track found in this file.");
  const samples = mp4.getTrackById(track.id).samples || [];
  const fps = track.nb_samples && track.duration && track.timescale
    ? track.nb_samples / (track.duration / track.timescale) : 0;
  const shown = samples.map((s) => s.cts).sort((a, b) => a - b);
  const ts = track.timescale || 1;
  const times = new Float64Array(shown.length);
  const ctsUs = new Float64Array(shown.length);
  shown.forEach((c, i) => { times[i] = (c - shown[0]) / ts; ctsUs[i] = Math.round(1e6 * c / ts); });
  const meta = {
    total: samples.length || track.nb_samples || 0,
    fps: Math.round(fps * 1000) / 1000,
    duration: track.duration && track.timescale ? track.duration / track.timescale : 0,
    width: track.video ? track.video.width : track.track_width,
    height: track.video ? track.video.height : track.track_height,
    codec: track.codec,
    rotation: rotationOf(track),
  };
  return { mp4, track, samples, meta, times, ctsUs };
}

async function probe(file) {
  const { meta, times, ctsUs } = await describe(file);
  post({ type: "meta", ...meta, times, ctsUs }, [times.buffer, ctsUs.buffer]);
}

// ---------------------------------------------------------------- main job

async function run({ file, quality, forceFallback, trimStart, trimEnd }) {
  const { mp4, track, samples, meta, ctsUs } = await describe(file);

  // Kept part, as frame indices in display order (inclusive).
  const n = ctsUs.length;
  const first = n ? Math.max(0, Math.min(n - 1, trimStart ?? 0)) : 0;
  const last = n ? Math.max(first, Math.min(n - 1, trimEnd ?? n - 1)) : 0;
  const inUs = n ? ctsUs[first] : 0, outUs = n ? ctsUs[last] : Infinity;
  const inRange = (us) => us >= inUs && us <= outUs;

  // Samples to feed (decode order): from a keyframe before the first needed
  // frame up to the last frame needed. One extra keyframe back covers
  // open-GOP leading pictures.
  let minIdx = samples.length, maxIdx = -1;
  samples.forEach((s, i) => { if (inRange(usOf(s))) { minIdx = Math.min(minIdx, i); maxIdx = Math.max(maxIdx, i); } });
  let from = Math.min(minIdx, samples.length - 1);
  while (from > 0 && !samples[from].is_sync) from--;
  if (from > 0) { from--; while (from > 0 && !samples[from].is_sync) from--; }
  const feed = maxIdx >= 0 ? samples.slice(Math.max(0, from), maxIdx + 1) : [];
  meta.total = n ? last - first + 1 : meta.total;

  const config = {
    codec: track.codec.startsWith("vp08") ? "vp8" : track.codec,
    codedWidth: meta.width,
    codedHeight: meta.height,
    description: codecDescription(mp4, track.id),
  };
  const cs = colorSpaceFor(mp4, track.id, meta.height);
  if (cs) config.colorSpace = cs;
  let supported = false;
  if (!forceFallback && typeof VideoDecoder !== "undefined" && feed.length) {
    try { supported = (await VideoDecoder.isConfigSupported(config)).supported; } catch { supported = false; }
  }
  if (!supported) {
    post({ type: "unsupported", ...meta, reason: forceFallback ? "forced" : "codec " + track.codec });
    return;
  }
  post({ type: "info", ...meta });

  const rotation = meta.rotation;
  let canvas = null, ctx = null;
  let emitted = 0;
  let chain = Promise.resolve();
  let queued = 0;
  let decodeError = null;

  const encode = async (frame) => {
    try {
      if (cancelled) return;
      const w = frame.displayWidth, h = frame.displayHeight;
      const swap = rotation === 90 || rotation === 270;
      const cw = swap ? h : w, ch = swap ? w : h;
      if (!canvas || canvas.width !== cw || canvas.height !== ch) {
        canvas = new OffscreenCanvas(cw, ch);
        ctx = canvas.getContext("2d");
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (rotation) {
        ctx.translate(cw / 2, ch / 2);
        ctx.rotate(rotation * Math.PI / 180);
        ctx.translate(-w / 2, -h / 2);
      }
      ctx.drawImage(frame, 0, 0, w, h);
      frame.close();
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
      while (inFlight >= MAX_IN_FLIGHT && !cancelled) await waitTick();
      if (cancelled) return;
      inFlight++;
      post({ type: "frame", index: emitted++, blob });
    } finally {
      try { frame.close(); } catch { /* already closed */ }
      queued--;
      poke();
    }
  };

  const decoder = new VideoDecoder({
    output: (frame) => {
      if (!inRange(frame.timestamp)) { frame.close(); return; } // decoded only as a reference
      queued++; chain = chain.then(() => encode(frame));
    },
    error: (e) => { decodeError = e; poke(); },
  });
  decoder.configure(config);

  // Feed samples in decode order, reading each one straight from the file.
  for (const s of feed) {
    if (cancelled || decodeError) break;
    while ((decoder.decodeQueueSize > MAX_DECODE_QUEUE || queued > MAX_IN_FLIGHT) && !cancelled && !decodeError) {
      await waitTick();
    }
    const data = new Uint8Array(await file.slice(s.offset, s.offset + s.size).arrayBuffer());
    decoder.decode(new EncodedVideoChunk({
      type: s.is_sync ? "key" : "delta",
      timestamp: usOf(s),
      duration: Math.round(1e6 * s.duration / s.timescale),
      data,
    }));
  }
  if (!cancelled && !decodeError) {
    try { await decoder.flush(); } catch (e) { decodeError = decodeError || e; }
  }
  await chain;
  while (inFlight > 0 && !cancelled) await waitTick();
  try { decoder.close(); } catch { /* closed by error */ }

  if (cancelled) { post({ type: "cancelled", count: emitted }); return; }
  if (decodeError && emitted === 0) {
    // Decoder claimed support but failed: let the page try the slower path.
    post({ type: "unsupported", ...meta, reason: String(decodeError.message || decodeError) });
    return;
  }
  if (decodeError) throw decodeError;
  post({ type: "done", count: emitted });
}
