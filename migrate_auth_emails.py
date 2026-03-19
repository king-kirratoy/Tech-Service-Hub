#!/usr/bin/env python3
"""
migrate_auth_emails.py
======================
One-shot migration: update Supabase Auth user emails from the old
slug-based format (alice-smith@hub.internal) to the new UUID5-based
format (3f2504e0-...@hub.internal).

Usage
-----
    # Dry run (default) — prints what would change, touches nothing
    SUPABASE_URL=https://xxx.supabase.co \
    SUPABASE_KEY=service_role_key_here \
    python migrate_auth_emails.py

    # Apply changes
    SUPABASE_URL=https://xxx.supabase.co \
    SUPABASE_KEY=service_role_key_here \
    python migrate_auth_emails.py --apply

Requirements
------------
    pip install requests
"""

import argparse
import os
import re
import sys
import uuid

import requests

# ── Config ────────────────────────────────────────────────────────────────────

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")   # must be service_role key
AUTH_EMAIL_DOMAIN = "hub.internal"

# Must match the namespace defined in service-hub-launcher.py
_EMAIL_NS = uuid.UUID("a1b2c3d4-e5f6-7890-abcd-ef1234567890")

# ── Email helpers ─────────────────────────────────────────────────────────────

def old_email(name: str) -> str:
    """Reproduce the original slug-based email format."""
    slug = re.sub(r"[^a-z0-9-]", "", name.lower().replace(" ", "-"))
    return f"{slug}@{AUTH_EMAIL_DOMAIN}"


def new_email(name: str) -> str:
    """New UUID5-based email — collision-free."""
    local = uuid.uuid5(_EMAIL_NS, name.lower())
    return f"{local}@{AUTH_EMAIL_DOMAIN}"

# ── Supabase helpers ──────────────────────────────────────────────────────────

def admin_headers() -> dict:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


def fetch_agent_names() -> list[str]:
    """Return all agent names from the agent_logins table."""
    url = f"{SUPABASE_URL}/rest/v1/agent_logins"
    resp = requests.get(
        url,
        headers=admin_headers(),
        params={"select": "agent_name"},
        timeout=15,
    )
    resp.raise_for_status()
    return [row["agent_name"] for row in resp.json() if row.get("agent_name")]


def fetch_all_auth_users() -> list[dict]:
    """Return all Supabase Auth users via the GoTrue Admin API (handles pagination)."""
    users = []
    page = 1
    per_page = 1000
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/auth/v1/admin/users",
            headers=admin_headers(),
            params={"page": page, "per_page": per_page},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        # GoTrue returns {"users": [...], "aud": "..."}
        batch = data.get("users", [])
        users.extend(batch)
        if len(batch) < per_page:
            break
        page += 1
    return users


def update_user_email(user_id: str, email: str) -> None:
    """Update a GoTrue user's email address."""
    resp = requests.put(
        f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
        headers=admin_headers(),
        json={"email": email},
        timeout=15,
    )
    resp.raise_for_status()

# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually update emails (default is dry-run).",
    )
    args = parser.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        sys.exit("ERROR: SUPABASE_URL and SUPABASE_KEY environment variables are required.")

    mode = "APPLY" if args.apply else "DRY RUN"
    print(f"\n{'='*60}")
    print(f"  Auth Email Migration  [{mode}]")
    print(f"{'='*60}\n")

    print("Fetching agent names from agent_logins...")
    agent_names = fetch_agent_names()
    print(f"  Found {len(agent_names)} agent(s): {', '.join(agent_names)}\n")

    print("Fetching Supabase Auth users...")
    auth_users = fetch_all_auth_users()
    # Build a lookup by email for quick matching
    users_by_email = {u["email"]: u for u in auth_users if u.get("email")}
    print(f"  Found {len(auth_users)} Auth user(s)\n")

    results = {"updated": [], "already_correct": [], "not_found": []}

    for name in agent_names:
        old = old_email(name)
        new = new_email(name)

        if old == new:
            # Theoretically impossible but guard anyway
            results["already_correct"].append(name)
            continue

        user = users_by_email.get(old)
        if not user:
            # Check whether the new email already exists (already migrated)
            if new in users_by_email:
                results["already_correct"].append(name)
                print(f"  ✓ {name!r} — already migrated ({new})")
            else:
                results["not_found"].append(name)
                print(f"  ✗ {name!r} — no Auth user found at {old!r} or {new!r}")
            continue

        print(f"  → {name!r}")
        print(f"       old: {old}")
        print(f"       new: {new}")

        if args.apply:
            try:
                update_user_email(user["id"], new)
                print(f"       ✓ updated")
                results["updated"].append(name)
            except requests.HTTPError as exc:
                print(f"       ✗ FAILED: {exc.response.status_code} {exc.response.text}")
        else:
            print(f"       (skipped — dry run)")
            results["updated"].append(name)

    print(f"\n{'='*60}")
    print(f"  Summary")
    print(f"{'='*60}")
    print(f"  Would update / updated : {len(results['updated'])}")
    print(f"  Already on new format  : {len(results['already_correct'])}")
    print(f"  Auth user not found    : {len(results['not_found'])}")

    if results["not_found"]:
        print(f"\n  Agents with no matching Auth user:")
        for name in results["not_found"]:
            print(f"    - {name!r}  (expected: {old_email(name)})")
        print(f"\n  These agents may have been created outside the normal flow.")
        print(f"  Check the Supabase Auth dashboard and create/fix them manually.")

    if not args.apply and results["updated"]:
        print(f"\n  Run with --apply to commit these changes.")

    print()


if __name__ == "__main__":
    main()
