"use strict";
// MP4 to JPG Sequence - web version.
// Frames go to "<name>_seq/<name>_f0001.jpg" inside the video's folder
// (File System Access API), or into "<name>_seq.zip" where a browser can't
// write folders. Videos never leave the PC.

const VIDEO_EXT = /\.(mp4|m4v|mov)$/i;
const SEQ_SUFFIX = "_seq";
const FRAME_SUFFIX = "_f";
const PAD = 4;
const INVALID = '\\/:*?"<>|';
const HAS_FS = "showDirectoryPicker" in window;

// ------------------------------------------------------------------ helpers

function sanitize(name) {
  let out = "";
  for (const c of name) if (!INVALID.includes(c) && c.charCodeAt(0) >= 32) out += c;
  return out.trim().replace(/[. ]+$/, "");
}
const stem = (fileName) => fileName.replace(/\.[^.]+$/, "");
const seqFolderName = (name) => name + SEQ_SUFFIX;
const frameName = (name, n) => `${name}${FRAME_SUFFIX}${String(n).padStart(PAD, "0")}.jpg`;
const frameRegex = (name) =>
  new RegExp("^" + (name + FRAME_SUFFIX).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\d+\\.jpg$", "i");
const $ = (id) => document.getElementById(id);

const store = {
  get(k, d) { try { const v = localStorage.getItem("m2j." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("m2j." + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// Remembered folders (IndexedDB) so a dropped MP4 can find its folder again.
const idb = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("mp4-to-jpg", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async get(k) {
    try {
      const db = await this.open();
      return await new Promise((res) => {
        const q = db.transaction("kv").objectStore("kv").get(k);
        q.onsuccess = () => res(q.result); q.onerror = () => res(undefined);
      });
    } catch { return undefined; }
  },
  async set(k, v) {
    try {
      const db = await this.open();
      db.transaction("kv", "readwrite").objectStore("kv").put(v, k);
    } catch { /* storage blocked */ }
  },
};

let knownDirs = [];
async function rememberDir(dir) {
  if (!dir) return;
  for (const d of knownDirs) if (await d.isSameEntry(dir)) return;
  knownDirs.unshift(dir);
  knownDirs = knownDirs.slice(0, 12);
  idb.set("dirs", knownDirs);
}
async function dirHasFile(dir, file) {
  try {
    const f = await (await dir.getFileHandle(file.name)).getFile();
    return f.size === file.size;
  } catch { return false; }
}
async function findDirFor(file) {
  for (const d of knownDirs) {
    try {
      if ((await d.queryPermission({ mode: "read" })) !== "granted") continue;
      if (await dirHasFile(d, file)) return d;
    } catch { /* stale handle */ }
  }
  return null;
}
async function ensureWrite(dir) {
  try {
    if ((await dir.queryPermission({ mode: "readwrite" })) === "granted") return true;
    return (await dir.requestPermission({ mode: "readwrite" })) === "granted";
  } catch { return false; }
}
async function pickFolder() {
  try {
    const dir = await window.showDirectoryPicker({ id: "mp4-to-jpg", mode: "readwrite" });
    await rememberDir(dir);
    return dir;
  } catch { return null; } // cancelled or blocked folder
}

// ------------------------------------------------------------------ state

const items = [];   // { id, file, dir, status, out, tr, zip }
let outDir = null;  // custom output parent (null = next to each MP4)
let zipMode = !HAS_FS || store.get("zip", false); // download <name>_seq.zip instead of writing folders
let running = false;
let cancelled = false;
let worker = null;
let uid = 0;

const ui = {
  drop: $("drop"), tbody: document.querySelector("#files tbody"), empty: $("empty"),
  remove: $("remove"), clear: $("clear"), outPath: $("out-path"), outChange: $("out-change"),
  outReset: $("out-reset"), outZip: $("out-zip"), quality: $("quality"), qualityVal: $("quality-val"), start: $("start"),
  convert: $("convert"), cancel: $("cancel"), progress: document.querySelector(".progress"),
  bar: document.querySelector(".progress-bar"), progressText: $("progress-text"), status: $("status"),
};

function status(msg) { ui.status.textContent = msg; ui.status.title = msg; }
function setProgress(done, total) {
  if (total === null) { ui.progress.classList.add("indeterminate"); ui.bar.style.width = ""; return; }
  ui.progress.classList.remove("indeterminate");
  const pct = total ? Math.min(100, (100 * done) / total) : 0;
  ui.bar.style.width = pct + "%";
  ui.progress.setAttribute("aria-valuenow", String(Math.round(pct)));
}

function outLabel(item, name) {
  const n = name || stem(item.file.name);
  const parent = outDir || item.dir;
  if (zipMode) return `Download → ${seqFolderName(n)}.zip`;
  return parent ? `${parent.name}\\${seqFolderName(n)}` : "Folder will be asked on Convert";
}

function renderRow(item) {
  if (!item.tr) {
    item.tr = document.createElement("tr");
    item.tr.innerHTML = "<td></td><td class='col-out'></td><td class='col-status'></td>";
    item.tr.addEventListener("click", (e) => {
      if (!e.ctrlKey && !e.metaKey) items.forEach((i) => i.tr.classList.remove("sel"));
      item.tr.classList.toggle("sel");
      refreshButtons();
    });
    ui.tbody.appendChild(item.tr);
  }
  const [c1, c2, c3] = item.tr.children;
  c1.textContent = item.file.name; c1.title = item.file.name;
  c2.textContent = item.out || outLabel(item); c2.title = c2.textContent;
  c3.textContent = item.status;
  c3.className = "col-status" + (item.status === "Done" ? " st-done" : /error|failed/i.test(item.status) ? " st-error" : "");
}

function refreshButtons() {
  const has = items.length > 0;
  ui.empty.hidden = has;
  ui.convert.disabled = !has || running;
  ui.cancel.disabled = !running;
  ui.clear.disabled = !has || running;
  ui.remove.disabled = running || !items.some((i) => i.tr.classList.contains("sel"));
  ui.outChange.disabled = running || zipMode;
  ui.outReset.disabled = running || zipMode || !outDir;
  ui.outZip.disabled = running || !HAS_FS;
  ui.quality.disabled = ui.start.disabled = running;
  ui.drop.classList.toggle("disabled", running);
}

function refreshOutPath() {
  if (!HAS_FS) ui.outPath.value = "Downloads → <name>_seq.zip (this browser can't create folders)";
  else if (zipMode) ui.outPath.value = "Downloads → <name>_seq.zip";
  else if (outDir) ui.outPath.value = `${outDir.name}\\<name>${SEQ_SUFFIX}`;
  else ui.outPath.value = `Automatic: next to each MP4 → <video folder>\\<name>${SEQ_SUFFIX}`;
  items.forEach((i) => { if (!i.out) renderRow(i); });
  refreshButtons();
}

// ------------------------------------------------------------------ adding files

async function addFile(file, dir) {
  if (!VIDEO_EXT.test(file.name)) return false;
  if (items.some((i) => i.file.name === file.name && i.file.size === file.size && i.file.lastModified === file.lastModified)) return false;
  if (!dir && HAS_FS) dir = await findDirFor(file);
  const item = { id: ++uid, file, dir, status: "Waiting", out: "" };
  items.push(item);
  renderRow(item);
  return true;
}

async function addDirectory(dir) {
  await rememberDir(dir);
  const files = [];
  for await (const entry of dir.values()) {
    if (entry.kind === "file" && VIDEO_EXT.test(entry.name)) files.push(await entry.getFile());
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  let n = 0;
  for (const f of files) if (await addFile(f, dir)) n++;
  return n;
}

function readEntryDir(entry) { // fallback for browsers without File System Access
  return new Promise((res) => {
    const out = [];
    const reader = entry.createReader();
    const next = () => reader.readEntries(async (batch) => {
      if (!batch.length) return res(out);
      for (const e of batch) if (e.isFile && VIDEO_EXT.test(e.name)) out.push(await new Promise((r) => e.file(r, () => r(null))));
      next();
    }, () => res(out));
    next();
  });
}

async function handleDrop(dt) {
  const list = [...dt.items].filter((i) => i.kind === "file");
  // These must be requested synchronously, before any await.
  const handles = list.map((i) => (i.getAsFileSystemHandle ? i.getAsFileSystemHandle() : null));
  const entries = list.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  const files = list.map((i) => i.getAsFile());
  let added = 0, skipped = 0;
  for (let k = 0; k < list.length; k++) {
    let h = null;
    try { h = handles[k] ? await handles[k] : null; } catch { h = null; }
    if (h && h.kind === "directory") added += await addDirectory(h);
    else if (h && h.kind === "file") (await addFile(await h.getFile(), null)) ? added++ : skipped++;
    else if (entries[k] && entries[k].isDirectory) {
      for (const f of await readEntryDir(entries[k])) if (f && (await addFile(f, null))) added++;
    } else if (files[k]) (await addFile(files[k], null)) ? added++ : skipped++;
  }
  afterAdd(added, skipped);
}

function afterAdd(added, skipped) {
  refreshButtons();
  if (added) status(`Added ${added} video(s). Click Convert to start.`);
  else if (skipped) status("Only .mp4, .m4v and .mov files can be added (or they're already in the list).");
}

// ------------------------------------------------------------------ name dialog

function askName(item, remaining) {
  const dlg = $("name-dlg");
  const name = $("dlg-name"), keep = $("dlg-keep"), all = $("dlg-all");
  const ok = $("dlg-ok"), err = $("dlg-error"), note = $("dlg-prev-note");
  // Where it goes is decided by the main window's Output settings.
  const zip = zipMode;
  let dir = outDir || item.dir;

  $("dlg-video").textContent = item.file.name;
  $("dlg-all-text").textContent = `Keep the name for the remaining ${remaining} file(s) too`;
  $("dlg-all-wrap").hidden = remaining < 1;
  keep.checked = store.get("keepName", true);
  all.checked = false;
  name.value = stem(item.file.name);

  const update = () => {
    name.disabled = keep.checked;
    all.disabled = !keep.checked;
    if (!keep.checked) all.checked = false;
    if (keep.checked) name.value = stem(item.file.name);
    const n = sanitize(name.value);
    const bad = [...new Set([...name.value].filter((c) => INVALID.includes(c)))];
    err.textContent = bad.length ? `Not allowed in file names: ${bad.join(" ")} (they will be removed)` : n ? "" : "Please enter a name.";

    const seq = seqFolderName(n || "name");
    $("dlg-prev-dir").textContent = zip ? `Download → ${seq}.zip` : dir ? `${dir.name}\\${seq}` : `<folder of ${item.file.name}>\\${seq}`;
    $("dlg-prev-file").textContent = n ? `${frameName(n, +ui.start.value || 0)}, ${frameName(n, (+ui.start.value || 0) + 1)}, …` : "-";
    note.hidden = zip || !!dir;
    note.textContent = `After you click Convert, select the folder that contains ${item.file.name}. The browser can't see where a dropped file came from; the folder is remembered for next time.`;
    ok.disabled = !n;
  };

  name.oninput = update;
  keep.onchange = () => { update(); if (!keep.checked) { name.focus(); name.select(); } };

  return new Promise((resolve) => {
    ok.onclick = async (e) => {
      e.preventDefault();
      if (ok.disabled) return;
      if (!zip && !dir) {
        const d = await pickFolder();
        if (!d) { err.textContent = "No folder selected. Click Convert again, or drop the video's folder instead."; return; }
        dir = d;
        if (!outDir) item.dir = d;
      }
      if (!zip && !(await ensureWrite(dir))) {
        err.textContent = "The browser needs permission to create files in this folder. Click Convert and choose \"Edit files\".";
        return;
      }
      dlg.close("ok");
    };
    dlg.onclose = () => {
      if (dlg.returnValue !== "ok") return resolve(null);
      store.set("keepName", keep.checked);
      resolve({ name: sanitize(name.value), dir: zip ? null : dir, zip, keepRest: all.checked });
    };
    dlg.returnValue = "";
    update();
    dlg.showModal();
    if (!keep.checked) { name.focus(); name.select(); } else ok.focus();
  });
}

function askConflict(folderLabel, count, name) {
  const dlg = $("conflict-dlg");
  $("conflict-text").textContent = `${folderLabel} already contains ${count} frame(s) named ${name}${FRAME_SUFFIX}….jpg.`;
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue || "cancel");
    dlg.returnValue = "";
    dlg.showModal();
  });
}

// ------------------------------------------------------------------ output sinks

async function folderSink(parent, name) {
  const dir = await parent.getDirectoryHandle(seqFolderName(name), { create: true });
  return {
    label: `${parent.name}\\${seqFolderName(name)}`,
    async write(fileName, blob) {
      const fh = await dir.getFileHandle(fileName, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
    },
    async finish() {},
  };
}

// Minimal store-only ZIP (no compression: JPGs are already compressed).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipSink(name) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  return {
    label: `${seqFolderName(name)}.zip`,
    async write(fileName, blob) {
      const data = new Uint8Array(await blob.arrayBuffer());
      const path = enc.encode(`${seqFolderName(name)}/${fileName}`);
      const crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
      h.setUint16(8, 0, true); h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true);
      h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
      h.setUint16(26, path.length, true); h.setUint16(28, 0, true);
      parts.push(h.buffer, path, blob);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true); c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, path.length, true); c.setUint32(42, offset, true);
      central.push(c.buffer, path);
      offset += 30 + path.length + data.length;
      if (offset > 0xffffffff) throw new Error("The ZIP would be larger than 4 GB. Save into a folder instead.");
    },
    async finish() {
      const count = central.length / 2;
      const size = central.reduce((s, p) => s + p.byteLength, 0);
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true); end.setUint16(8, count, true); end.setUint16(10, count, true);
      end.setUint32(12, size, true); end.setUint32(16, offset, true);
      const zip = new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(zip), download: `${seqFolderName(name)}.zip` });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    },
    zipBlobForTest: () => new Blob([...parts, ...central]),
  };
}

// ------------------------------------------------------------------ conversion

function extractWithWorker(file, quality, onInfo, onFrame, forceFallback) {
  return new Promise((resolve, reject) => {
    worker = new Worker("worker.js");
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "info") onInfo(m);
      else if (m.type === "frame") onFrame(m.index, m.blob).then(() => worker && worker.postMessage({ type: "ack" }), (err) => { cleanup(); reject(err); });
      else if (m.type === "done" || m.type === "cancelled" || m.type === "unsupported") { cleanup(); resolve(m); }
      else if (m.type === "error") { cleanup(); reject(new Error(m.message)); }
    };
    worker.onerror = (e) => { cleanup(); reject(new Error(e.message || "Worker failed")); };
    const cleanup = () => { if (worker) { worker.terminate(); worker = null; } };
    worker.postMessage({ type: "start", file, quality, forceFallback: !!forceFallback });
  });
}

function once(el, ok, bad) {
  return new Promise((res, rej) => {
    const a = () => { el.removeEventListener(bad, b); res(); };
    const b = () => { el.removeEventListener(ok, a); rej(new Error("This browser can't play this video format.")); };
    el.addEventListener(ok, a, { once: true });
    if (bad) el.addEventListener(bad, b, { once: true });
  });
}

// Slower path: seek a <video> element frame by frame (for codecs WebCodecs lacks).
async function extractWithVideo(file, quality, meta, onInfo, onFrame) {
  const v = document.createElement("video");
  v.muted = true; v.preload = "auto"; v.playsInline = true;
  const url = URL.createObjectURL(file);
  v.src = url;
  try {
    await once(v, "loadeddata", "error");
    const fps = meta.fps > 0 ? meta.fps : 30;
    const total = meta.total > 0 ? meta.total : Math.max(1, Math.round(v.duration * fps));
    onInfo({ total, fps });
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth; canvas.height = v.videoHeight;
    const ctx = canvas.getContext("2d");
    let i = 0;
    for (; i < total && !cancelled; i++) {
      const t = (i + 0.5) / fps;
      if (t >= v.duration) break;
      v.currentTime = t;
      await once(v, "seeked", "error");
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
      await onFrame(i, blob);
    }
    return { type: cancelled ? "cancelled" : "done", count: i };
  } finally {
    URL.revokeObjectURL(url);
    v.removeAttribute("src"); v.load();
  }
}

async function convertOne(item, choice) {
  const { name } = choice;
  const startNo = Math.max(0, parseInt(ui.start.value, 10) || 0);
  const quality = (+ui.quality.value || 92) / 100;
  const sink = choice.zip ? zipSink(name) : await folderSink(choice.dir, name);
  item.out = sink.label; renderRow(item);

  let total = 0, written = 0, chain = Promise.resolve();
  const onInfo = (m) => { total = m.total; setProgress(0, total || null); };
  const onFrame = (index, blob) => {
    chain = chain.then(async () => {
      await sink.write(frameName(name, startNo + index), blob);
      written++;
      if (total) setProgress(written, total);
      item.status = total ? `${Math.floor((100 * written) / total)}%` : `${written} frames`;
      renderRow(item);
      ui.progressText.textContent = `${item.file.name} — frame ${written}${total ? " / " + total : ""}`;
    });
    return chain;
  };

  item.status = "Reading…"; renderRow(item);
  setProgress(0, null);
  let res = await extractWithWorker(item.file, quality, onInfo, onFrame, window.__forceVideoFallback);
  if (res.type === "unsupported") {
    item.status = "Converting (slow mode)…"; renderRow(item);
    status(`${item.file.name}: using the slower playback method (${res.reason}).`);
    res = await extractWithVideo(item.file, quality, res, onInfo, onFrame);
  }
  await chain;
  if (res.type === "cancelled" || cancelled) return { status: "Cancelled", count: written, label: sink.label };
  if (!written) throw new Error("No frames could be read from this video.");
  await sink.finish();
  return { status: "Done", count: written, label: sink.label };
}

async function existingFrames(parent, name) {
  try {
    const dir = await parent.getDirectoryHandle(seqFolderName(name));
    const rx = frameRegex(name), found = [];
    for await (const e of dir.values()) if (e.kind === "file" && rx.test(e.name)) found.push(e.name);
    return { dir, found };
  } catch { return { dir: null, found: [] }; }
}

async function chooseFor(item, remaining, state) {
  let forceAsk = false;
  for (;;) {
    let choice = null;
    if (!outDir && !item.dir && HAS_FS) item.dir = await findDirFor(item.file);
    const dir = outDir || item.dir;
    const kept = sanitize(stem(item.file.name)) || "frames";
    if (state.keepRest && !forceAsk) {
      if (zipMode) choice = { name: kept, dir: null, zip: true };
      else if (dir && (await ensureWriteQuiet(dir))) choice = { name: kept, dir, zip: false };
    }
    if (!choice) {
      choice = await askName(item, remaining);
      if (!choice) return null;
      if (choice.keepRest) state.keepRest = true;
      if (choice.dir && !outDir && !item.dir) { item.dir = choice.dir; }
    }
    if (choice.zip) return choice;
    const { dir: seq, found } = await existingFrames(choice.dir, choice.name);
    if (!found.length) return choice;
    const answer = await askConflict(`${choice.dir.name}\\${seqFolderName(choice.name)}`, found.length, choice.name);
    if (answer === "replace") {
      for (const f of found) { try { await seq.removeEntry(f); } catch { /* in use */ } }
      return choice;
    }
    if (answer === "rename") { state.keepRest = false; forceAsk = true; store.set("keepName", false); continue; }
    return null;
  }
}
async function ensureWriteQuiet(dir) {
  try { return (await dir.queryPermission({ mode: "readwrite" })) === "granted"; } catch { return false; }
}

async function convertAll() {
  if (running || !items.length) return;
  const todo = items.filter((i) => i.status !== "Done");
  const queue = todo.length ? todo : items.slice();
  running = true; cancelled = false;
  store.set("quality", +ui.quality.value); store.set("start", +ui.start.value);
  refreshButtons();
  const state = { keepRest: false };
  let done = 0, lastLabel = "";
  for (let k = 0; k < queue.length && !cancelled; k++) {
    const item = queue[k];
    items.forEach((i) => i.tr.classList.toggle("sel", i === item));
    const choice = await chooseFor(item, queue.length - k - 1, state);
    if (!choice) { item.status = "Skipped"; renderRow(item); continue; }
    try {
      status(`Converting ${item.file.name}…`);
      const r = await convertOne(item, choice);
      item.status = r.status; renderRow(item);
      if (r.status === "Done") { done++; lastLabel = r.label; status(`${item.file.name}: ${r.count} JPG(s) saved to ${r.label}`); }
    } catch (err) {
      item.status = "Error"; renderRow(item);
      status(`${item.file.name}: ${err.message || err}`);
      alert(`Converting ${item.file.name} failed:\n\n${err.message || err}`);
    }
  }
  running = false;
  ui.progressText.textContent = "";
  if (cancelled) { setProgress(0, 1); status("Cancelled."); }
  else { setProgress(1, 1); status(done ? `Finished. ${done} video(s) converted.${lastLabel ? " Last one saved to " + lastLabel + "." : ""}` : "Nothing was converted."); }
  refreshButtons();
}

function cancel() {
  cancelled = true;
  if (worker) worker.postMessage({ type: "cancel" });
}

// ------------------------------------------------------------------ wiring

function init() {
  ui.quality.value = store.get("quality", 92);
  ui.start.value = store.get("start", 1);
  const showQ = () => { ui.qualityVal.textContent = `(${ui.quality.value})`; };
  ui.quality.oninput = showQ; showQ();

  if (!HAS_FS) {
    const bar = $("unsupported");
    bar.hidden = false;
    bar.textContent = "This browser can't create folders, so each sequence is downloaded as a ZIP. For folders next to your videos, use Microsoft Edge or Google Chrome.";
    $("pick-folder").hidden = true;
  }

  const drop = ui.drop;
  ["dragenter", "dragover"].forEach((t) => document.addEventListener(t, (e) => {
    if (running || !e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "copy"; drop.classList.add("over");
  }));
  document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) drop.classList.remove("over"); });
  document.addEventListener("drop", (e) => {
    e.preventDefault(); drop.classList.remove("over");
    if (!running && e.dataTransfer) handleDrop(e.dataTransfer);
  });

  const input = $("file-input");
  input.onchange = async () => {
    let n = 0;
    for (const f of input.files) if (await addFile(f, null)) n++;
    input.value = "";
    afterAdd(n, 0);
  };
  $("pick-files").onclick = (e) => { e.stopPropagation(); input.click(); };
  $("pick-folder").onclick = async (e) => {
    e.stopPropagation();
    const d = await pickFolder();
    if (d) afterAdd(await addDirectory(d), 0);
  };
  drop.onclick = () => { if (HAS_FS) $("pick-folder").click(); else input.click(); };
  drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); drop.click(); } };

  ui.remove.onclick = () => {
    for (let k = items.length - 1; k >= 0; k--) if (items[k].tr.classList.contains("sel")) { items[k].tr.remove(); items.splice(k, 1); }
    refreshButtons();
  };
  ui.clear.onclick = () => { items.splice(0).forEach((i) => i.tr.remove()); setProgress(0, 1); refreshButtons(); };
  ui.outChange.onclick = async () => {
    const d = await pickFolder();
    if (d) { outDir = d; idb.set("outDir", d); refreshOutPath(); }
  };
  ui.outReset.onclick = () => { outDir = null; idb.set("outDir", null); refreshOutPath(); };
  ui.outZip.checked = zipMode;
  ui.outZip.onchange = () => { zipMode = ui.outZip.checked; store.set("zip", zipMode); refreshOutPath(); };
  ui.convert.onclick = convertAll;
  ui.cancel.onclick = cancel;
  window.addEventListener("beforeunload", (e) => { if (running) { e.preventDefault(); e.returnValue = ""; } });

  // "Open with" from Windows when installed as an app.
  if ("launchQueue" in window) {
    window.launchQueue.setConsumer(async (params) => {
      let n = 0;
      for (const h of params.files || []) if (h.kind === "file" && (await addFile(await h.getFile(), null))) n++;
      afterAdd(n, 0);
    });
  }

  // Install button
  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; $("install").hidden = false; });
  $("install").onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $("install").hidden = true; };
  window.addEventListener("appinstalled", () => { $("install").hidden = true; });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  idb.get("dirs").then((d) => { if (Array.isArray(d)) knownDirs = d; });
  // The custom output folder is remembered between visits.
  if (HAS_FS) idb.get("outDir").then((d) => { if (d && d.kind === "directory" && !outDir) { outDir = d; refreshOutPath(); } });
  refreshOutPath();
}

init();
// Exposed for automated tests.
window.__m2j = { sanitize, frameName, seqFolderName, folderSink, zipSink, convertOne, items, addFile, idb };
