# MP4 to JPG Sequence

A small Windows app that turns MP4 videos into JPG image sequences. Drag and drop.

## How it works

1. Drag one or more MP4 files (or a folder of them) onto the window, or click the drop area to browse. You can also drop files onto `MP4toJPG.exe` itself.
2. Click **Convert**.
3. For each video you're asked for a **file name**. Tick **Keep the name** to use the video's own name. With several files, you can keep the name for all the rest in one go.
4. Frames are written into a folder created automatically **next to the MP4**:

```
D:\clips\shot.mp4
D:\clips\shot_seq\shot_f0001.jpg
D:\clips\shot_seq\shot_f0002.jpg
...
```

- Folder name: `<name>_seq`
- Frame names: `<name>_f0001.jpg` (4-digit padding, `_f` = frame)
- **Output path → Change…** creates the `_seq` folders somewhere else. **Next to MP4** switches back.
- **JPG quality**: 1 = best (the default is 2). **First frame number**: the default is 1.
- If the folder already holds frames with that name, you can replace them or choose another name.
- Double-click a finished row, or click **Open folder**, to open the sequence in Explorer.

ffmpeg is bundled, so nothing else needs to be installed.

## Download

GitHub → **Actions** → *Build MP4 to JPG (Windows)* → latest run → artifact **MP4toJPG-windows** (contains `MP4toJPG.exe`).

## Run from source

```bash
pip install -r requirements.txt
```

```bash
python mp4_to_jpg.py
```

## Build the exe yourself (on Windows)

```bash
pyinstaller --noconfirm --onefile --windowed --name MP4toJPG --collect-all imageio_ffmpeg mp4_to_jpg.py
```
