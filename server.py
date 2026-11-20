#!/usr/bin/env python3
"""My Bookshelf — local static server + JSON storage.

Usage:
    python server.py [port]      # default port: 8080

Serves this folder and exposes:
    GET /api/state   -> saved shelf as JSON (or null if nothing saved yet)
    PUT /api/state   -> writes the request body to bookshelf.json

No dependencies beyond the Python standard library.
"""

import json
import os
import sys
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(ROOT, "bookshelf.json")
MAX_BODY = 25 * 1024 * 1024  # 25 MB safety cap


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == "/api/state":
            if not os.path.exists(DATA_FILE):
                return self._send_json(200, None)
            try:
                with open(DATA_FILE, "r", encoding="utf-8") as f:
                    return self._send_json(200, json.load(f))
            except Exception as exc:
                return self._send_json(500, {"error": "Could not read bookshelf.json: %s" % exc})
        return super().do_GET()

    def do_PUT(self):
        if urlparse(self.path).path != "/api/state":
            return self._send_json(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._send_json(400, {"error": "Invalid Content-Length"})
        if length <= 0 or length > MAX_BODY:
            return self._send_json(413, {"error": "Invalid payload size"})

        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            return self._send_json(400, {"error": "Invalid JSON: %s" % exc})

        try:
            # Atomic write: temp file in the same folder, then replace
            fd, tmp = tempfile.mkstemp(dir=ROOT, prefix=".bookshelf-", suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, DATA_FILE)
        except Exception as exc:
            return self._send_json(500, {"error": "Could not save: %s" % exc})
        return self._send_json(200, {"ok": True})

    def log_message(self, fmt, *args):
        # Keep the console quiet for static assets; log only API calls
        if args and "/api/state" in str(args[0]):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as exc:
        print("Could not start on port %d: %s" % (port, exc))
        print("Another server may already be running. Try: python server.py 8081")
        sys.exit(1)

    print("My Bookshelf running at http://localhost:%d" % port)
    print("Data file: %s" % DATA_FILE)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
