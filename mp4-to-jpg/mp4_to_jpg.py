"""MP4 to JPG Sequence - drag-and-drop Windows tool.

Drop MP4 files onto the window, pick a sequence name (or keep the video's
name), and every frame is written as a JPG into a folder created next to
the video:

    D:\\clips\\shot.mp4  ->  D:\\clips\\shot_seq\\shot_f0001.jpg, shot_f0002.jpg, ...
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from PySide6.QtCore import QProcess, QSettings, Qt, QUrl, Signal
from PySide6.QtGui import QDesktopServices, QFont, QIcon, QPainter, QPixmap, QColor
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QFormLayout,
    QFrame,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QSpinBox,
    QStatusBar,
    QStyleFactory,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

APP_NAME = "MP4 to JPG Sequence"
VIDEO_EXTS = {".mp4", ".m4v", ".mov"}
SEQ_SUFFIX = "_seq"
FRAME_SUFFIX = "_f"
PADDING = 4
INVALID_CHARS = '\\/:*?"<>|'


# --------------------------------------------------------------------------
# Pure helpers (no Qt) - easy to test
# --------------------------------------------------------------------------

def ffmpeg_exe() -> str:
    """Bundled ffmpeg from imageio-ffmpeg, falling back to ffmpeg on PATH."""
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        found = shutil.which("ffmpeg")
        if found:
            return found
        raise RuntimeError("ffmpeg was not found.")


def sanitize(name: str) -> str:
    """Remove characters Windows does not allow in file names."""
    cleaned = "".join(c for c in name if c not in INVALID_CHARS and ord(c) >= 32)
    return cleaned.strip().rstrip(".")


def output_dir(mp4: Path, name: str, parent: Path | None = None) -> Path:
    """Folder that receives the frames: <parent or video folder>/<name>_seq."""
    return Path(parent or Path(mp4).parent) / f"{name}{SEQ_SUFFIX}"


def frame_name(name: str, number: int) -> str:
    return f"{name}{FRAME_SUFFIX}{number:0{PADDING}d}.jpg"


def frame_pattern(name: str) -> str:
    """ffmpeg output pattern, e.g. shot_f%04d.jpg ('%' in the name escaped)."""
    return f"{name.replace('%', '%%')}{FRAME_SUFFIX}%0{PADDING}d.jpg"


def existing_frames(folder: Path, name: str) -> list[Path]:
    if not folder.is_dir():
        return []
    rx = re.compile(re.escape(name + FRAME_SUFFIX) + r"\d+\.jpg$", re.IGNORECASE)
    return [p for p in folder.iterdir() if p.is_file() and rx.match(p.name)]


def probe(mp4: Path) -> tuple[float, float]:
    """Return (duration seconds, fps) by reading `ffmpeg -i` output. 0 if unknown."""
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        res = subprocess.run(
            [ffmpeg_exe(), "-hide_banner", "-i", str(mp4)],
            capture_output=True, text=True, errors="replace",
            timeout=30, creationflags=flags,
        )
        info = res.stderr
    except Exception:
        return 0.0, 0.0
    duration = 0.0
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", info)
    if m:
        h, mi, s = m.groups()
        duration = int(h) * 3600 + int(mi) * 60 + float(s)
    fps = 0.0
    m = re.search(r"Video:.*?(\d+(?:\.\d+)?)\s*fps", info)
    if not m:
        m = re.search(r"Video:.*?(\d+(?:\.\d+)?)\s*tbr", info)
    if m:
        fps = float(m.group(1))
    return duration, fps


def ffmpeg_args(mp4: Path, folder: Path, name: str, quality: int, start: int) -> list[str]:
    return [
        "-hide_banner", "-nostats", "-loglevel", "error", "-y",
        "-i", str(mp4),
        "-map", "0:v:0",
        "-q:v", str(quality),
        "-start_number", str(start),
        "-progress", "pipe:1",
        str(folder / frame_pattern(name)),
    ]


# --------------------------------------------------------------------------
# Name dialog
# --------------------------------------------------------------------------

class NameDialog(QDialog):
    """Asks for the sequence name before converting a file."""

    def __init__(self, mp4: Path, parent_dir: Path | None, keep_default: bool,
                 remaining: int, parent=None):
        super().__init__(parent)
        self.mp4 = Path(mp4)
        self.parent_dir = parent_dir
        self.setWindowTitle("Sequence name")
        self.setModal(True)
        self.setMinimumWidth(520)

        intro = QLabel(f"Choose a name for the frames of <b>{self.mp4.name}</b>.")
        intro.setTextFormat(Qt.RichText)

        self.edit = QLineEdit(self.mp4.stem)
        self.edit.setMaxLength(180)
        self.keep = QCheckBox("Keep the name")
        self.keep.setToolTip("Use the video's own file name")
        self.apply_all = QCheckBox(f"Keep the name for the remaining {remaining} file(s) too")
        self.apply_all.setVisible(remaining > 0)

        self.preview_dir = QLabel()
        self.preview_file = QLabel()
        for lab in (self.preview_dir, self.preview_file):
            lab.setTextInteractionFlags(Qt.TextSelectableByMouse)
            lab.setWordWrap(True)
        self.error = QLabel()
        self.error.setStyleSheet("color: #c42b1c;")

        form = QFormLayout()
        form.addRow("File name:", self.edit)
        form.addRow("", self.keep)
        form.addRow("", self.apply_all)

        preview = QGroupBox("Preview")
        pf = QFormLayout(preview)
        pf.addRow("Folder:", self.preview_dir)
        pf.addRow("Frames:", self.preview_file)

        self.buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        self.buttons.button(QDialogButtonBox.Ok).setText("Convert")
        self.buttons.accepted.connect(self.accept)
        self.buttons.rejected.connect(self.reject)

        lay = QVBoxLayout(self)
        lay.addWidget(intro)
        lay.addLayout(form)
        lay.addWidget(preview)
        lay.addWidget(self.error)
        lay.addWidget(self.buttons)

        self.edit.textChanged.connect(self._update)
        self.keep.toggled.connect(self._keep_toggled)
        self.keep.setChecked(keep_default)
        self._keep_toggled(keep_default)
        self.edit.selectAll()

    def _keep_toggled(self, on: bool):
        if on:
            self.edit.setText(self.mp4.stem)
        self.edit.setEnabled(not on)
        self.apply_all.setEnabled(on)
        if not on:
            self.apply_all.setChecked(False)
            self.edit.setFocus()
            self.edit.selectAll()
        self._update()

    def name(self) -> str:
        return sanitize(self.edit.text())

    def _update(self):
        raw = self.edit.text()
        name = self.name()
        bad = sorted({c for c in raw if c in INVALID_CHARS})
        ok = bool(name)
        if bad:
            self.error.setText("Not allowed in file names: " + " ".join(bad) + " (they will be removed)")
        elif not ok:
            self.error.setText("Please enter a name.")
        else:
            self.error.setText("")
        self.buttons.button(QDialogButtonBox.Ok).setEnabled(ok)
        if ok:
            folder = output_dir(self.mp4, name, self.parent_dir)
            self.preview_dir.setText(str(folder))
            self.preview_file.setText(f"{frame_name(name, 1)}, {frame_name(name, 2)}, ...")
        else:
            self.preview_dir.setText("-")
            self.preview_file.setText("-")


# --------------------------------------------------------------------------
# Drop zone
# --------------------------------------------------------------------------

class DropZone(QFrame):
    clicked = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(120)
        self.setCursor(Qt.PointingHandCursor)
        self._hover = False
        self.label = QLabel(
            "<span style='font-size:13pt'>Drag MP4 files here</span><br>"
            "<span style='color:#5f5f5f'>or click to browse</span>"
        )
        self.label.setAlignment(Qt.AlignCenter)
        self.label.setTextFormat(Qt.RichText)
        lay = QVBoxLayout(self)
        lay.addWidget(self.label)
        self.set_hover(False)

    def set_hover(self, on: bool):
        self._hover = on
        border = "#0067c0" if on else "#8a8a8a"
        bg = "#e5f1fb" if on else "#fbfbfb"
        self.setStyleSheet(
            f"DropZone {{ border: 2px dashed {border}; border-radius: 4px; background: {bg}; }}"
        )

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.LeftButton:
            self.clicked.emit()
        super().mouseReleaseEvent(e)


# --------------------------------------------------------------------------
# Main window
# --------------------------------------------------------------------------

COL_FILE, COL_OUT, COL_STATUS = range(3)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.settings = QSettings("Grebenkin", "Mp4ToJpg")
        self.setWindowTitle(APP_NAME)
        self.setWindowIcon(make_icon())
        self.resize(760, 560)
        self.setAcceptDrops(True)

        self.custom_parent: Path | None = None
        saved = self.settings.value("custom_parent", "")
        if saved and Path(saved).is_dir():
            self.custom_parent = Path(saved)

        self.proc: QProcess | None = None
        self.pending: list[QTreeWidgetItem] = []
        self.current: QTreeWidgetItem | None = None
        self.total_frames = 0
        self.last_folder: Path | None = None
        self.keep_for_rest = False
        self.cancelled = False
        self._buf = b""

        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(11, 11, 11, 11)
        root.setSpacing(8)

        # Drop zone
        self.drop = DropZone()
        self.drop.clicked.connect(self.browse_files)
        root.addWidget(self.drop)

        # Queue
        queue_box = QGroupBox("Files")
        ql = QVBoxLayout(queue_box)
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["Video", "Output folder", "Status"])
        self.tree.setRootIsDecorated(False)
        self.tree.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.tree.setAlternatingRowColors(True)
        hdr = self.tree.header()
        hdr.setSectionResizeMode(COL_FILE, QHeaderView.Interactive)
        hdr.setSectionResizeMode(COL_OUT, QHeaderView.Stretch)
        hdr.setSectionResizeMode(COL_STATUS, QHeaderView.ResizeToContents)
        self.tree.setColumnWidth(COL_FILE, 200)
        self.tree.itemDoubleClicked.connect(self.open_item_folder)
        ql.addWidget(self.tree)
        qb = QHBoxLayout()
        self.btn_add = QPushButton("Add files...")
        self.btn_remove = QPushButton("Remove")
        self.btn_clear = QPushButton("Clear list")
        self.btn_add.clicked.connect(self.browse_files)
        self.btn_remove.clicked.connect(self.remove_selected)
        self.btn_clear.clicked.connect(self.clear_list)
        qb.addWidget(self.btn_add)
        qb.addWidget(self.btn_remove)
        qb.addWidget(self.btn_clear)
        qb.addStretch()
        ql.addLayout(qb)
        root.addWidget(queue_box, 1)

        # Output + options
        opt_box = QGroupBox("Output")
        of = QFormLayout(opt_box)
        path_row = QHBoxLayout()
        self.out_edit = QLineEdit()
        self.out_edit.setReadOnly(True)
        self.btn_change = QPushButton("Change...")
        self.btn_reset = QPushButton("Next to MP4")
        self.btn_change.clicked.connect(self.change_parent)
        self.btn_reset.clicked.connect(self.reset_parent)
        path_row.addWidget(self.out_edit, 1)
        path_row.addWidget(self.btn_change)
        path_row.addWidget(self.btn_reset)
        of.addRow("Output path:", path_row)

        opts = QHBoxLayout()
        self.quality = QSpinBox()
        self.quality.setRange(1, 31)
        self.quality.setValue(int(self.settings.value("quality", 2)))
        self.quality.setToolTip("ffmpeg JPG quality: 1 = best / largest, 31 = worst / smallest")
        self.start = QSpinBox()
        self.start.setRange(0, 999999)
        self.start.setValue(int(self.settings.value("start", 1)))
        opts.addWidget(QLabel("JPG quality (1 = best):"))
        opts.addWidget(self.quality)
        opts.addSpacing(20)
        opts.addWidget(QLabel("First frame number:"))
        opts.addWidget(self.start)
        opts.addStretch()
        of.addRow("", opts)
        root.addWidget(opt_box)

        # Progress + actions
        self.progress = QProgressBar()
        self.progress.setTextVisible(True)
        self.progress.setValue(0)
        root.addWidget(self.progress)

        actions = QHBoxLayout()
        self.btn_open = QPushButton("Open folder")
        self.btn_open.setEnabled(False)
        self.btn_open.clicked.connect(self.open_last_folder)
        self.btn_cancel = QPushButton("Cancel")
        self.btn_cancel.setEnabled(False)
        self.btn_cancel.clicked.connect(self.cancel)
        self.btn_convert = QPushButton("Convert")
        self.btn_convert.setDefault(True)
        self.btn_convert.setMinimumWidth(100)
        self.btn_convert.clicked.connect(self.start_batch)
        actions.addWidget(self.btn_open)
        actions.addStretch()
        actions.addWidget(self.btn_cancel)
        actions.addWidget(self.btn_convert)
        root.addLayout(actions)

        self.setStatusBar(QStatusBar())
        self.statusBar().showMessage("Ready. Drop MP4 files to begin.")
        self._refresh_output_label()
        self._refresh_buttons()

    # ---- drag & drop -----------------------------------------------------

    def _video_paths(self, mime) -> list[Path]:
        out = []
        for url in mime.urls():
            if not url.isLocalFile():
                continue
            p = Path(url.toLocalFile())
            if p.is_dir():
                out += sorted(c for c in p.iterdir() if c.suffix.lower() in VIDEO_EXTS)
            elif p.suffix.lower() in VIDEO_EXTS:
                out.append(p)
        return out

    def dragEnterEvent(self, e):
        if e.mimeData().hasUrls() and self._video_paths(e.mimeData()):
            e.acceptProposedAction()
            self.drop.set_hover(True)
        else:
            e.ignore()

    def dragMoveEvent(self, e):
        e.acceptProposedAction()

    def dragLeaveEvent(self, e):
        self.drop.set_hover(False)

    def dropEvent(self, e):
        self.drop.set_hover(False)
        paths = self._video_paths(e.mimeData())
        if paths:
            e.acceptProposedAction()
            self.add_files(paths)

    # ---- queue -----------------------------------------------------------

    def add_files(self, paths):
        known = {self.tree.topLevelItem(i).data(COL_FILE, Qt.UserRole)
                 for i in range(self.tree.topLevelItemCount())}
        added = 0
        for p in paths:
            p = Path(p).resolve()
            if str(p) in known:
                continue
            item = QTreeWidgetItem([p.name, str(output_dir(p, p.stem, self.custom_parent)) + "  (name asked on convert)", "Waiting"])
            item.setData(COL_FILE, Qt.UserRole, str(p))
            item.setToolTip(COL_FILE, str(p))
            self.tree.addTopLevelItem(item)
            known.add(str(p))
            added += 1
        if added:
            self.statusBar().showMessage(f"Added {added} file(s). Click Convert to start.")
        self._refresh_buttons()

    def browse_files(self):
        if self.busy:
            return
        start = self.settings.value("last_browse", "")
        files, _ = QFileDialog.getOpenFileNames(
            self, "Select MP4 files", start, "Video files (*.mp4 *.m4v *.mov);;All files (*.*)")
        if files:
            self.settings.setValue("last_browse", str(Path(files[0]).parent))
            self.add_files(files)

    def remove_selected(self):
        for item in self.tree.selectedItems():
            self.tree.takeTopLevelItem(self.tree.indexOfTopLevelItem(item))
        self._refresh_buttons()

    def clear_list(self):
        self.tree.clear()
        self.progress.setValue(0)
        self._refresh_buttons()

    # ---- output path -----------------------------------------------------

    def change_parent(self):
        d = QFileDialog.getExistingDirectory(self, "Choose where the _seq folders are created",
                                             str(self.custom_parent or ""))
        if d:
            self.custom_parent = Path(d)
            self.settings.setValue("custom_parent", d)
            self._refresh_output_label()

    def reset_parent(self):
        self.custom_parent = None
        self.settings.setValue("custom_parent", "")
        self._refresh_output_label()

    def _refresh_output_label(self):
        if self.custom_parent:
            self.out_edit.setText(str(self.custom_parent / f"<name>{SEQ_SUFFIX}"))
        else:
            self.out_edit.setText(f"Automatic: next to each MP4  \u2192  <video folder>\\<name>{SEQ_SUFFIX}")
        self.btn_reset.setEnabled(self.custom_parent is not None and not self.busy)
        for i in range(self.tree.topLevelItemCount()):
            item = self.tree.topLevelItem(i)
            if item.text(COL_STATUS) == "Waiting":
                p = Path(item.data(COL_FILE, Qt.UserRole))
                item.setText(COL_OUT, str(output_dir(p, p.stem, self.custom_parent)) + "  (name asked on convert)")

    # ---- conversion ------------------------------------------------------

    @property
    def busy(self) -> bool:
        return self.proc is not None or bool(self.pending) or self.current is not None

    def _refresh_buttons(self):
        busy = self.busy
        has = self.tree.topLevelItemCount() > 0
        self.btn_convert.setEnabled(has and not busy)
        self.btn_cancel.setEnabled(busy)
        for w in (self.btn_add, self.btn_remove, self.btn_clear, self.btn_change,
                  self.quality, self.start):
            w.setEnabled(not busy)
        self.btn_reset.setEnabled(self.custom_parent is not None and not busy)
        self.drop.setEnabled(not busy)
        self.setAcceptDrops(not busy)

    def start_batch(self):
        items = [self.tree.topLevelItem(i) for i in range(self.tree.topLevelItemCount())]
        todo = [it for it in items if it.text(COL_STATUS) != "Done"] or items
        if not todo:
            return
        try:
            ffmpeg_exe()
        except RuntimeError as exc:
            QMessageBox.critical(self, APP_NAME, str(exc))
            return
        self.settings.setValue("quality", self.quality.value())
        self.settings.setValue("start", self.start.value())
        self.pending = list(todo)
        self.keep_for_rest = False
        self.cancelled = False
        self._refresh_buttons()
        self._next()

    def _ask_name(self, mp4: Path) -> str | None:
        if self.keep_for_rest:
            return sanitize(mp4.stem) or "frames"
        keep_default = self.settings.value("keep_name", "true") in (True, "true")
        while True:
            dlg = NameDialog(mp4, self.custom_parent, keep_default, len(self.pending), self)
            if dlg.exec() != QDialog.Accepted:
                return None
            name = dlg.name()
            self.settings.setValue("keep_name", "true" if dlg.keep.isChecked() else "false")
            if dlg.apply_all.isChecked():
                self.keep_for_rest = True
            folder = output_dir(mp4, name, self.custom_parent)
            old = existing_frames(folder, name)
            if not old:
                return name
            box = QMessageBox(self)
            box.setIcon(QMessageBox.Warning)
            box.setWindowTitle("Folder already exists")
            box.setText(f"{folder}\nalready contains {len(old)} frame(s) named {name}{FRAME_SUFFIX}....jpg.")
            box.setInformativeText("Do you want to replace them?")
            b_over = box.addButton("Replace", QMessageBox.AcceptRole)
            b_rename = box.addButton("Choose another name", QMessageBox.ActionRole)
            box.addButton(QMessageBox.Cancel)
            box.exec()
            if box.clickedButton() is b_over:
                for f in old:
                    try:
                        f.unlink()
                    except OSError:
                        pass
                return name
            if box.clickedButton() is b_rename:
                self.keep_for_rest = False
                keep_default = False
                continue
            return None

    def _next(self):
        if self.cancelled or not self.pending:
            self._finish_batch()
            return
        item = self.pending.pop(0)
        self.current = item
        mp4 = Path(item.data(COL_FILE, Qt.UserRole))
        if not mp4.is_file():
            item.setText(COL_STATUS, "Missing")
            self.current = None
            self._next()
            return

        self.tree.setCurrentItem(item)
        name = self._ask_name(mp4)
        if name is None:
            item.setText(COL_STATUS, "Skipped")
            self.current = None
            self._next()
            return

        folder = output_dir(mp4, name, self.custom_parent)
        try:
            folder.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            item.setText(COL_STATUS, "Error")
            QMessageBox.critical(self, APP_NAME, f"Could not create folder:\n{folder}\n\n{exc}")
            self.current = None
            self._next()
            return

        item.setText(COL_OUT, str(folder / frame_name(name, self.start.value())))
        item.setData(COL_OUT, Qt.UserRole, str(folder))
        item.setText(COL_STATUS, "Reading...")
        self.statusBar().showMessage(f"Reading {mp4.name}...")
        QApplication.processEvents()
        duration, fps = probe(mp4)
        self.total_frames = int(round(duration * fps)) if duration and fps else 0
        if self.total_frames:
            self.progress.setRange(0, self.total_frames)
        else:
            self.progress.setRange(0, 0)  # busy indicator
        self.progress.setValue(0)

        self.last_folder = folder
        self._buf = b""
        self._frames = 0
        self._err = b""
        self.proc = QProcess(self)
        self.proc.setProgram(ffmpeg_exe())
        self.proc.setArguments(ffmpeg_args(mp4, folder, name, self.quality.value(), self.start.value()))
        self.proc.readyReadStandardOutput.connect(self._on_stdout)
        self.proc.readyReadStandardError.connect(self._on_stderr)
        self.proc.finished.connect(self._on_finished)
        self.proc.errorOccurred.connect(self._on_error)
        item.setText(COL_STATUS, "Converting...")
        self.statusBar().showMessage(f"Converting {mp4.name}  \u2192  {folder}")
        self.proc.start()

    def _on_stdout(self):
        self._buf += bytes(self.proc.readAllStandardOutput())
        *lines, self._buf = self._buf.split(b"\n")
        for line in lines:
            if line.startswith(b"frame="):
                try:
                    self._frames = int(line[6:].strip())
                except ValueError:
                    continue
                if self.total_frames:
                    if self._frames > self.total_frames:
                        self.total_frames = self._frames
                        self.progress.setMaximum(self._frames)
                    self.progress.setValue(self._frames)
                    pct = 100 * self._frames // max(1, self.total_frames)
                    self.current.setText(COL_STATUS, f"{pct}%")
                else:
                    self.current.setText(COL_STATUS, f"{self._frames} frames")

    def _on_stderr(self):
        self._err += bytes(self.proc.readAllStandardError())

    def _on_error(self, err):
        if err == QProcess.FailedToStart:
            self._on_finished(-1, QProcess.CrashExit)

    def _on_finished(self, code, status):
        proc, self.proc = self.proc, None
        if proc is None:
            return
        proc.deleteLater()
        item = self.current
        self.current = None
        folder = self.last_folder
        count = len(list(folder.glob("*.jpg"))) if folder and folder.is_dir() else 0
        if self.cancelled:
            item.setText(COL_STATUS, "Cancelled")
        elif code == 0 and status == QProcess.NormalExit:
            item.setText(COL_STATUS, "Done")
            self.progress.setRange(0, max(1, self._frames))
            self.progress.setValue(max(1, self._frames))
            self.btn_open.setEnabled(True)
        else:
            item.setText(COL_STATUS, "Error")
            msg = self._err.decode("utf-8", "replace").strip()[-1500:] or "ffmpeg failed."
            QMessageBox.critical(self, APP_NAME, f"Conversion of {item.text(COL_FILE)} failed:\n\n{msg}")
        self.statusBar().showMessage(f"{item.text(COL_FILE)}: {item.text(COL_STATUS)} - {count} JPG(s) in {folder}")
        self._next()

    def _finish_batch(self):
        self.pending = []
        self.current = None
        self._refresh_buttons()
        done = sum(1 for i in range(self.tree.topLevelItemCount())
                   if self.tree.topLevelItem(i).text(COL_STATUS) == "Done")
        if self.cancelled:
            self.statusBar().showMessage("Cancelled.")
            self.progress.setRange(0, 100)
            self.progress.setValue(0)
        else:
            self.statusBar().showMessage(f"Finished. {done} video(s) converted.")
            if self.progress.maximum() == 0:
                self.progress.setRange(0, 100)
                self.progress.setValue(100)

    def cancel(self):
        self.cancelled = True
        self.pending = []
        if self.proc is not None:
            self.proc.kill()
        else:
            self._finish_batch()

    # ---- folders ---------------------------------------------------------

    def open_folder(self, folder: Path | None):
        if folder and Path(folder).is_dir():
            QDesktopServices.openUrl(QUrl.fromLocalFile(str(folder)))

    def open_last_folder(self):
        self.open_folder(self.last_folder)

    def open_item_folder(self, item, _col):
        f = item.data(COL_OUT, Qt.UserRole)
        if f:
            self.open_folder(Path(f))

    def closeEvent(self, e):
        if self.proc is not None:
            if QMessageBox.question(self, APP_NAME, "A conversion is running. Stop it and exit?") \
                    != QMessageBox.Yes:
                e.ignore()
                return
            self.cancelled = True
            self.pending = []
            self.proc.kill()
            self.proc.waitForFinished(3000)
        e.accept()


def make_icon() -> QIcon:
    """Simple film-frame icon drawn in code (no external files needed)."""
    icon = QIcon()
    for size in (16, 24, 32, 48, 64, 256):
        pm = QPixmap(size, size)
        pm.fill(Qt.transparent)
        p = QPainter(pm)
        p.setRenderHint(QPainter.Antialiasing)
        s = size / 32.0
        p.setPen(Qt.NoPen)
        p.setBrush(QColor("#0067c0"))
        p.drawRoundedRect(2 * s, 5 * s, 28 * s, 22 * s, 3 * s, 3 * s)
        p.setBrush(QColor("white"))
        for i in range(4):
            p.drawRect((5 + i * 6.5) * s, 7 * s, 3 * s, 2.5 * s)
            p.drawRect((5 + i * 6.5) * s, 22.5 * s, 3 * s, 2.5 * s)
        p.drawRect(6 * s, 11.5 * s, 20 * s, 9 * s)
        p.end()
        icon.addPixmap(pm)
    return icon


def main():
    if sys.platform == "win32":
        try:  # own taskbar icon instead of python.exe's
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Grebenkin.Mp4ToJpg")
        except Exception:
            pass
    app = QApplication(sys.argv)
    keys = [k.lower() for k in QStyleFactory.keys()]
    for style in ("windows11", "windowsvista", "windows"):
        if style in keys:
            app.setStyle(style)
            break
    if sys.platform == "win32":
        app.setFont(QFont("Segoe UI", 9))
    app.setApplicationName(APP_NAME)
    win = MainWindow()
    # Files passed on the command line (e.g. dropped onto the .exe icon)
    args = [a for a in sys.argv[1:] if Path(a).suffix.lower() in VIDEO_EXTS]
    if args:
        win.add_files(args)
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
