#!/usr/bin/env python3
"""
Service Hub Proxy Server (Render-hosted)
========================================
All secrets are stored as environment variables on Render.
Authenticates users via Supabase, issues JWT tokens,
and gates all data endpoints behind auth.
"""

import os
import time
import requests
from collections import defaultdict
from functools import wraps
from flask import Flask, request, jsonify, make_response
from flask_cors import CORS
import jwt

app = Flask(__name__)

# ═══════════════════════════════════════════════════════════
# CONFIGURATION — All from environment variables
# ═══════════════════════════════════════════════════════════

HALOPSA_REPORT_URL = os.environ.get("HALOPSA_REPORT_URL", "")
HALO_BEARER_TOKEN = os.environ.get("HALO_BEARER_TOKEN", "")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
JWT_SECRET = os.environ.get("JWT_SECRET", "change-me-in-production")
WIDGET_KEY = os.environ.get("WIDGET_KEY", "")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "https://king-kirratoy.github.io")

# Allowed origins for CORS and X-Frame-Options
ALLOWED_ORIGINS = [
    ALLOWED_ORIGIN,
]
CORS(app, origins=ALLOWED_ORIGINS, supports_credentials=True,
     allow_headers=["Content-Type", "Authorization"],
     methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])

# ═══════════════════════════════════════════════════════════
# PREFLIGHT — Explicit OPTIONS handler for all /api/* routes
# ═══════════════════════════════════════════════════════════

@app.before_request
def handle_preflight():
    if request.method == "OPTIONS":
        origin = request.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            response = make_response()
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
            response.headers["Access-Control-Allow-Credentials"] = "true"
            response.headers["Access-Control-Max-Age"] = "3600"
            return response

# ═══════════════════════════════════════════════════════════
# X-FRAME-OPTIONS — Only allow embedding from allowed origin
# ═══════════════════════════════════════════════════════════

ALLOWED_FRAME_ANCESTOR = os.environ.get("ALLOWED_FRAME_ANCESTOR", ALLOWED_ORIGIN)

@app.after_request
def set_security_headers(response):
    response.headers["Content-Security-Policy"] = f"frame-ancestors 'self' {ALLOWED_FRAME_ANCESTOR}"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response

# ═══════════════════════════════════════════════════════════
# RATE LIMITING — Login endpoint brute-force protection
# ═══════════════════════════════════════════════════════════

LOGIN_ATTEMPTS = defaultdict(list)  # ip -> [timestamps]
MAX_LOGIN_ATTEMPTS = 5
LOGIN_WINDOW = 300  # 5 minutes

# ═══════════════════════════════════════════════════════════
# AUTH HELPERS
# ═══════════════════════════════════════════════════════════

def create_token(agent_name, role, original_iat=None):
    payload = {
        "agent_name": agent_name,
        "role": role,
        "iat": int(time.time()),
        "exp": int(time.time()) + 86400,  # 24 hour expiry
        "original_iat": original_iat or int(time.time())
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
        resp = requests.get(url, headers=headers, params=params, timeout=15)
    elif method == "POST":
        headers["Prefer"] = "resolution=merge-duplicates,return=representation"
        resp = requests.post(url, headers=headers, params=params, json=body, timeout=15)
    else:
        resp = requests.request(method, url, headers=headers, params=params, json=body, timeout=15)
    return resp


# ═══════════════════════════════════════════════════════════
# ROUTES
# ═══════════════════════════════════════════════════════════

def check_rate_limit(ip):
    """Returns True if the IP is rate-limited."""
    now = time.time()
    # Prune old attempts outside the window
    LOGIN_ATTEMPTS[ip] = [t for t in LOGIN_ATTEMPTS[ip] if now - t < LOGIN_WINDOW]
    return len(LOGIN_ATTEMPTS[ip]) >= MAX_LOGIN_ATTEMPTS


@app.route("/api/login", methods=["POST"])
def login():
    ip = request.headers.get("X-Forwarded-For", request.remote_addr)
    if check_rate_limit(ip):
        return jsonify({"error": "Too many login attempts. Try again in a few minutes."}), 429

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
        LOGIN_ATTEMPTS[ip].append(time.time())
        remaining = MAX_LOGIN_ATTEMPTS - len(LOGIN_ATTEMPTS[ip])
        return jsonify({"error": f"Invalid password. {remaining} attempts remaining."}), 401

    agent = rows[0]
    token = create_token(agent["agent_name"], agent["role"])
    return jsonify({
        "token": token,
        "agent_name": agent["agent_name"],
        "role": agent["role"]
    })


@app.route("/api/widget-auth", methods=["POST"])
def widget_auth():
    """Auto-login for HaloPSA iframe widget using a shared widget key."""
    if not WIDGET_KEY:
        return jsonify({"error": "Widget auth not configured"}), 503

    data = request.get_json(silent=True) or {}
    key = data.get("key", "").strip()
    if not key or key != WIDGET_KEY:
        return jsonify({"error": "Invalid widget key"}), 401

    # Issue a token for a generic widget viewer (agent role, no specific agent)
    token = create_token("Widget Viewer", "agent")
    return jsonify({
        "token": token,
        "agent_name": "Widget Viewer",
        "role": "agent"
    })


@app.route("/api/active", methods=["GET"])
@require_auth
def get_active():
    """Proxy HaloPSA report data."""
    if not HALOPSA_REPORT_URL:
        return jsonify({"error": "HaloPSA not configured"}), 503
    headers = {"Accept": "application/json"}
    if HALO_BEARER_TOKEN:
        headers["Authorization"] = f"Bearer {HALO_BEARER_TOKEN}"
    try:
        resp = requests.get(HALOPSA_REPORT_URL, headers=headers, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        # Strip sensitive fields before sending to client
        STRIP_FIELDS = {"Client", "End_User", "Summary", "Shift"}
        if isinstance(data, list):
            for row in data:
                for field in STRIP_FIELDS:
                    row.pop(field, None)
        elif isinstance(data, dict):
            # Handle wrapped response formats (e.g. {"report": [...]})
            for key, val in data.items():
                if isinstance(val, list):
                    for row in val:
                        if isinstance(row, dict):
                            for field in STRIP_FIELDS:
                                row.pop(field, None)
        return jsonify(data)
    except requests.RequestException:
        return jsonify({"error": "Failed to fetch data from upstream service"}), 502


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


@app.route("/api/commanders", methods=["GET"])
@require_auth
def get_commanders():
    """Get list of commander agent names."""
    resp = supabase_request("GET", "agent_logins", params={
        "select": "agent_name",
        "role": "eq.admin"
    })
    if resp.status_code != 200:
        return jsonify({"error": "Failed to load commanders"}), 502
    return jsonify([r["agent_name"] for r in resp.json() if r.get("agent_name")])


@app.route("/api/refresh", methods=["POST"])
@require_auth
def refresh_token():
    """Issue a fresh JWT if the current one is still valid."""
    agent_name = request.user.get("agent_name", "")
    role = request.user.get("role", "")
    # Cap refresh chains at 7 days from original login
    original_iat = request.user.get("original_iat", request.user.get("iat", 0))
    if int(time.time()) - original_iat > 604800:  # 7 days
        return jsonify({"error": "Session expired. Please log in again."}), 401
    token = create_token(agent_name, role, original_iat=original_iat)
    return jsonify({"token": token})


# ═══════════════════════════════════════════════════════════
# COMMS BOARD — Cards & Reactions
# ═══════════════════════════════════════════════════════════

@app.route("/api/comms-cards", methods=["GET"])
@require_auth
def get_comms_cards():
    """Get all comms cards with their reactions."""
    cards_resp = supabase_request("GET", "comms_cards", params={
        "select": "*",
        "order": "created_at.asc"
    })
    if cards_resp.status_code != 200:
        return jsonify({"error": "Failed to load cards"}), 502
    cards = cards_resp.json()

    # Load all reactions
    reactions_resp = supabase_request("GET", "comms_reactions", params={
        "select": "id,card_id,agent_name,emoji"
    })
    reactions = reactions_resp.json() if reactions_resp.status_code == 200 else []

    # Attach reactions to cards
    react_map = {}
    for rx in reactions:
        cid = rx.get("card_id")
        if cid not in react_map:
            react_map[cid] = []
        react_map[cid].append(rx)

    for card in cards:
        card["reactions"] = react_map.get(card["id"], [])

    return jsonify(cards)


@app.route("/api/comms-cards", methods=["POST"])
@require_auth
def create_comms_card():
    """Create a new comms card."""
    body = request.get_json(silent=True) or {}
    agent_name = request.user.get("agent_name", "")
    if not agent_name or agent_name == "Widget Viewer":
        return jsonify({"error": "Must be logged in as an agent"}), 403

    grid_row = body.get("grid_row")
    grid_col = body.get("grid_col")
    if grid_row is None or grid_col is None:
        return jsonify({"error": "Grid position required"}), 400
    if not (0 <= grid_row <= 9 and 0 <= grid_col <= 4):
        return jsonify({"error": "Invalid grid position"}), 400

    # Check slot is not occupied
    check = supabase_request("GET", "comms_cards", params={
        "select": "id",
        "grid_row": f"eq.{grid_row}",
        "grid_col": f"eq.{grid_col}",
        "limit": "1"
    })
    if check.status_code == 200 and check.json():
        return jsonify({"error": "Slot already occupied"}), 409

    card = {
        "agent_name": agent_name,
        "grid_row": grid_row,
        "grid_col": grid_col,
        "title": (body.get("title") or "")[:80],
        "body": (body.get("body") or "")[:500],
        "icon": body.get("icon", "none"),
        "bg_color": body.get("bg_color", "navy"),
        "border_color": body.get("border_color", "blue"),
    }
    resp = supabase_request("POST", "comms_cards", body=card)
    if resp.status_code not in (200, 201):
        return jsonify({"error": "Failed to create card"}), 502
    return jsonify(resp.json()[0] if resp.json() else {"ok": True}), 201


@app.route("/api/comms-cards/<card_id>", methods=["PUT"])
@require_auth
def update_comms_card(card_id):
    """Update a comms card — only the author can edit."""
    agent_name = request.user.get("agent_name", "")
    body = request.get_json(silent=True) or {}

    # Verify ownership
    check = supabase_request("GET", "comms_cards", params={
        "select": "agent_name",
        "id": f"eq.{card_id}",
        "limit": "1"
    })
    if check.status_code != 200 or not check.json():
        return jsonify({"error": "Card not found"}), 404
    if check.json()[0]["agent_name"] != agent_name:
        return jsonify({"error": "Not authorized"}), 403

    updates = {}
    if "title" in body:
        updates["title"] = (body["title"] or "")[:80]
    if "body" in body:
        updates["body"] = (body["body"] or "")[:500]
    if "icon" in body:
        updates["icon"] = body["icon"]
    if "bg_color" in body:
        updates["bg_color"] = body["bg_color"]
    if "border_color" in body:
        updates["border_color"] = body["border_color"]

    if not updates:
        return jsonify({"error": "Nothing to update"}), 400

    resp = supabase_request("PATCH", "comms_cards", params={
        "id": f"eq.{card_id}"
    }, body=updates)
    if resp.status_code not in (200, 204):
        return jsonify({"error": "Failed to update card"}), 502
    return jsonify({"ok": True})


@app.route("/api/comms-cards/<card_id>", methods=["DELETE"])
@require_auth
def delete_comms_card(card_id):
    """Delete a comms card — author or commander only."""
    agent_name = request.user.get("agent_name", "")
    role = request.user.get("role", "")

    # Verify ownership or commander
    check = supabase_request("GET", "comms_cards", params={
        "select": "agent_name",
        "id": f"eq.{card_id}",
        "limit": "1"
    })
    if check.status_code != 200 or not check.json():
        return jsonify({"error": "Card not found"}), 404
    if check.json()[0]["agent_name"] != agent_name and role != "admin":
        return jsonify({"error": "Not authorized"}), 403

    # Delete reactions first
    supabase_request("DELETE", "comms_reactions", params={
        "card_id": f"eq.{card_id}"
    })
    # Delete the card
    resp = supabase_request("DELETE", "comms_cards", params={
        "id": f"eq.{card_id}"
    })
    if resp.status_code not in (200, 204):
        return jsonify({"error": "Failed to delete card"}), 502
    return jsonify({"ok": True})


@app.route("/api/comms-reactions", methods=["POST"])
@require_auth
def toggle_comms_reaction():
    """Toggle a reaction on a card (add if not exists, remove if exists)."""
    agent_name = request.user.get("agent_name", "")
    if not agent_name or agent_name == "Widget Viewer":
        return jsonify({"error": "Must be logged in as an agent"}), 403

    body = request.get_json(silent=True) or {}
    card_id = body.get("card_id")
    emoji = body.get("emoji", "")
    if not card_id or not emoji:
        return jsonify({"error": "card_id and emoji required"}), 400

    # Check if reaction already exists
    check = supabase_request("GET", "comms_reactions", params={
        "select": "id",
        "card_id": f"eq.{card_id}",
        "agent_name": f"eq.{agent_name}",
        "emoji": f"eq.{emoji}",
        "limit": "1"
    })
    if check.status_code == 200 and check.json():
        # Remove existing reaction
        rx_id = check.json()[0]["id"]
        supabase_request("DELETE", "comms_reactions", params={
            "id": f"eq.{rx_id}"
        })
        return jsonify({"action": "removed"})
    else:
        # Add new reaction
        resp = supabase_request("POST", "comms_reactions", body={
            "card_id": card_id,
            "agent_name": agent_name,
            "emoji": emoji
        })
        if resp.status_code not in (200, 201):
            return jsonify({"error": "Failed to add reaction"}), 502
        return jsonify({"action": "added"})


@app.route("/api/agent-schedules", methods=["GET"])
@require_auth
def get_agent_schedules():
    resp = supabase_request("GET", "agent_schedules", params={"select": "*"})
    if resp.status_code != 200:
        return jsonify({"error": "Failed to fetch schedules"}), 502
    return jsonify(resp.json())


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8090))
    app.run(host="0.0.0.0", port=port)
