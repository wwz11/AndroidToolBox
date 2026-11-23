# -*- coding: utf-8 -*-
"""Unit tests for FastAPI Token Authentication."""

import os
import unittest
from fastapi.testclient import TestClient

from tools.api.app import create_app


class TestApiAuth(unittest.TestCase):
    def test_open_mode_without_token(self) -> None:
        os.environ.pop("TOOLBOX_API_TOKEN", None)
        app = create_app()
        client = TestClient(app)

        r_health = client.get("/health")
        self.assertEqual(r_health.status_code, 200)

        r_local = client.post("/local/md5/text", json={"text": "test"})
        self.assertEqual(r_local.status_code, 200)

    def test_protected_mode_with_token(self) -> None:
        token = "test-secret-token-xyz"
        os.environ["TOOLBOX_API_TOKEN"] = token
        try:
            app = create_app()
            client = TestClient(app)

            # Public endpoints should always be accessible
            r_health = client.get("/health")
            self.assertEqual(r_health.status_code, 200)

            # Protected endpoint without token should return 401
            r_unauth = client.post("/local/md5/text", json={"text": "test"})
            self.assertEqual(r_unauth.status_code, 401)

            # Protected endpoint with wrong token should return 401
            r_wrong = client.post(
                "/local/md5/text",
                json={"text": "test"},
                headers={"X-Toolbox-Token": "wrong-token"},
            )
            self.assertEqual(r_wrong.status_code, 401)

            # Protected endpoint with valid token header should return 200
            r_auth = client.post(
                "/local/md5/text",
                json={"text": "test"},
                headers={"X-Toolbox-Token": token},
            )
            self.assertEqual(r_auth.status_code, 200)
            self.assertEqual(r_auth.json()["chars"], 4)
        finally:
            os.environ.pop("TOOLBOX_API_TOKEN", None)


if __name__ == "__main__":
    unittest.main()
