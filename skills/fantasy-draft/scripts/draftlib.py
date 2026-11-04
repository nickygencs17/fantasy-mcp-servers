"""Shared helpers for the fantasy-draft skill scripts: ESPN requests,
league settings, snake order. Standard library only, so it runs with any
python3 and nothing to install.

Credentials come from a .env file (ESPN_S2, ESPN_SWID, ESPN_LEAGUE_ID,
ESPN_TEAM_ID, ESPN_YEAR): $ESPN_ENV_FILE, else ./.env in the working folder.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

POSITIONS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST"}
SLOT_NAMES = {
    0: "QB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP",
    16: "D/ST", 17: "K", 20: "BE", 21: "IR", 23: "RB/WR/TE",
}
FLEX_SLOTS = {
    "RB/WR": ("RB", "WR"), "WR/TE": ("WR", "TE"),
    "RB/WR/TE": ("RB", "WR", "TE"), "OP": ("QB", "RB", "WR", "TE"),
}


def load_env() -> dict:
    path = Path(os.environ.get("ESPN_ENV_FILE", ".env"))
    if not path.exists():
        raise SystemExit(f"No ESPN credentials file at {path.resolve()} (set ESPN_ENV_FILE).")
    env = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip("'\"")
    # Another league (e.g. a mock draft): --league / ESPN_LEAGUE_ID overrides
    # the file, and the team is then found by SWID instead of ESPN_TEAM_ID.
    if os.environ.get("ESPN_LEAGUE_ID") and os.environ["ESPN_LEAGUE_ID"] != env.get("ESPN_LEAGUE_ID"):
        env["ESPN_LEAGUE_ID"] = os.environ["ESPN_LEAGUE_ID"]
        env.pop("ESPN_TEAM_ID", None)
    for key in ("ESPN_S2", "ESPN_SWID", "ESPN_LEAGUE_ID"):
        if not env.get(key):
            raise SystemExit(f"{key} is missing from {path.resolve()}")
    return env


class Espn:
    def __init__(self, env: dict):
        self.year = int(env.get("ESPN_YEAR", "2026"))
        self.league_id = env["ESPN_LEAGUE_ID"]
        self.team_id = int(env["ESPN_TEAM_ID"]) if env.get("ESPN_TEAM_ID") else None
        self.swid = env["ESPN_SWID"].strip("{}").upper()
        self.cookie = f"espn_s2={env['ESPN_S2']}; SWID={env['ESPN_SWID']}"
        base = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons"
        self.season_url = f"{base}/{self.year}"
        self.league_url = f"{base}/{self.year}/segments/0/leagues/{self.league_id}"

    def get(self, url: str, views: list, fantasy_filter: dict = None, timeout: int = 20) -> dict:
        query = urllib.parse.urlencode([("view", v) for v in views])
        req = urllib.request.Request(f"{url}?{query}", headers={
            "Cookie": self.cookie,
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (fantasy-draft skill)",
            **({"X-Fantasy-Filter": json.dumps(fantasy_filter)} if fantasy_filter else {}),
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                raise SystemExit("ESPN returned 401: ESPN_S2/ESPN_SWID cookies are invalid or expired.")
            raise


def my_team_id(espn: "Espn", teams: list):
    """Your team in this league: the one whose owners include your SWID."""
    for t in teams:
        if any(o.strip("{}").upper() == espn.swid for o in t.get("owners") or []):
            return t["id"]
    return espn.team_id


def use_league_arg() -> None:
    """--league <id> on the command line = draft in that league instead."""
    if "--league" in sys.argv:
        i = sys.argv.index("--league")
        os.environ["ESPN_LEAGUE_ID"] = sys.argv[i + 1]
        del sys.argv[i:i + 2]


def slot_counts(settings: dict) -> dict:
    """Starting slots by name, bench and IR dropped: {"QB": 1, "RB/WR/TE": 2, ...}."""
    out = {}
    for slot_id, count in settings.get("rosterSettings", {}).get("lineupSlotCounts", {}).items():
        name = SLOT_NAMES.get(int(slot_id))
        if count and name and name not in ("BE", "IR"):
            out[name] = count
    return out


def bench_count(settings: dict) -> int:
    return settings.get("rosterSettings", {}).get("lineupSlotCounts", {}).get("20", 0)


def team_for_pick(order: list, draft_type: str, overall: int):
    if not order:
        return None
    n = len(order)
    rnd, idx = (overall - 1) // n, (overall - 1) % n
    if draft_type == "SNAKE" and rnd % 2 == 1:
        idx = n - 1 - idx
    return order[idx]


def cache_path(espn: Espn) -> Path:
    return Path(os.environ.get("DRAFT_CACHE_DIR", "draft-cache")) / f"board-{espn.league_id}-{espn.year}.json"
