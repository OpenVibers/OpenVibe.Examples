#!/usr/bin/env python3
"""AI from Python: the official `openai` client pointed at OpenVibe.AI.

    pip install openai httpx
    OV_CLIENT_ID=... OV_CLIENT_SECRET=... python3 chat.py "Say hi in five words"

1. An app token of openvibe.ai from Network (client credentials, scope ai.app.run: the public capability developer
   apps call AI with). Network tokens last five minutes; this keeps one and asks again a minute before it ends.
2. OpenAI(base_url="https://ai.openvibe.services/v1", api_key=<the token>).
3. `model` is a dynamic name (openvibe picks within your rules) or an exact model id from openvibe.network/models;
   the answer names the model that ran, and `x_openvibe` carries the run, the provider and the cost.
"""
import os
import sys
import time

import httpx
from openai import OpenAI

NETWORK = os.environ.get("OV_NETWORK_URL", "https://openvibe.network")
AI = os.environ.get("OV_AI_URL", "https://ai.openvibe.services/v1")
_token = {"value": None, "expires": 0.0}


def app_token() -> str:
    """A Network app token of openvibe.ai, reused until a minute before it expires."""
    if _token["value"] and time.time() < _token["expires"] - 60:
        return _token["value"]
    res = httpx.post(f"{NETWORK}/oauth/token", data={
        "grant_type": "client_credentials",
        "client_id": os.environ["OV_CLIENT_ID"],
        "client_secret": os.environ["OV_CLIENT_SECRET"],
        "audience": "openvibe.ai",
        "scope": "ai.app.run",
    }, timeout=10)
    res.raise_for_status()
    doc = res.json()
    _token.update(value=doc["access_token"], expires=time.time() + int(doc.get("expires_in", 300)))
    return _token["value"]


def ask(prompt: str, model: str = os.environ.get("OV_MODEL", "openvibe")):
    client = OpenAI(base_url=AI, api_key=app_token())
    reply = client.chat.completions.create(model=model, messages=[{"role": "user", "content": prompt}])
    extra = (reply.model_extra or {}).get("x_openvibe") or {}
    return reply.choices[0].message.content, reply.model, extra


if __name__ == "__main__":
    text, model, extra = ask(" ".join(sys.argv[1:]) or "Say hi in five words")
    print(text)
    print(f"({model}, ${extra.get('cost_usd')})" if extra.get("cost_usd") is not None else f"({model})")
