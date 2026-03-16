#!/usr/bin/env python3
"""
Service Hub Launcher
====================
Double-click this file to:
  1. Start a local server
  2. Fetch live data from HaloPSA
  3. Open Service Hub in your browser

SETUP:
  1. Put this file in the same folder as service-manager-hub.html
  2. Edit the report URL below if needed
  3. Double-click to run (or: python service-hub-launcher.py)

Press Ctrl+C in the terminal to stop.
"""

import http.server
import json
import urllib.request
import os
import sys
import webbrowser
import threading

# ═══════════════════════════════════════════════════════════
# CONFIGURATION — Edit these to match your HaloPSA setup
# ═══════════════════════════════════════════════════════════

REPORTS = {
    # Active tickets + closed-this-week report
    "active": "https://halo.lutz.us/api/ReportData/8204741a-585f-4f47-856f-344e5447d589",
}

# Bearer token for authenticated HaloPSA reports
# Leave as "" if reports are public (no auth needed)
BEARER_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkYklkIjoiNzg3QkM1RkMtM0IwMi00OTVGLTkxRDYtQzFCMkQzMTBDNUNBIiwicHJvZmlsZUlkIjoiMyIsIm5iZiI6MTc3MzE1MTAxOSwiZXhwIjoxMzA2MjIxNjk4MzksImlhdCI6MTc3MzE1MTAxOX0.wghQ6kJJ9aIIETZR2ugdLGRyhMBtxxfHyyrFXyuwRhk"

# Port for the local server
PORT = 8090

# Name of the HTML file (should be in the same folder)
HTML_FILE = "service-manager-hub.html"

# ═══════════════════════════════════════════════════════════
# SERVER — No need to edit below
# ═══════════════════════════════════════════════════════════

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SCRIPT_DIR, **kwargs)

    def do_GET(self):
        path = self.path.strip("/").split("?")[0]

        # Ignore favicon requests
        if path == "favicon.ico":
            self.send_response(204)
            self.end_headers()
            return

        # Serve HaloPSA report data
        if path.startswith("api/"):
            report_name = path[4:]  # strip "api/"
            if report_name in REPORTS:
                self.proxy_report(report_name)
                return
            else:
                self.send_json(404, {"error": f"Unknown report: {report_name}", "available": list(REPORTS.keys())})
                return

        # Serve API endpoint list
        if path == "api":
            self.send_json(200, {"status": "ok", "reports": list(REPORTS.keys())})
            return

        # Serve static files (HTML, etc.) normally
        super().do_GET()

    def do_OPTIONS(self):
        self.send_response(200)
        self.cors()
        self.end_headers()

    def proxy_report(self, name):
        url = REPORTS[name]
        try:
            headers = {"Accept": "application/json"}
            if BEARER_TOKEN:
                headers["Authorization"] = f"Bearer {BEARER_TOKEN}"
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req) as resp:
                data = resp.read()
                self.send_response(200)
                self.cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            self.send_json(e.code, {"error": f"HaloPSA returned {e.code}"})
        except Exception as e:
            self.send_json(500, {"error": str(e)})

    def send_json(self, code, data):
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access")

    def log_message(self, fmt, *args):
        try:
            msg = str(args[0]) if args else ""
            if "/api/" in msg:
                print(f"  [{self.log_date_time_string()}] {msg}")
        except Exception:
            pass


def main():
    print()
    print("  ╔═══════════════════════════════════════╗")
    print("  ║         Service Hub Launcher          ║")
    print("  ╠═══════════════════════════════════════╣")
    print("  ║  https://king-kirratoy.github.io/     ║")
    print("  ║  Tech-Service-Hub/index.html          ║")
    print("  ║                                       ║")
    print("  ║  Press Ctrl+C to stop                 ║")
    print("  ╚═══════════════════════════════════════╝")
    print()

    for name, url in REPORTS.items():
        print(f"  📡 /{name} → {url[:55]}...")
    print()

    server = http.server.HTTPServer(("localhost", PORT), Handler)

    # Open browser after a short delay
    def open_browser():
        import time
        time.sleep(1)
        webbrowser.open("https://king-kirratoy.github.io/Tech-Service-Hub/index.html")
        print(f"  ✓ Opened in browser")
        print()

    threading.Thread(target=open_browser, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
        server.server_close()


if __name__ == "__main__":
    main()
