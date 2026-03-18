#!/usr/bin/env python3
"""
Service Hub Proxy
=================
A lightweight Flask proxy that forwards requests to HaloPSA
and adds CORS headers so the browser-hosted Service Hub can
call it directly — no local script needed.

Deploy this to Render as a Web Service (Python).

ENVIRONMENT VARIABLES (set in Render dashboard):
  HALO_BEARER_TOKEN   — Bearer token for HaloPSA report auth
  ALLOWED_ORIGIN      — Your GitHub Pages URL (e.g. https://king-kirratay.github.io)
  PROXY_SECRET        — A shared secret your HTML app must send as X-Proxy-Key header
"""

import os
import urllib.request
import urllib.error
import json
from flask import Flask, jsonify, request, abort
from flask_cors import CORS


# ═══════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════

# Pull secrets from environment — never hardcode these
BEARER_TOKEN  = os.environ.get('HALO_BEARER_TOKEN', '')
ALLOWED_ORIGIN = os.environ.get('ALLOWED_ORIGIN', '*')
PROXY_SECRET  = os.environ.get('PROXY_SECRET', '')

# Report name → HaloPSA URL mapping
# Add more entries here as needed
REPORTS = {
  'active': 'https://halo.lutz.us/api/ReportData/8204741a-585f-4f47-856f-344e5447d589',
}

# Port — Render sets $PORT automatically; fall back to 8090 for local testing
PORT = int(os.environ.get('PORT', 8090))


# ═══════════════════════════════════════════════════════════
# APP SETUP
# ═══════════════════════════════════════════════════════════

app = Flask(__name__)

# Apply CORS globally — handles preflight OPTIONS automatically
CORS(app, origins=ALLOWED_ORIGIN, allow_headers=[
  'Content-Type', 'X-Proxy-Key', 'x-api-key',
  'anthropic-version', 'anthropic-dangerous-direct-browser-access'
])


# ═══════════════════════════════════════════════════════════
# UTILS
# ═══════════════════════════════════════════════════════════

def cors_headers(response):
  """Belt-and-suspenders CORS headers on top of flask-cors."""
  response.headers['Access-Control-Allow-Origin']  = ALLOWED_ORIGIN
  response.headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
  response.headers['Access-Control-Allow-Headers'] = (
    'Content-Type, X-Proxy-Key, x-api-key, '
    'anthropic-version, anthropic-dangerous-direct-browser-access'
  )
  return response


def check_proxy_secret():
  """
  Reject requests that don't include the correct proxy secret header.
  Skipped if PROXY_SECRET is not configured (open mode — not recommended for prod).
  """
  if not PROXY_SECRET:
    return  # no secret configured — allow all (dev/testing only)
  if request.headers.get('X-Proxy-Key') != PROXY_SECRET:
    abort(403)


def fetch_from_halo(url):
  """Forward a GET request to HaloPSA and return the raw response bytes."""
  headers = {'Accept': 'application/json'}
  if BEARER_TOKEN:
    headers['Authorization'] = f'Bearer {BEARER_TOKEN}'

  req = urllib.request.Request(url, headers=headers)
  with urllib.request.urlopen(req) as resp:
    return resp.read()


# ═══════════════════════════════════════════════════════════
# ROUTES
# ═══════════════════════════════════════════════════════════

@app.route('/api', methods=['GET'])
def list_reports():
  """Health check — returns available report names."""
  resp = jsonify({'status': 'ok', 'reports': list(REPORTS.keys())})
  return cors_headers(resp)


@app.route('/api/<report_name>', methods=['GET'])
def proxy_report(report_name):
  """Proxy a named HaloPSA report to the browser."""
  check_proxy_secret()

  if report_name not in REPORTS:
    resp = jsonify({'error': f'Unknown report: {report_name}', 'available': list(REPORTS.keys())})
    resp.status_code = 404
    return cors_headers(resp)

  try:
    data = fetch_from_halo(REPORTS[report_name])
    resp = app.response_class(response=data, status=200, mimetype='application/json')
    return cors_headers(resp)

  except urllib.error.HTTPError as e:
    resp = jsonify({'error': f'HaloPSA returned {e.code}'})
    resp.status_code = e.code
    return cors_headers(resp)

  except Exception as e:
    resp = jsonify({'error': str(e)})
    resp.status_code = 500
    return cors_headers(resp)


@app.route('/api/<report_name>', methods=['OPTIONS'])
def options_report(report_name):
  """Handle CORS preflight requests."""
  resp = app.response_class(status=200)
  return cors_headers(resp)


# ═══════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════

if __name__ == '__main__':
  print()
  print('  ╔═══════════════════════════════════════╗')
  print('  ║        Service Hub Proxy              ║')
  print('  ╠═══════════════════════════════════════╣')
  print(f'  ║  Listening on port {PORT:<19}║')
  print(f'  ║  Allowed origin: {ALLOWED_ORIGIN[:21]:<21}║')
  print(f'  ║  Auth secret:  {"SET" if PROXY_SECRET else "NOT SET — OPEN":<23}║')
  print('  ╚═══════════════════════════════════════╝')
  print()

  for name, url in REPORTS.items():
    print(f'  📡 /api/{name} → {url[:50]}...')
  print()

  app.run(host='0.0.0.0', port=PORT)
