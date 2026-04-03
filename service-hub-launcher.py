#!/usr/bin/env python3
"""
Service Hub Proxy Server (Render-hosted)
========================================
All secrets are stored as environment variables on Render.
Authenticates users via Supabase Auth (GoTrue), returns real
Supabase sessions, and gates all data endpoints behind auth.
"""

import logging
import os
import re
import time
import uuid
import requests
from functools import wraps
from flask import Flask, request, jsonify, make_response
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.middleware.proxy_fix import ProxyFix
import jwt

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# ═══════════════════════════════════════════════════════════
# CONFIGURATION — All from environment variables
# ═══════════════════════════════════════════════════════════

HALOPSA_REPORT_URL = os.environ.get("HALOPSA_REPORT_URL", "")
HALO_BEARER_TOKEN = os.environ.get("HALO_BEARER_TOKEN", "")
HALO_TICKET_BASE_URL = os.environ.get("HALO_TICKET_BASE_URL", "")  # e.g. https://yourco.halopsa.com/tickets/
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")  # service_role key
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
SUPABASE_JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET", "")
JWT_SECRET = os.environ.get("JWT_SECRET", "")  # legacy — kept for fallback
if not SUPABASE_JWT_SECRET and not JWT_SECRET:
    log.warning("No JWT secret configured — authentication will fail")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "https://king-kirratoy.github.io")

# Allowed origins for CORS and X-Frame-Options
ALLOWED_ORIGINS = [
    ALLOWED_ORIGIN,
]
CORS(app, origins=ALLOWED_ORIGINS, supports_credentials=True,
     allow_headers=["Content-Type", "Authorization"],
     methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])

limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=["120 per minute"],
    storage_uri="memory://",
)

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
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
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
# AUTH HELPERS
# ═══════════════════════════════════════════════════════════

AUTH_EMAIL_DOMAIN = "hub.internal"
# Fixed namespace for deterministic UUID5 generation.
_EMAIL_NS = uuid.UUID("a1b2c3d4-e5f6-7890-abcd-ef1234567890")


def agent_email(name):
    """Convert agent name to a collision-free synthetic email for Supabase Auth.

    Uses UUID5 (SHA-1 hash of namespace + lowercased name) so that two names
    that reduce to the same slug (e.g. 'Alice Smith' vs 'Alice-Smith') still
    produce distinct emails, while the same name always produces the same email.
    """
    local = uuid.uuid5(_EMAIL_NS, name.lower())
    return f"{local}@{AUTH_EMAIL_DOMAIN}"


def gotrue_request(method, path, body=None, admin=False):
    """Make a request to the Supabase GoTrue (Auth) API."""
    url = f"{SUPABASE_URL}/auth/v1{path}"
    key = SUPABASE_KEY if admin else (SUPABASE_ANON_KEY or SUPABASE_KEY)
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    resp = requests.request(method, url, headers=headers, json=body, timeout=15)
    return resp


def gotrue_sign_in(email, password):
    """Sign in a user via Supabase GoTrue and return the session."""
    return gotrue_request("POST", "/token?grant_type=password", body={
        "email": email,
        "password": password,
    })


def gotrue_create_user(email, password, agent_name, role):
    """Create a Supabase Auth user via the Admin API."""
    return gotrue_request("POST", "/admin/users", admin=True, body={
        "email": email,
        "password": password,
        "email_confirm": True,
        "app_metadata": {
            "agent_name": agent_name,
            "role": role,
        },
    })


def create_token(agent_name, role, original_iat=None):
    """Legacy token creation — fallback when GoTrue sign-in is unavailable."""
    secret = JWT_SECRET or SUPABASE_JWT_SECRET
    payload = {
        "agent_name": agent_name,
        "role": role,
        "iat": int(time.time()),
        "exp": int(time.time()) + 86400,
        "original_iat": original_iat or int(time.time())
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def _fetch_jwks():
    """Fetch JWKS public keys from Supabase for ES256 verification."""
    if not SUPABASE_URL:
        return None
    try:
        resp = requests.get(f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json", timeout=10)
        if resp.status_code == 200:
            from jwt import PyJWKSet
            return PyJWKSet.from_dict(resp.json())
    except Exception as e:
        log.warning("Failed to fetch JWKS: %s", e)
    return None

_jwks_cache = {"keys": None, "fetched_at": 0}

def _get_jwks():
    """Return cached JWKS, refreshing every 5 minutes."""
    now = time.time()
    if _jwks_cache["keys"] is None or now - _jwks_cache["fetched_at"] > 300:
        keys = _fetch_jwks()
        if keys is not None:
            _jwks_cache["keys"] = keys
            _jwks_cache["fetched_at"] = now
    return _jwks_cache["keys"]


def _decode_supabase_jwt(token):
    """Decode a Supabase-issued JWT and return a normalized user dict."""
    # Peek at the token header to determine algorithm
    header = jwt.get_unverified_header(token)
    alg = header.get("alg", "HS256")

    if alg.startswith("ES") or alg.startswith("RS") or alg.startswith("PS"):
        # Asymmetric algorithm — verify with JWKS public key
        jwks = _get_jwks()
        if jwks is None:
            raise jwt.InvalidTokenError("Could not fetch JWKS for asymmetric token")
        kid = header.get("kid")
        jwk = jwks[kid] if kid else jwks.keys[0]
        payload = jwt.decode(
            token, jwk.key, algorithms=[alg],
            audience="authenticated",
        )
    else:
        # Symmetric (HS256) — verify with JWT secret
        payload = jwt.decode(
            token, SUPABASE_JWT_SECRET, algorithms=["HS256"],
            audience="authenticated",
        )

    meta = payload.get("app_metadata", {})
    return {
        "agent_name": meta.get("agent_name", ""),
        "role": meta.get("role", ""),
        "sub": payload.get("sub", ""),
        "email": payload.get("email", ""),
    }


def _decode_legacy_jwt(token):
    """Decode a legacy (custom-signed) JWT."""
    secret = JWT_SECRET or SUPABASE_JWT_SECRET
    # Legacy tokens have no audience claim, so skip audience verification
    # explicitly rather than relying on library defaults.
    payload = jwt.decode(token, secret, algorithms=["HS256"], options={"verify_aud": False})
    return {
        "agent_name": payload.get("agent_name", ""),
        "role": payload.get("role", ""),
        "original_iat": payload.get("original_iat"),
        "iat": payload.get("iat"),
    }


def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        # CSRF guard: reject state-changing requests from unexpected origins.
        # Browsers auto-send cookies cross-origin, so we verify the Origin header.
        if request.method not in ("GET", "OPTIONS"):
            origin = request.headers.get("Origin", "")
            if origin and origin not in ALLOWED_ORIGINS:
                return jsonify({"error": "Forbidden"}), 403

        # Cookie-first; fall back to Authorization header (backwards compat)
        token = request.cookies.get("hub_token")
        if not token:
            auth_header = request.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                token = auth_header[7:]
        if not token:
            return jsonify({"error": "Not authenticated"}), 401
        # Supabase JWT only
        user = None
        is_supabase_jwt = False
        if SUPABASE_JWT_SECRET:
            try:
                user = _decode_supabase_jwt(token)
                is_supabase_jwt = True
                log.info("Supabase JWT decode OK for %s", request.path)
            except jwt.ExpiredSignatureError:
                return jsonify({"error": "Token expired"}), 401
            except jwt.InvalidTokenError as e:
                log.warning("Supabase JWT decode failed for %s: %s", request.path, e)
        if user is None:
            log.warning("Auth REJECTED %s — token[:40]: %s, JWT_SECRET set: %s, SUPABASE_JWT_SECRET set: %s",
                        request.path, token[:40] if token else "(empty)", bool(JWT_SECRET), bool(SUPABASE_JWT_SECRET))
            return jsonify({"error": "Invalid or expired token"}), 401
        request.user = user
        # Expose the raw token for user-scoped Supabase calls (RLS enforcement).
        # Only set for Supabase JWTs — legacy tokens are not recognised by Supabase RLS
        # so those routes fall back to the service role key as before.
        request.auth_token = token if is_supabase_jwt else None
        return f(*args, **kwargs)
    return decorated


def _set_auth_cookies(response, session):
    """Attach HttpOnly auth cookies to a response."""
    response.set_cookie(
        "hub_token", session["access_token"],
        httponly=True, secure=True, samesite="None",
        max_age=session.get("expires_in", 3600),
    )
    response.set_cookie(
        "hub_refresh", session["refresh_token"],
        httponly=True, secure=True, samesite="None",
        max_age=60 * 60 * 24 * 7,  # 7 days
    )


def _clear_auth_cookies(response):
    """Remove auth cookies from a response."""
    response.set_cookie("hub_token", "", httponly=True, secure=True, samesite="None", max_age=0)
    response.set_cookie("hub_refresh", "", httponly=True, secure=True, samesite="None", max_age=0)


def supabase_request(method, table, params=None, body=None, auth_token=None):
    """Make a request to the Supabase REST API.

    Pass auth_token (the caller's Supabase JWT) for user-scoped write operations
    so that Supabase RLS policies are enforced when enabled. Omit it for
    admin operations and cross-agent reads that require the service role key.
    """
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    if auth_token:
        # User-scoped: anon key + user JWT — RLS policies apply
        api_key = SUPABASE_ANON_KEY or SUPABASE_KEY
        bearer = auth_token
    else:
        # Admin / cross-agent: service role key bypasses RLS
        api_key = SUPABASE_KEY
        bearer = SUPABASE_KEY
    headers = {
        "apikey": api_key,
        "Authorization": f"Bearer {bearer}",
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

@app.route("/api/login", methods=["POST"])
@limiter.limit("5 per 5 minutes")
def login():
    data = request.get_json(silent=True) or {}
    agent_name = data.get("agent_name", "").strip()
    password = data.get("password", "").strip()
    if not agent_name or not password:
        return jsonify({"error": "Name and password required"}), 400

    # Look up agent by name only — password is never used as a query parameter
    resp = supabase_request("GET", "agent_logins", params={
        "select": "agent_name,role",
        "agent_name": f"eq.{agent_name}",
        "limit": "1"
    })
    if resp.status_code != 200:
        return jsonify({"error": "Auth service unavailable"}), 503

    rows = resp.json()
    if not rows:
        log.warning("Failed login attempt from IP %s (unknown agent: %s)", request.remote_addr, agent_name)
        return jsonify({"error": "Invalid name or password"}), 401

    agent = rows[0]
    email = agent_email(agent["agent_name"])

    # Supabase GoTrue verifies the password
    auth_resp = gotrue_sign_in(email, password)
    log.info("GoTrue sign-in for %s → status %d", agent["agent_name"], auth_resp.status_code)
    if auth_resp.status_code == 200:
        session = auth_resp.json()
        log.info("Supabase Auth login: %s", agent["agent_name"])
        response = make_response(jsonify({
            "agent_name": agent["agent_name"],
            "role": agent["role"],
            "expires_in": session.get("expires_in", 3600),
        }))
        _set_auth_cookies(response, session)
        return response

    log.warning("Failed login for %s from IP %s (GoTrue status %d)",
                agent["agent_name"], request.remote_addr, auth_resp.status_code)
    return jsonify({"error": "Invalid name or password"}), 401



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
@limiter.limit("30 per minute")
def save_robot():
    """Save robot config — agents can only save their own."""
    body = request.get_json(silent=True) or {}
    agent_name = request.user.get("agent_name", "")
    body["agent_name"] = agent_name
    resp = supabase_request("POST", "agent_robots", params={
        "on_conflict": "agent_name"
    }, body=body, auth_token=request.auth_token)
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
    """Refresh a Supabase session using the hub_refresh cookie."""
    refresh_tok = request.cookies.get("hub_refresh")

    # Supabase refresh path
    if refresh_tok:
        resp = gotrue_request("POST", "/token?grant_type=refresh_token", body={
            "refresh_token": refresh_tok,
        })
        if resp.status_code == 200:
            session = resp.json()
            response = make_response(jsonify({"ok": True}))
            _set_auth_cookies(response, session)
            return response
        return jsonify({"error": "Refresh failed — please log in again."}), 401

    # Legacy refresh fallback (no refresh cookie present)
    agent_name = request.user.get("agent_name", "")
    role = request.user.get("role", "")
    original_iat = request.user.get("original_iat", request.user.get("iat", 0))
    if original_iat and int(time.time()) - original_iat > 604800:
        return jsonify({"error": "Session expired. Please log in again."}), 401
    token = create_token(agent_name, role, original_iat=original_iat)
    return jsonify({"token": token})


# ═══════════════════════════════════════════════════════════
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
@limiter.limit("30 per minute")
def create_comms_card():
    """Create a new comms card."""
    body = request.get_json(silent=True) or {}
    agent_name = request.user.get("agent_name", "")
    if not agent_name or agent_name == "Widget Viewer":
        return jsonify({"error": "Must be logged in as an agent"}), 403

    try:
        grid_row = int(body.get("grid_row"))
        grid_col = int(body.get("grid_col"))
    except (TypeError, ValueError):
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
    resp = supabase_request("POST", "comms_cards", body=card, auth_token=request.auth_token)
    if resp.status_code not in (200, 201):
        return jsonify({"error": "Failed to create card"}), 502
    return jsonify(resp.json()[0] if resp.json() else {"ok": True}), 201


@app.route("/api/comms-cards/<card_id>", methods=["PUT"])
@require_auth
@limiter.limit("30 per minute")
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
    }, body=updates, auth_token=request.auth_token)
    if resp.status_code not in (200, 204):
        return jsonify({"error": "Failed to update card"}), 502
    return jsonify({"ok": True})


@app.route("/api/comms-cards/<card_id>", methods=["DELETE"])
@require_auth
@limiter.limit("30 per minute")
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
    # Delete the card — service role key so commanders can delete any card
    resp = supabase_request("DELETE", "comms_cards", params={
        "id": f"eq.{card_id}"
    })
    if resp.status_code not in (200, 204):
        return jsonify({"error": "Failed to delete card"}), 502
    return jsonify({"ok": True})


@app.route("/api/comms-reactions", methods=["POST"])
@require_auth
@limiter.limit("60 per minute")
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
    if len(emoji) > 32:
        return jsonify({"error": "Invalid emoji"}), 400

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
        }, auth_token=request.auth_token)
        return jsonify({"action": "removed"})
    else:
        # Add new reaction
        resp = supabase_request("POST", "comms_reactions", body={
            "card_id": card_id,
            "agent_name": agent_name,
            "emoji": emoji
        }, auth_token=request.auth_token)
        if resp.status_code not in (200, 201):
            return jsonify({"error": "Failed to add reaction"}), 502
        return jsonify({"action": "added"})


@app.route("/api/agent-schedules", methods=["GET"])
@require_auth
def get_agent_schedules():
    """Return all agent schedule preferences."""
    resp = supabase_request("GET", "agent_schedules", params={"select": "*"})
    if resp.status_code != 200:
        return jsonify({"error": "Failed to fetch schedules"}), 502
    return jsonify(resp.json())


@app.route("/api/agent-schedules", methods=["PATCH"])
@require_auth
def update_agent_schedule():
    """Upsert an agent's shift/lunch schedule preference."""
    data = request.get_json(silent=True) or {}
    agent_name = (data.get("agent_name") or "").strip()
    if not agent_name:
        return jsonify({"error": "agent_name required"}), 400

    update_body = {}
    if data.get("lunch_slot") is not None:
        update_body["lunch_slot"] = int(data["lunch_slot"])
    if data.get("shift_slot") is not None:
        update_body["shift_slot"] = int(data["shift_slot"])
    if not update_body:
        return jsonify({"error": "No fields to update"}), 400

    # Try to update an existing row first
    patch_resp = supabase_request(
        "PATCH", "agent_schedules",
        params={"agent_name": f"eq.{agent_name}"},
        body=update_body
    )
    if patch_resp.status_code not in (200, 204):
        return jsonify({"error": "Failed to update schedule"}), 502

    result = patch_resp.json() if patch_resp.content and patch_resp.status_code == 200 else []
    if not result:
        # No existing row — insert a new one
        insert_body = {"agent_name": agent_name, **update_body}
        post_resp = supabase_request("POST", "agent_schedules", body=insert_body)
        if post_resp.status_code not in (200, 201):
            return jsonify({"error": "Failed to insert schedule"}), 502
        return jsonify(post_resp.json())

    return jsonify(result)


@app.route("/api/ticket-overrides", methods=["GET"])
@require_auth
def get_ticket_overrides():
    """Return all ticket calendar position/size overrides."""
    resp = supabase_request("GET", "ticket_overrides", params={"select": "*"})
    if resp.status_code != 200:
        return jsonify({"error": "Failed to fetch overrides"}), 502
    return jsonify(resp.json())


@app.route("/api/ticket-overrides", methods=["POST"])
@require_auth
@limiter.limit("120 per minute")
def upsert_ticket_override():
    """Upsert a ticket calendar override by ticket_id."""
    data = request.get_json(silent=True) or {}
    ticket_id = (data.get("ticket_id") or "").strip()
    if not ticket_id:
        return jsonify({"error": "ticket_id required"}), 400

    row = {"ticket_id": ticket_id}
    if data.get("day_idx") is not None:
        row["day_idx"] = int(data["day_idx"])
    if data.get("start_hour") is not None:
        row["start_hour"] = float(data["start_hour"])
    if data.get("est") is not None:
        row["est"] = float(data["est"])

    resp = supabase_request("POST", "ticket_overrides", params={
        "on_conflict": "ticket_id"
    }, body=row)
    if resp.status_code not in (200, 201):
        return jsonify({"error": "Failed to save override"}), 502
    return jsonify({"ok": True})


@app.route("/api/ticket-overrides/<path:ticket_id>", methods=["DELETE"])
@require_auth
@limiter.limit("120 per minute")
def delete_ticket_override(ticket_id):
    """Delete a specific ticket override."""
    resp = supabase_request("DELETE", "ticket_overrides", params={
        "ticket_id": f"eq.{ticket_id}"
    })
    if resp.status_code not in (200, 204):
        return jsonify({"error": "Failed to delete override"}), 502
    return jsonify({"ok": True})


@app.route("/api/time-blocks", methods=["GET"])
@require_auth
def get_time_blocks():
    """Return all calendar time blocks."""
    resp = supabase_request("GET", "calendar_time_blocks", params={"select": "*"})
    if resp.status_code != 200:
        return jsonify({"error": "Failed to fetch time blocks"}), 502
    return jsonify(resp.json())


@app.route("/api/time-blocks", methods=["POST"])
@require_auth
@limiter.limit("120 per minute")
def upsert_time_block():
    """Upsert a calendar time block by block_id."""
    data = request.get_json(silent=True) or {}
    block_id = (data.get("block_id") or "").strip()
    if not block_id:
        return jsonify({"error": "block_id required"}), 400

    row = {"block_id": block_id}
    if data.get("tech_id") is not None:
        row["tech_id"] = int(data["tech_id"])
    if data.get("day_idx") is not None:
        row["day_idx"] = int(data["day_idx"])
    if data.get("start_hour") is not None:
        row["start_hour"] = float(data["start_hour"])
    if data.get("est") is not None:
        row["est"] = float(data["est"])
    row["text"] = str(data.get("text") or "")

    resp = supabase_request("POST", "calendar_time_blocks", params={
        "on_conflict": "block_id"
    }, body=row)
    if resp.status_code not in (200, 201):
        return jsonify({"error": "Failed to save time block"}), 502
    return jsonify({"ok": True})


@app.route("/api/time-blocks/<path:block_id>", methods=["DELETE"])
@require_auth
@limiter.limit("120 per minute")
def delete_time_block_route(block_id):
    """Delete a specific time block."""
    resp = supabase_request("DELETE", "calendar_time_blocks", params={
        "block_id": f"eq.{block_id}"
    })
    if resp.status_code not in (200, 204):
        return jsonify({"error": "Failed to delete time block"}), 502
    return jsonify({"ok": True})


@app.route("/api/config", methods=["GET"])
def get_config():
    """Return public Supabase config for the frontend."""
    return jsonify({
        "supabase_url": SUPABASE_URL,
        "supabase_anon_key": SUPABASE_ANON_KEY,
    })


@app.route("/api/logout", methods=["POST"])
def logout():
    """Clear auth cookies and end the session."""
    response = make_response(jsonify({"ok": True}))
    _clear_auth_cookies(response)
    return response


@app.route("/api/me", methods=["GET"])
@require_auth
def get_me():
    """Return the current user's identity (used for session restore)."""
    return jsonify({
        "agent_name": request.user.get("agent_name", ""),
        "role": request.user.get("role", ""),
    })


@app.route("/api/ticket/<path:ticket_id>/open", methods=["GET"])
@require_auth
def open_ticket(ticket_id):
    """Return the full Halo ticket URL for an authenticated user to open.
    The base URL lives only in server env vars — never in frontend source."""
    if not HALO_TICKET_BASE_URL:
        return jsonify({"error": "Ticket URL not configured"}), 503
    ticket_id = ticket_id.strip()
    if not ticket_id:
        return jsonify({"error": "Invalid ticket ID"}), 400
    return jsonify({"url": f"{HALO_TICKET_BASE_URL}{ticket_id}"})


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8090))
    app.run(host="0.0.0.0", port=port)
