"""Local bridge for live draft picks. ESPN's API hides picks until the draft
ends, so draftroom.js (running in the draft-room tab via the Draft Bridge
bookmarklet) posts what the page shows here every couple of seconds, and this
saves it to draft-cache/room-<league>.json for pick.py to read.

When the page says it's the user's turn, the bridge also runs pick.py once
for that pick and returns the recommendation, which draftroom.js shows on the
draft page itself, and (on a Mac) posts a notification with the pick, so you
hear about it even when the draft tab is in the background.

    python3 <skill>/scripts/room_bridge.py      # from the folder with .env; leave running
    python3 <skill>/scripts/install_bridge.py   # or: start it automatically at login

Listens on 127.0.0.1 only (your Mac), port 8781 or $DRAFT_BRIDGE_PORT.
"""

import json
import os
import re
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.environ.get("DRAFT_BRIDGE_PORT", "8781"))
CACHE_DIR = Path(os.environ.get("DRAFT_CACHE_DIR", "draft-cache"))
PICK_SCRIPT = Path(__file__).resolve().parent / "pick.py"
_recommendations = {}  # (league, clock) -> {"take": ..., "next": ...}


def notify(title: str, text: str) -> None:
    """macOS notification with a sound; does nothing elsewhere."""
    if sys.platform != "darwin":
        return
    esc = lambda s: s.replace("\\", "\\\\").replace('"', '\\"')  # noqa: E731
    try:
        subprocess.Popen(["osascript", "-e", f'display notification "{esc(text)}" with title "{esc(title)}" sound name "Glass"'],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        pass


def recommend(league: str, clock: int) -> dict:
    """Run pick.py once per (league, pick) and keep its TAKE / Next best lines."""
    key = (league, clock)
    if key not in _recommendations:
        try:
            out = subprocess.run([sys.executable, str(PICK_SCRIPT), "--league", league, "--top", "2"],
                                 capture_output=True, text=True, timeout=15).stdout
        except subprocess.TimeoutExpired:
            out = ""
        lines = out.splitlines()
        take = next((l[len("TAKE: "):] for l in lines if l.startswith("TAKE: ")), None)
        nxt = next((l[len("Next best: "):] for l in lines if l.startswith("Next best: ")), None)
        if take:
            _recommendations[key] = {"take": take, "next": nxt}
            notify(f"Your pick (#{clock})", "TAKE " + take.split(" — ")[0] + (f"  ·  next: {nxt.split(' — ')[0]}" if nxt else ""))
        else:
            return {"take": None, "next": None, "error": (lines[-1] if lines else "pick.py gave no answer")}
    return _recommendations[key]


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get("Origin", "")
        if origin.endswith(".espn.com") or origin == "https://fantasy.espn.com":
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # Chrome's Private Network Access: a public page may call localhost
        # only if the local server opts in.
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0))
            league = re.sub(r"\D", "", str(body.get("league", "")))
            if not league:
                raise ValueError("missing league")
            body["received_at"] = time.time()
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            path = CACHE_DIR / f"room-{league}.json"
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(body))
            tmp.replace(path)
            reply = {"clock": body.get("clock"), "take": None}
            if body.get("my_turn") and body.get("clock"):
                reply.update(recommend(league, int(body["clock"])))
            payload = json.dumps(reply).encode()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        except Exception:
            self.send_response(400)
        self._cors()
        self.end_headers()

    def log_message(self, *args):  # quiet
        pass


if __name__ == "__main__":
    print(f"Draft bridge listening on http://127.0.0.1:{PORT} -> {CACHE_DIR.resolve()}/room-<league>.json", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
