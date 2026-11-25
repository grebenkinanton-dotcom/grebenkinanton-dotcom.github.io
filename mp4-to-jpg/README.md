# MP4 to JPG Sequence

Turn MP4 videos into JPG image sequences, right in the browser. Nothing to download or install, and videos never leave your PC.

**Open it:** https://grebenkinanton-dotcom.github.io/mp4-to-jpg/ (Microsoft Edge or Google Chrome)

## How to use it

1. Drag **the folder containing your MP4s**, or the MP4 files themselves, onto the page.
2. Optional: trim the start and end of each video on the timeline (see **Trim** below).
3. Click **Convert**.
4. For each video, choose a **file name** or tick **Keep the name**.
   - If you dropped single files, the first **Convert** asks you to select the video's folder, once. The browser can't see where a dropped file came from. Dropping the folder instead skips this step.
   - The browser asks once whether the page may **edit files** in that folder. Click **Edit files**.
5. Frames are written next to the video:

```
clips\shot.mp4
clips\shot_seq\shot_f0001.jpg
clips\shot_seq\shot_f0002.jpg
...
```

**Options**
- **Output path → Change…** creates the `_seq` folders somewhere else, and the app remembers that folder. **Next to MP4** switches back.
- **JPG quality**: the default is 92. **First frame number**: the default is 1.
- If the folder already holds frames with that name, you can **Replace** them or **Choose another name**.
- **Download as ZIP instead** (under Output path) saves `name_seq.zip`, which contains the `name_seq` folder. This is useful for system folders such as the Desktop, which the browser won't let pages write to. It's also the automatic choice in browsers that can't create folders, such as Firefox.

## Trim (convert only part of a video)

Click a video in the **Files** list. The **Trim** panel shows a preview and a timeline:

- Drag the blue handles to cut off the beginning and the end. The dimmed parts are skipped.
- Click or drag on the timeline to move the playhead. ▶ plays only the kept part, and ◀| / |▶ step one frame.
- **Set start** / **Set end** trim at the playhead. You can also type exact **Start frame** / **End frame** numbers. **Reset** keeps the whole video.
- Keyboard, with the timeline focused:
  - ← / → step one frame. Shift moves 10.
  - **I** / **O** set the start / end.
  - Space plays.
  - Home / End jump to the first / last frame.

The kept part is numbered from **First frame number**, e.g. `shot_f0001.jpg … shot_f0129.jpg`. Each video in the list keeps its own trim, and the Status column shows it as `Waiting · 129/250 frames`.

## Install as an app (optional)

In Edge, click **Install app** at the top of the page, or go to **… → Apps → Install this site as an app**. You get a Start Menu entry and taskbar icon, and it works offline. Once installed, MP4 files also show **MP4 to JPG** under *Open with*.

## How it works

- `worker.js`: [mp4box.js](https://github.com/gpac/mp4box.js) (BSD-3, bundled in `vendor/`) reads the MP4. **WebCodecs** decodes every frame with hardware acceleration, and `OffscreenCanvas` encodes each one as a JPG. Rotation from phone videos is applied.
- Codecs the decoder can't handle (e.g. HEVC on PCs without HEVC support) fall back to stepping through a `<video>` element frame by frame. That path is slower.
- `app.js`: the interface, drag and drop, writing folders (File System Access API), and the ZIP fallback.
- No build step: plain HTML, CSS and JS.

## Desktop version

A standalone Windows `.exe` (PySide6 + ffmpeg) is in [`desktop/`](desktop/) for PCs that allow running downloaded apps.
