#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""投屏预览区录制为 MP4。"""

from __future__ import annotations

import threading
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from PIL.Image import Image as PILImage


class MirrorRecorder:
    """将投屏帧写入 MP4（需 opencv-python，与内嵌 scrcpy 共用）。"""

    def __init__(self, path: Path, *, fps: float = 30.0) -> None:
        self._path = path
        self._fps = fps
        self._lock = threading.Lock()
        self._writer = None
        self._size: tuple[int, int] | None = None
        self._frames = 0

    @property
    def path(self) -> Path:
        return self._path

    @property
    def frame_count(self) -> int:
        with self._lock:
            return self._frames

    def write_frame(self, img: PILImage) -> None:
        import cv2
        import numpy as np

        rgb = np.asarray(img.convert("RGB"))
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        h, w = bgr.shape[:2]
        with self._lock:
            if self._writer is None:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                fourcc = cv2.VideoWriter_fourcc(*"mp4v")
                self._writer = cv2.VideoWriter(
                    str(self._path), fourcc, self._fps, (w, h)
                )
                if not self._writer.isOpened():
                    self._writer = None
                    raise RuntimeError(f"无法创建录制文件: {self._path}")
                self._size = (w, h)
            elif (w, h) != self._size:
                return
            self._writer.write(bgr)
            self._frames += 1

    def stop(self) -> Path:
        with self._lock:
            if self._writer is not None:
                self._writer.release()
                self._writer = None
        return self._path


def default_mirror_record_path(device: str | None) -> Path:
    from tools.bundled_paths import output_dir

    sn = (device or "device").replace(":", "_")
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return output_dir("mirror") / f"mirror_{sn}_{ts}.mp4"
