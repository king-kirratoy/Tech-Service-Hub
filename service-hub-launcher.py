#!/usr/bin/env python3
"""
Service Hub Proxy Server (Render-hosted)
========================================
All secrets are stored as environment variables on Render.
Authenticates users via Supabase, issues JWT tokens,
and gates all data endpoints behind auth.
"""

import os
import json
import time
import requests
from functools import wraps
from flask import Flask, request, jsonify
from flask_cors import CORS
import jwt

app = Flask(__name__)
CORS(app, supports_credentials=True)

# ═══════════════════════════════════════════════════════════
# CONFIGURATION — All from environment variables
# ═══════════════════════════════════════════════════════════

HALOPSA_REPORT_URL = os.environ.get("HALOPSA_REPORT_URL", "")
HALOPSA_BEARER_TOKEN = os.environ.get("HALOPSA_BEARER_TOKEN", "")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
JWT_SECRET = os.environ.get("JWT_SECRET", "change-me-in-production")
PROXY_KEY = os.environ.get("PROXY_KEY", "")

# Load baselines from file
BASELINES = {}
baselines_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "baselines.json")
if os.path.exists(baselines_path):
    with open(baselines_path, "r") as f:
        BASELINES = json.load(f)


# ═══════════════════════════════════════════════════════════
# AUTH HELPERS
# ═══════════════════════════════════════════════════════════

def create_token(agent_name, role):
    payload = {
        "agent_name": agent_name,
        "role": role,
        "iat": int(time.time()),
        "exp": int(time.time()) + 86400  # 24 hour expiry
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return jsonify({"error": "Missing or invalid Authorization header"}), 401
        token = auth_header[7:]
        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
            request.user = payload
        except jwt.ExpiredSignatureError:
            return jsonify({"error": "Token expired"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"error": "Invalid token"}), 401
        return f(*args, **kwargs)
    return decorated


def supabase_request(method, table, params=None, body=None):
    """Make a request to the Supabase REST API."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation"
    }
    if method == "GET":
        resp = requests.get(url, headers=headers, params=params)
    elif method == "POST":
        headers["Prefer"] = "resolution=merge-duplicates,return=representation"
        resp = requests.post(url, headers=headers, params=params, json=body)
    else:
        resp = requests.request(method, url, headers=headers, params=params, json=body)
    return resp


# ═══════════════════════════════════════════════════════════
# ROUTES
# ═══════════════════════════════════════════════════════════

@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    password = data.get("password", "").strip()
    if not password:
        return jsonify({"error": "Password required"}), 400

    # Validate against Supabase agent_logins table
    resp = supabase_request("GET", "agent_logins", params={
        "select": "agent_name,role",
        "password": f"eq.{password}",
        "limit": "1"
    })
    if resp.status_code != 200:
        return jsonify({"error": "Auth service unavailable"}), 503

    rows = resp.json()
    if not rows:
        return jsonify({"error": "Invalid password"}), 401

    agent = rows[0]
    token = create_token(agent["agent_name"], agent["role"])
    return jsonify({
        "token": token,
        "agent_name": agent["agent_name"],
        "role": agent["role"]
    })


@app.route("/api/active", methods=["GET"])
@require_auth
def get_active():
    """Proxy HaloPSA report data."""
    if not HALOPSA_REPORT_URL:
        return jsonify({"error": "HaloPSA not configured"}), 503
    headers = {"Accept": "application/json"}
    if HALOPSA_BEARER_TOKEN:
        headers["Authorization"] = f"Bearer {HALOPSA_BEARER_TOKEN}"
    try:
        resp = requests.get(HALOPSA_REPORT_URL, headers=headers, timeout=30)
        resp.raise_for_status()
        return jsonify(resp.json())
    except requests.RequestException as e:
        return jsonify({"error": str(e)}), 502


@app.route("/api/ai", methods=["POST"])
@require_auth
def proxy_ai():
    """Proxy Anthropic API calls — API key stays server-side."""
    if not ANTHROPIC_API_KEY:
        return jsonify({"error": "Anthropic API key not configured"}), 503
    body = request.get_json(silent=True) or {}
    headers = {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
    }
    try:
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers=headers,
            json=body,
            timeout=60
        )
        return (resp.content, resp.status_code, {"Content-Type": "application/json"})
    except requests.RequestException as e:
        return jsonify({"error": str(e)}), 502


@app.route("/api/baselines", methods=["GET"])
@require_auth
def get_baselines():
    """Serve BL_CC / BL_CAT baselines (no client names in the HTML)."""
    return jsonify(BASELINES)


@app.route("/api/robots", methods=["GET"])
@require_auth
def get_all_robots():
    """Load all robot configs."""
    resp = supabase_request("GET", "agent_robots", params={"select": "*"})
    if resp.status_code != 200:
        return jsonify({"error": "Failed to load robots"}), 502
    return jsonify(resp.json())


@app.route("/api/robot", methods=["GET"])
@require_auth
def get_robot():
    """Load robot config for a specific agent."""
    agent = request.args.get("agent", request.user.get("agent_name", ""))
    resp = supabase_request("GET", "agent_robots", params={
        "select": "*",
        "agent_name": f"eq.{agent}",
        "limit": "1"
    })
    if resp.status_code != 200:
        return jsonify({"error": "Failed to load robot config"}), 502
    rows = resp.json()
    return jsonify(rows[0] if rows else None)


@app.route("/api/robot", methods=["POST"])
@require_auth
def save_robot():
    """Save robot config — agents can only save their own."""
    body = request.get_json(silent=True) or {}
    agent_name = request.user.get("agent_name", "")
    body["agent_name"] = agent_name
    resp = supabase_request("POST", "agent_robots", params={
        "on_conflict": "agent_name"
    }, body=body)
    if resp.status_code not in (200, 201):
        return jsonify({"error": "Failed to save robot config"}), 502
    return jsonify({"ok": True})


@app.route("/api/admins", methods=["GET"])
@require_auth
def get_admins():
    """Get list of admin agent names."""
    resp = supabase_request("GET", "agent_logins", params={
        "select": "agent_name",
        "role": "eq.admin"
    })
    if resp.status_code != 200:
        return jsonify({"error": "Failed to load admins"}), 502
    return jsonify([r["agent_name"] for r in resp.json() if r.get("agent_name")])


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8090))
    app.run(host="0.0.0.0", port=port)
