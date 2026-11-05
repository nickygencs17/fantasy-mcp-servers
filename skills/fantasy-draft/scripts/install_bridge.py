"""Start the draft bridge (room_bridge.py) automatically at login on a Mac,
so it's always ready when you join a draft. It only listens on 127.0.0.1
and sits idle between drafts.

    python3 <skill>/scripts/install_bridge.py             # install + start (run from the folder with .env)
    python3 <skill>/scripts/install_bridge.py status      # is it running?
    python3 <skill>/scripts/install_bridge.py uninstall   # stop it and remove it

Installs a launchd agent (~/Library/LaunchAgents/com.fantasy-draft.bridge.plist)
that runs room_bridge.py from the current folder and restarts it if it stops.
Log: ~/Library/Logs/fantasy-draft-bridge.log. If macOS asks whether Python
may access the folder (e.g. Desktop), allow it.
"""

import os
import plistlib
import subprocess
import sys
import urllib.request
from pathlib import Path

LABEL = "com.fantasy-draft.bridge"
PLIST = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"
LOG = Path.home() / "Library/Logs/fantasy-draft-bridge.log"
BRIDGE = Path(__file__).resolve().parent / "room_bridge.py"
PORT = int(os.environ.get("DRAFT_BRIDGE_PORT", "8781"))
DOMAIN = f"gui/{os.getuid()}"


def launchctl(*args) -> subprocess.CompletedProcess:
    return subprocess.run(["launchctl", *args], capture_output=True, text=True)


def running() -> bool:
    """The bridge answers CORS preflight with 204."""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}/picks", method="OPTIONS")
        with urllib.request.urlopen(req, timeout=2) as r:
            return r.status == 204
    except Exception:
        return False


def install() -> None:
    if sys.platform != "darwin":
        raise SystemExit("Auto-start is for macOS; elsewhere run room_bridge.py yourself.")
    folder = Path.cwd()
    if not (folder / ".env").exists() and not os.environ.get("ESPN_ENV_FILE"):
        raise SystemExit(f"No .env in {folder}. Run this from the folder that has your league's .env.")
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "PYTHONUNBUFFERED": "1"}
    for key in ("ESPN_ENV_FILE", "DRAFT_CACHE_DIR", "DRAFT_BRIDGE_PORT"):
        if os.environ.get(key):
            env[key] = os.environ[key]
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    PLIST.write_bytes(plistlib.dumps({
        "Label": LABEL,
        "ProgramArguments": [sys.executable, str(BRIDGE)],
        "WorkingDirectory": str(folder),
        "EnvironmentVariables": env,
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "StandardOutPath": str(LOG),
        "StandardErrorPath": str(LOG),
    }))
    launchctl("bootout", f"{DOMAIN}/{LABEL}")  # replace an older copy, if any
    res = launchctl("bootstrap", DOMAIN, str(PLIST))
    if res.returncode != 0:
        raise SystemExit(f"launchctl couldn't start it: {res.stderr.strip()}")
    print(f"Installed: the draft bridge now starts at login, from {folder}.")
    print(f"Log: {LOG}")


def uninstall() -> None:
    launchctl("bootout", f"{DOMAIN}/{LABEL}")
    if PLIST.exists():
        PLIST.unlink()
    print("Removed: the draft bridge no longer starts at login.")


def status() -> None:
    print(f"auto-start: {'installed' if PLIST.exists() else 'not installed'}; "
          f"bridge on 127.0.0.1:{PORT}: {'running' if running() else 'not running'}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "install"
    {"install": install, "uninstall": uninstall, "status": status}.get(cmd, lambda: sys.exit(__doc__))()
