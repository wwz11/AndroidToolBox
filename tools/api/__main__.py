#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""启动本机 API：python -m tools.api [--port 17831]"""

from __future__ import annotations

import argparse
import os
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Toolbox local API")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("TOOLBOX_API_PORT", "17831")),
    )
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args(argv)

    try:
        import uvicorn
    except ImportError:
        print(
            "缺少依赖：请先执行 pip install -r build/requirements-api.txt",
            file=sys.stderr,
        )
        return 1

    print(f"TOOLBOX_API_READY http://{args.host}:{args.port}", flush=True)

    frozen = bool(getattr(sys, "frozen", False))
    if frozen or not args.reload:
        # 打包侧车必须直接传入 app 实例，避免字符串导入失败/旧缓存
        from tools.api.app import create_app

        uvicorn.run(
            create_app(),
            host=args.host,
            port=args.port,
            log_level="info",
        )
    else:
        uvicorn.run(
            "tools.api.app:create_app",
            factory=True,
            host=args.host,
            port=args.port,
            reload=True,
            log_level="info",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
