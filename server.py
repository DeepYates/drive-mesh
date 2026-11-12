"""Local dev server for the Drive-mesh driving prototype.

    python game/server.py [port]            # default 8600, bound to 127.0.0.1

Serves ``game/static`` and two data endpoints:

* ``/tiles/<path>``  - read-only proxy to the DeepWalk 3D Tiles service. The upstream URL
  carries an API key (the ``dw_live_...`` path segment), so the browser only ever sees
  ``/tiles/...``; the key stays in this process. Tiles are immutable (they live under a
  timestamped directory), so they are cached on disk in ``game/.cache/tiles``; the root
  ``tileset.json`` is re-fetched after ROOT_TTL seconds.
* ``/routes.geojson`` - the driven routes (``vroom.pack_versions.display_route`` export).

The tileset URL comes from ``$DRIVE_MESH_TILESET_URL`` or, failing that, the first line of
``game/tileset_url.local.txt`` (keep that file out of version control).
"""
from __future__ import annotations

import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
CACHE = HERE / ".cache" / "tiles"
URL_FILE = HERE / "tileset_url.local.txt"
ROUTES = Path(os.environ.get(
    "DRIVE_ROUTES_GEOJSON",
    HERE.parent / "exports" / "pack_versions_display_route_01a182ef-b809-76c1-8600-933613e21deb.geojson"))
ROOT_TTL = 600
TYPES = {".json": "application/json", ".glb": "model/gltf-binary", ".geojson": "application/geo+json"}
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def tileset_url() -> str:
    url = os.environ.get("DRIVE_MESH_TILESET_URL", "").strip()
    if not url and URL_FILE.exists():
        url = URL_FILE.read_text(encoding="utf-8").strip().splitlines()[0].strip()
    if not url.endswith("/tileset.json"):
        sys.exit("Set DRIVE_MESH_TILESET_URL (or game/tileset_url.local.txt) to the .../tileset.json URL")
    return url


UPSTREAM = ""  # set in main(): the tileset URL minus "tileset.json"


def fetch_tile(rel: str) -> bytes:
    """Return the tile bytes for a path relative to the tileset root (disk-cached)."""
    dest = CACHE / rel
    is_root = rel == "tileset.json"
    with _locks_guard:
        lock = _locks.setdefault(rel, threading.Lock())
    with lock:
        if dest.exists() and not (is_root and time.time() - dest.stat().st_mtime > ROOT_TTL):
            return dest.read_bytes()
        req = urllib.request.Request(UPSTREAM + rel, headers={"User-Agent": "drive-mesh-game/0.1"})
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read()
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + f".{threading.get_ident()}.tmp")
        tmp.write_bytes(body)
        os.replace(tmp, dest)
        return body


class Handler(SimpleHTTPRequestHandler):
    # HTTP/1.1 so the browser reuses connections: a cold drive is hundreds of tile requests
    # and the HTTP/1.0 default opened a new TCP connection for every one. Every response
    # below carries Content-Length (send_error closes the connection), which 1.1 requires.
    protocol_version = "HTTP/1.1"
    timeout = 30  # idle keep-alive connections give their thread back

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(STATIC), **kw)

    def log_message(self, fmt, *args):  # quiet: tiles are hundreds of requests
        if not self.path.startswith("/tiles/") or (args and str(args[1])[:1] not in "23"):
            sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def _send(self, body: bytes, ctype: str, cache: str = "no-cache"):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        try:
            self.wfile.write(body)
        except ConnectionError:
            # The page cancels in-flight tiles that leave view; that is not an error.
            self.close_connection = True

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/tiles/"):
            rel = path[len("/tiles/"):]
            parts = rel.split("/")
            if not rel or any(p in ("", ".", "..") or ":" in p or "\\" in p for p in parts):
                return self.send_error(400, "bad tile path")
            try:
                body = fetch_tile(rel)
            except urllib.error.HTTPError as e:
                return self.send_error(e.code, "upstream error")
            except Exception as e:  # network trouble: report, never leak the upstream URL
                return self.send_error(502, f"upstream fetch failed: {type(e).__name__}")
            ctype = TYPES.get(Path(rel).suffix, "application/octet-stream")
            return self._send(body, ctype, "no-cache" if rel == "tileset.json" else "max-age=86400, immutable")
        # The export wins when present; otherwise fall through to the copy committed in
        # static/routes.geojson (the one the hosted build ships).
        if path == "/routes.geojson" and ROUTES.exists():
            return self._send(ROUTES.read_bytes(), TYPES[".geojson"])
        return super().do_GET()


class Server(ThreadingHTTPServer):
    # socketserver's default backlog is 5. A browser holds 6 connections per host and, after
    # cancelling a batch of tiles, reopens them all at once; the sixth was refused and the
    # tile it carried was reported as failed (a hole in the road as far as the car can tell).
    request_queue_size = 128

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], ConnectionError):
            return  # client went away mid-request
        super().handle_error(request, client_address)


def main() -> int:
    global UPSTREAM
    UPSTREAM = tileset_url().rsplit("/", 1)[0] + "/"
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8600
    if not (STATIC / "bundle.js").exists():
        print("note: static/bundle.js is missing - run `npm run build` in game/ first")
    srv = Server(("127.0.0.1", port), Handler)
    print(f"drive-mesh game on http://127.0.0.1:{port}/  (tiles proxied; cache: {CACHE})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
