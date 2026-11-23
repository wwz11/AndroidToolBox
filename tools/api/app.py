#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FastAPI 应用工厂。"""

from __future__ import annotations

import hmac
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from tools.api.routes import (
    adb,
    adb_ops,
    adb_stream,
    emmc_api,
    health,
    keycheck_api,
    local_tools,
    monkey_api,
    remote_api,
    serial_api,
    unifykey,
)
from tools.bundled_paths import ensure_app_vendor_tree
from tools.log_manager import schedule_background_cleanup
from tools.version import __version__


class TokenAuthMiddleware:
    """本地 API 鉴权中间件：防护来自浏览器的本地 CSRF 脚本调用。"""

    def __init__(self, app: ASGIApp, token: str) -> None:
        self.app = app
        self.token = token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not self.token:
            await self.app(scope, receive, send)
            return

        scope_type = scope.get("type")
        if scope_type == "http":
            path = scope.get("path", "")
            method = scope.get("method", "")
            if method == "OPTIONS" or path in ("/health", "/docs", "/openapi.json", "/redoc"):
                await self.app(scope, receive, send)
                return

            headers = dict(scope.get("headers", []))
            req_token = headers.get(b"x-toolbox-token", b"").decode("latin1")
            if not req_token:
                query_string = scope.get("query_string", b"").decode("latin1")
                for param in query_string.split("&"):
                    if param.startswith("token="):
                        req_token = param[6:]
                        break

            if not req_token or not hmac.compare_digest(req_token, self.token):
                response = JSONResponse(
                    status_code=401,
                    content={"detail": "未授权：缺少或无效的访问令牌 (X-Toolbox-Token)"},
                )
                await response(scope, receive, send)
                return

            await self.app(scope, receive, send)

        elif scope_type == "websocket":
            headers = dict(scope.get("headers", []))
            req_token = headers.get(b"x-toolbox-token", b"").decode("latin1")
            if not req_token:
                query_string = scope.get("query_string", b"").decode("latin1")
                for param in query_string.split("&"):
                    if param.startswith("token="):
                        req_token = param[6:]
                        break

            if not req_token or not hmac.compare_digest(req_token, self.token):
                await send({"type": "websocket.close", "code": 1008})
                return

            await self.app(scope, receive, send)

        else:
            await self.app(scope, receive, send)


def create_app() -> FastAPI:
    ensure_app_vendor_tree()
    # 启动后台自动清理过期/超额日志（14天 / 500MB）
    schedule_background_cleanup(max_days=14, max_total_mb=500)

    app = FastAPI(title="SEIAndroidTVTestToolBox API", version=__version__, docs_url="/docs")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:5174",
            "http://127.0.0.1:5174",
            "null",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    expected_token = os.environ.get("TOOLBOX_API_TOKEN", "").strip()
    if expected_token:
        app.add_middleware(TokenAuthMiddleware, token=expected_token)

    app.include_router(health.router)
    app.include_router(adb.router, prefix="/adb", tags=["adb"])
    app.include_router(adb_ops.router, prefix="/adb/device", tags=["adb-ops"])
    app.include_router(adb_stream.router, prefix="/adb/device", tags=["adb-stream"])
    app.include_router(monkey_api.router, prefix="/adb/device", tags=["monkey"])
    app.include_router(keycheck_api.router, prefix="/adb/device", tags=["keycheck"])
    app.include_router(unifykey.router, prefix="/unifykey", tags=["unifykey"])
    app.include_router(local_tools.router, prefix="/local", tags=["local"])
    app.include_router(serial_api.router, prefix="/serial", tags=["serial"])
    app.include_router(remote_api.router, prefix="/remote", tags=["remote"])
    app.include_router(emmc_api.router, prefix="/emmc", tags=["emmc"])
    return app
