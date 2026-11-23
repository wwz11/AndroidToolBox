#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""内嵌 scrcpy 会话管理（按设备 SN 复用）+ 可选录屏。"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from tools.remote.mirror_record import MirrorRecorder, default_mirror_record_path
from tools.remote.scrcpy_embed import EmbeddedScrcpyMirror

if TYPE_CHECKING:
    from PIL.Image import Image as PILImage

# 与桌面端 Tk 投屏接近的画质参数
_DEFAULT_MAX_SIZE = 1280
_DEFAULT_MAX_FPS = 30
_DEFAULT_BITRATE = 8_000_000


class EmbedHub:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._mirrors: dict[str, EmbeddedScrcpyMirror] = {}
        self._refs: dict[str, int] = {}
        self._recorders: dict[str, MirrorRecorder] = {}

    def acquire(
        self,
        device: str,
        *,
        max_size: int = _DEFAULT_MAX_SIZE,
        max_fps: int = _DEFAULT_MAX_FPS,
        video_bit_rate: int = _DEFAULT_BITRATE,
    ) -> EmbeddedScrcpyMirror:
        sn = device.strip()
        with self._lock:
            mirror = self._mirrors.get(sn)
            if mirror is not None and mirror.running:
                self._refs[sn] = self._refs.get(sn, 0) + 1
                return mirror
            if mirror is not None:
                try:
                    mirror.stop()
                except Exception:
                    pass
                self._mirrors.pop(sn, None)
            mirror = EmbeddedScrcpyMirror(
                sn,
                max_size=max_size,
                max_fps=max_fps,
                video_bit_rate=video_bit_rate,
            )
            self._mirrors[sn] = mirror
            self._refs[sn] = 1
        # start outside lock — may take seconds
        try:
            mirror.start()
        except Exception:
            with self._lock:
                if self._mirrors.get(sn) is mirror:
                    self._mirrors.pop(sn, None)
                    self._refs.pop(sn, None)
            raise
        return mirror

    def release(self, device: str, *, keep_record: bool = False) -> None:
        sn = device.strip()
        stop_mirror: Optional[EmbeddedScrcpyMirror] = None
        with self._lock:
            n = self._refs.get(sn, 0) - 1
            if n > 0:
                self._refs[sn] = n
                return
            self._refs.pop(sn, None)
            stop_mirror = self._mirrors.pop(sn, None)
        if stop_mirror is not None:
            try:
                stop_mirror.stop()
            except Exception:
                pass
        if not keep_record:
            self.stop_record(sn)

    def get(self, device: str) -> Optional[EmbeddedScrcpyMirror]:
        sn = device.strip()
        with self._lock:
            m = self._mirrors.get(sn)
            if m is not None and m.running:
                return m
            return None

    def running(self, device: str) -> bool:
        return self.get(device) is not None

    def stop(self, device: str, *, keep_record: bool = False) -> None:
        """停止内嵌投屏。keep_record=True 时保留录屏会话，供断线重连续录。"""
        sn = device.strip()
        with self._lock:
            self._refs.pop(sn, None)
            mirror = self._mirrors.pop(sn, None)
        if mirror is not None:
            try:
                mirror.stop()
            except Exception:
                pass
        if not keep_record:
            self.stop_record(sn)

    def recording(self, device: str) -> bool:
        sn = device.strip()
        with self._lock:
            return sn in self._recorders

    def record_path(self, device: str) -> str:
        sn = device.strip()
        with self._lock:
            rec = self._recorders.get(sn)
            return str(rec.path) if rec is not None else ""

    def start_record(self, device: str, path: str | None = None) -> dict:
        sn = device.strip()
        if not sn:
            raise ValueError("设备 SN 为空")
        with self._lock:
            if sn in self._recorders:
                rec = self._recorders[sn]
                return {
                    "ok": True,
                    "already": True,
                    "path": str(rec.path),
                    "message": "已在录制中",
                }
            mirror = self._mirrors.get(sn)
            if mirror is None or not mirror.running:
                raise RuntimeError("请先开始投屏再录屏")
            out = Path(path) if path else default_mirror_record_path(sn)
            rec = MirrorRecorder(out, fps=float(_DEFAULT_MAX_FPS))
            self._recorders[sn] = rec
        return {
            "ok": True,
            "already": False,
            "path": str(out),
            "message": f"开始录屏 → {out}",
        }

    def write_record_frame(self, device: str, img: "PILImage") -> None:
        sn = device.strip()
        with self._lock:
            rec = self._recorders.get(sn)
        if rec is None:
            return
        rec.write_frame(img)

    def stop_record(self, device: str) -> dict:
        sn = device.strip()
        with self._lock:
            rec = self._recorders.pop(sn, None)
        if rec is None:
            return {
                "ok": True,
                "stopped": False,
                "path": "",
                "frames": 0,
                "message": "当前未在录屏",
            }
        path = rec.stop()
        frames = rec.frame_count
        return {
            "ok": True,
            "stopped": True,
            "path": str(path),
            "frames": frames,
            "message": f"录屏已保存（{frames} 帧）→ {path}",
        }


embed_hub = EmbedHub()
