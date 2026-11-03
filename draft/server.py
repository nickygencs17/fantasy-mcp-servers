"""
ESPN Fantasy Football MCP Server
---------------------------------
Exposes live draft/league state from a private ESPN Fantasy Football
league to any MCP client (e.g. Claude Desktop). Read-only: it does NOT
submit draft picks (ESPN doesn't support that via API during a live
draft) — you still pick in ESPN's UI. This server just gives Claude
the live state so it can advise you.

Draft tools are built for a 60-second pick clock:
- The whole draftable player pool (projections, ESPN rank, ADP, injury,
  bye, VBD) is fetched once and saved to cache/players-<league>-<year>.json,
  then refreshed in the background. Lookups read that file, never ESPN.
- Live picks come from ESPN's small mDraftDetail feed (~50 KB), cached for
  a few seconds, so "who's gone / who's on the clock" is always current.

Setup:
    pip install -r requirements.txt
    cp .env.example .env   # fill in your values
    python server.py       # for local testing
Then point Claude Desktop's config at this server (see README.md).
"""

import json
import os
import re
import threading
import time
from datetime import datetime, timezone
from difflib import get_close_matches
from pathlib import Path
from typing import Optional

import requests
from dotenv import load_dotenv
from espn_api.football import League
from espn_api.football.settings import Settings as FootballSettings
from mcp.server.fastmcp import FastMCP

load_dotenv()

# Patch a real bug in espn_api==0.46.0: League.refresh() calls
# super()._fetch_league() without passing SettingsClass=Settings, so it
# silently downgrades league.settings to the bare BaseSettings parent class
# (which lacks position_slot_counts, scoring_format, faab, etc.) every time
# refresh() runs — which get_draft_status/get_drafted_players call. Any
# get_league_settings() call afterward then crashes with
# "'BaseSettings' object has no attribute 'position_slot_counts'".
def _patched_refresh(self):
    data = super(League, self)._fetch_league(SettingsClass=FootballSettings)
    self.nfl_week = data["status"]["latestScoringPeriod"]
    self._fetch_teams(data)


League.refresh = _patched_refresh

LEAGUE_ID = int(os.environ["ESPN_LEAGUE_ID"])
YEAR = int(os.environ.get("ESPN_YEAR", "2026"))
ESPN_S2 = os.environ["ESPN_S2"]
SWID = os.environ["ESPN_SWID"]
MY_TEAM_ID = os.environ.get("ESPN_TEAM_ID")  # optional, int as string

# HTTP mode (for remote access via a tunnel, e.g. Tailscale Funnel) is opt-in
# via MCP_HTTP_PORT — plain `python server.py` with no env vars still runs
# stdio, unchanged, for local Claude Desktop use.
MCP_HTTP_PORT = os.environ.get("MCP_HTTP_PORT")
MCP_AUTH_TOKEN = os.environ.get("MCP_AUTH_TOKEN")

mcp = FastMCP(
    "espn-fantasy-football",
    host="0.0.0.0",
    port=int(MCP_HTTP_PORT) if MCP_HTTP_PORT else 8000,
    # Plain JSON replies and no session bookkeeping: less overhead per call
    json_response=True,
    stateless_http=True,
)

_league_cache: Optional[League] = None


def get_league() -> League:
    """Cached League object. Re-fetches fresh data each call to espn_api
    methods (the object itself is cheap to reuse; draft/roster data is
    pulled live from ESPN each time you call a tool)."""
    global _league_cache
    if _league_cache is None:
        _league_cache = League(
            league_id=LEAGUE_ID,
            year=YEAR,
            espn_s2=ESPN_S2,
            swid=SWID,
        )
    return _league_cache


# ---------------------------------------------------------------------------
# Draft data: local player cache + live pick feed
# ---------------------------------------------------------------------------

LEAGUE_URL = (
    "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/"
    f"{YEAR}/segments/0/leagues/{LEAGUE_ID}"
)
SEASON_URL = f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{YEAR}"
CACHE_DIR = Path(os.environ.get("DRAFT_CACHE_DIR", Path(__file__).resolve().parent / "cache"))
PLAYER_CACHE_FILE = CACHE_DIR / f"players-{LEAGUE_ID}-{YEAR}.json"
PLAYER_POOL_SIZE = int(os.environ.get("DRAFT_POOL_SIZE", "400"))
PLAYER_CACHE_MAX_AGE = 6 * 3600  # background refresh interval (injuries change)
# Live picks are polled in the background so tool calls never wait on ESPN:
# every 2s while a draft is live or about to start, every 30s otherwise.
DRAFT_POLL_LIVE = 2
DRAFT_POLL_IDLE = 30
DRAFT_STATE_MAX_AGE = 45  # older than this (poller stalled) = fetch inline
# Test hook: pretend only the first N picks of a finished draft have happened,
# so the live-draft logic can be exercised outside draft day.
SIMULATE_PICKS = os.environ.get("DRAFT_SIMULATE_PICKS")

POSITIONS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST"}
SLOT_NAMES = {
    0: "QB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP",
    16: "D/ST", 17: "K", 20: "BE", 21: "IR", 23: "RB/WR/TE",
}
# Which positions can fill each flex-style starting slot
FLEX_SLOTS = {
    "RB/WR": ("RB", "WR"), "WR/TE": ("WR", "TE"),
    "RB/WR/TE": ("RB", "WR", "TE"), "OP": ("QB", "RB", "WR", "TE"),
}

_http = requests.Session()
_http.headers["User-Agent"] = "Mozilla/5.0 (espn-fantasy-draft MCP)"
_http.cookies.update({"espn_s2": ESPN_S2, "SWID": SWID})

_cache_lock = threading.Lock()
_player_cache: Optional[dict] = None  # swapped atomically after each rebuild
_draft_state: Optional[dict] = None
_draft_state_at = 0.0


def _espn_get(url: str, params: list, fantasy_filter: Optional[dict] = None) -> dict:
    headers = {"X-Fantasy-Filter": json.dumps(fantasy_filter)} if fantasy_filter else {}
    resp = _http.get(url, params=params, headers=headers, timeout=20)
    if resp.status_code == 401:
        raise RuntimeError("ESPN returned 401: ESPN_S2/ESPN_SWID cookies are invalid or expired.")
    resp.raise_for_status()
    return resp.json()


def _slot_counts(settings: dict) -> dict:
    """Starting slots by name (bench and IR dropped), e.g. {"QB": 1, "RB/WR/TE": 2}."""
    counts = settings.get("rosterSettings", {}).get("lineupSlotCounts", {})
    out = {}
    for slot_id, count in counts.items():
        name = SLOT_NAMES.get(int(slot_id))
        if count and name and name not in ("BE", "IR"):
            out[name] = count
    return out


def _compute_vbd(players: list, slots: dict, team_count: int) -> None:
    """Value over replacement: projection minus the projection of the last
    player at that position who'd be a starter league-wide. Flex slots go to
    the best remaining RB/WR/TE after dedicated slots are filled — the same
    method beer-sheet cheat sheets use. Adds 'vbd' to each player in place."""
    by_pos: dict = {}
    for p in players:
        if p["projected_points"] is not None:
            by_pos.setdefault(p["position"], []).append(p)
    for lst in by_pos.values():
        lst.sort(key=lambda p: p["projected_points"], reverse=True)

    starters = {pos: slots.get(pos, 0) * team_count for pos in by_pos}
    for flex, eligible in FLEX_SLOTS.items():
        for _ in range(slots.get(flex, 0) * team_count):
            # Give the flex spot to whichever eligible position's next man up projects best
            best = max(
                (pos for pos in eligible if starters.get(pos, 0) < len(by_pos.get(pos, []))),
                key=lambda pos: by_pos[pos][starters[pos]]["projected_points"],
                default=None,
            )
            if best:
                starters[best] += 1

    for pos, lst in by_pos.items():
        n = starters.get(pos, 0)
        baseline = lst[min(n, len(lst)) - 1]["projected_points"] if n else None
        for p in lst:
            p["vbd"] = round(p["projected_points"] - baseline, 1) if baseline is not None else None
    for p in players:
        p.setdefault("vbd", None)


def _player_record(entry: dict, rank_type: str, pro_teams: dict) -> dict:
    pl = entry.get("player", entry)
    stats = {s.get("id"): s for s in pl.get("stats", [])}
    projection = stats.get(f"10{YEAR}", {}).get("appliedTotal")
    last_season = stats.get(f"00{YEAR - 1}", {}).get("appliedTotal")
    ranks = pl.get("draftRanksByRankType", {}).get(rank_type, {})
    ownership = pl.get("ownership", {})
    pro = pro_teams.get(pl.get("proTeamId"), {})
    outlook = (pl.get("seasonOutlook") or "").strip()
    return {
        "id": pl["id"],
        "name": pl.get("fullName"),
        "position": POSITIONS.get(pl.get("defaultPositionId"), "?"),
        "pro_team": pro.get("abbrev", "FA"),
        "bye_week": pro.get("bye"),
        "espn_rank": ranks.get("rank"),
        "avg_draft_position": round(ownership["averageDraftPosition"], 1) if ownership.get("averageDraftPosition") else None,
        "auction_value": ranks.get("auctionValue"),
        "projected_points": round(projection, 1) if projection is not None else None,
        "last_season_points": round(last_season, 1) if last_season is not None else None,
        "injury_status": pl.get("injuryStatus") or "ACTIVE",
        "percent_owned": round(ownership.get("percentOwned", 0), 1),
        "outlook": (outlook[:280] + "…") if len(outlook) > 280 else outlook,
    }


def _fetch_players(fantasy_filter: dict, rank_type: str, pro_teams: dict) -> list:
    data = _espn_get(LEAGUE_URL, [("view", "kona_player_info")], fantasy_filter)
    return [_player_record(e, rank_type, pro_teams) for e in data.get("players", [])]


def build_player_cache() -> dict:
    """Fetch the draftable pool once (a few MB, ~10-20s on a Pi) and save it.
    Everything a pick needs is in here so draft-time calls never wait on ESPN
    for player data."""
    with _cache_lock:
        meta = _espn_get(LEAGUE_URL, [("view", "mSettings"), ("view", "mTeam")])
        settings = meta.get("settings", {})
        rank_type = settings.get("scoringSettings", {}).get("playerRankType") or "PPR"
        season = _espn_get(SEASON_URL, [("view", "proTeamSchedules_wl")])
        pro_teams = {
            t["id"]: {"abbrev": (t.get("abbrev") or "FA").upper(), "bye": t.get("byeWeek")}
            for t in season.get("settings", {}).get("proTeams", [])
        }
        stat_ids = [f"00{YEAR}", f"10{YEAR}", f"00{YEAR - 1}"]
        players = _fetch_players(
            {
                "players": {
                    "limit": PLAYER_POOL_SIZE,
                    "sortDraftRanks": {"sortPriority": 100, "sortAsc": True, "value": rank_type},
                    "filterStatsForTopScoringPeriodIds": {"value": 1, "additionalValue": stat_ids},
                }
            },
            rank_type,
            pro_teams,
        )
        slots = _slot_counts(settings)
        team_count = settings.get("size") or len(meta.get("teams", [])) or 10
        _compute_vbd(players, slots, team_count)

        members = {m["id"]: m for m in meta.get("members", [])}
        teams = {}
        for t in meta.get("teams", []):
            owner = members.get((t.get("owners") or [None])[0], {})
            teams[str(t["id"])] = {
                "name": (t.get("name") or f"Team {t['id']}").strip(),
                "abbrev": t.get("abbrev"),
                "owner": owner.get("firstName", ""),
            }
        cache = {
            "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "built_ts": time.time(),
            "league_id": LEAGUE_ID,
            "year": YEAR,
            "rank_type": rank_type,
            "team_count": team_count,
            "starting_slots": slots,
            "teams": teams,
            "pro_teams": {str(k): v for k, v in pro_teams.items()},
            "players": {str(p["id"]): p for p in players},
        }
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = PLAYER_CACHE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache))
        tmp.replace(PLAYER_CACHE_FILE)
        global _player_cache
        _player_cache = cache
        return cache


def player_cache() -> dict:
    """The in-memory cache, loaded from disk or built on first use."""
    global _player_cache
    if _player_cache is None:
        if PLAYER_CACHE_FILE.exists():
            _player_cache = json.loads(PLAYER_CACHE_FILE.read_text())
        else:
            build_player_cache()
    return _player_cache


def _ensure_players(ids: list) -> None:
    """Late-round picks can fall outside the cached pool; fetch just those
    (one small request) and add them so every pick has a name."""
    cache = player_cache()
    missing = [i for i in ids if str(i) not in cache["players"]]
    if not missing:
        return
    pro = {int(k): v for k, v in cache["pro_teams"].items()}
    extra = _fetch_players(
        {"players": {"filterIds": {"value": missing},
                     "filterStatsForTopScoringPeriodIds": {"value": 1, "additionalValue": [f"10{YEAR}"]}}},
        cache["rank_type"],
        pro,
    )
    for p in extra:
        p["vbd"] = None
        cache["players"][str(p["id"])] = p


def _background_refresh() -> None:
    """Warm everything at startup, then keep player data fresh."""
    while True:
        try:
            cache = player_cache()
            if time.time() - cache.get("built_ts", 0) > PLAYER_CACHE_MAX_AGE:
                build_player_cache()
            get_league()  # espn_api's first load is slow; do it before anyone asks
        except Exception as exc:  # keep serving the last good cache
            print(f"player cache refresh failed: {exc}", flush=True)
        time.sleep(600)


def draft_state(force: bool = False) -> dict:
    """Latest live picks. Normally served from memory, kept fresh by
    _draft_poller; only fetches inline if the poller has fallen behind."""
    if force or not _draft_state or time.time() - _draft_state_at > DRAFT_STATE_MAX_AGE:
        return _fetch_draft_state()
    return _draft_state


def _draft_is_hot(state: Optional[dict]) -> bool:
    """Live, or starting within 15 minutes (or past its start time but not
    flagged yet): poll fast so the first picks show up right away."""
    if not state:
        return True
    if state["drafted"]:
        return False
    if state["in_progress"]:
        return True
    start = (state.get("scheduled") or 0) / 1000
    return bool(start) and time.time() > start - 15 * 60


def _draft_poller() -> None:
    while True:
        try:
            _fetch_draft_state()
        except Exception as exc:  # keep serving the last good state
            print(f"draft poll failed: {exc}", flush=True)
        time.sleep(DRAFT_POLL_LIVE if _draft_is_hot(_draft_state) else DRAFT_POLL_IDLE)


def _fetch_draft_state() -> dict:
    """Live picks + draft order from ESPN's mDraftDetail feed (~50 KB)."""
    global _draft_state, _draft_state_at
    data = _espn_get(LEAGUE_URL, [("view", "mDraftDetail"), ("view", "mSettings")])
    detail = data.get("draftDetail", {})
    settings = data.get("settings", {})
    draft_settings = settings.get("draftSettings", {})
    picks = sorted(
        (p for p in detail.get("picks", []) if p.get("playerId") not in (None, 0, -1)),
        key=lambda p: p["overallPickNumber"],
    )
    drafted, in_progress = bool(detail.get("drafted")), bool(detail.get("inProgress"))
    if SIMULATE_PICKS is not None:
        picks = picks[: int(SIMULATE_PICKS)]
        drafted, in_progress = False, True
    rounds = sum(_slot_counts(settings).values()) + settings.get("rosterSettings", {}).get("lineupSlotCounts", {}).get("20", 0)
    state = {
        "picks": picks,
        "drafted": drafted,
        "in_progress": in_progress,
        "type": draft_settings.get("type", "SNAKE"),
        "order": draft_settings.get("pickOrder") or [],
        "rounds": rounds,
        "seconds_per_pick": draft_settings.get("timePerSelection"),
        "scheduled": draft_settings.get("date"),
    }
    _ensure_players([p["playerId"] for p in picks])
    _draft_state, _draft_state_at = state, time.time()
    return state


def _team_for_pick(state: dict, overall: int) -> Optional[int]:
    order = state["order"]
    if not order:
        return None
    n = len(order)
    rnd, idx = (overall - 1) // n, (overall - 1) % n
    if state["type"] == "SNAKE" and rnd % 2 == 1:
        idx = n - 1 - idx
    return order[idx]


def _team_name(team_id) -> str:
    return player_cache()["teams"].get(str(team_id), {}).get("name", f"Team {team_id}")


def _pick_label(pick: dict) -> str:
    p = player_cache()["players"].get(str(pick["playerId"]), {})
    return (
        f"R{pick['roundId']}.{pick['roundPickNumber']} {_team_name(pick['teamId'])}: "
        f"{p.get('name', pick['playerId'])} ({p.get('position', '?')})"
    )


def _clock(state: dict) -> dict:
    """Where the draft is: current pick, who's up, and when you pick next."""
    n = len(state["order"]) or player_cache()["team_count"]
    total = state["rounds"] * n
    made = len(state["picks"])
    if state["drafted"] or made >= total:
        return {"state": "complete", "picks_made": made}
    if not state["in_progress"] and made == 0:
        when = datetime.fromtimestamp(state["scheduled"] / 1000, timezone.utc).isoformat() if state["scheduled"] else None
        return {"state": "not_started", "scheduled_utc": when, "seconds_per_pick": state["seconds_per_pick"]}
    current = made + 1
    on_clock = _team_for_pick(state, current)
    out = {
        "state": "in_progress",
        "picks_made": made,
        "current_pick": {"overall": current, "round": (current - 1) // n + 1, "pick_in_round": (current - 1) % n + 1},
        "on_the_clock": _team_name(on_clock) if on_clock else None,
        "seconds_per_pick": state["seconds_per_pick"],
    }
    if MY_TEAM_ID and state["type"] == "SNAKE":
        mine = [k for k in range(current, total + 1) if _team_for_pick(state, k) == int(MY_TEAM_ID)]
        out["you_are_on_the_clock"] = bool(mine) and mine[0] == current
        out["picks_until_your_turn"] = (mine[0] - current) if mine else None
        out["your_next_picks"] = mine[:3]
    return out


def _available(state: dict, position: Optional[str] = None) -> list:
    taken = {str(p["playerId"]) for p in state["picks"]}
    pos = position.upper().replace("DST", "D/ST") if position else None
    return [
        p for pid, p in player_cache()["players"].items()
        if pid not in taken and (pos is None or p["position"] == pos)
    ]


def _board_entry(p: dict, next_pick: Optional[int]) -> dict:
    entry = {k: p[k] for k in ("name", "position", "pro_team", "bye_week", "projected_points",
                                 "vbd", "espn_rank", "avg_draft_position", "injury_status")}
    if next_pick and p.get("avg_draft_position"):
        # Positive = still on the board past where drafters usually take him
        entry["picks_past_adp"] = round(next_pick - p["avg_draft_position"], 1)
    return entry


def _my_team_players(state: dict) -> list:
    if not MY_TEAM_ID:
        return []
    cache = player_cache()
    return [cache["players"].get(str(p["playerId"]), {"name": str(p["playerId"]), "position": "?"})
            for p in state["picks"] if p["teamId"] == int(MY_TEAM_ID)]


def _open_starting_slots(roster: list) -> dict:
    """Starting slots still empty after placing your picks (dedicated slots
    first, then flex)."""
    open_slots = dict(player_cache()["starting_slots"])
    leftovers = []
    for p in roster:
        if open_slots.get(p["position"], 0) > 0:
            open_slots[p["position"]] -= 1
        else:
            leftovers.append(p["position"])
    for pos in leftovers:
        for flex, eligible in FLEX_SLOTS.items():
            if pos in eligible and open_slots.get(flex, 0) > 0:
                open_slots[flex] -= 1
                break
    return {k: v for k, v in open_slots.items() if v > 0}


def _normalize(name: str) -> str:
    name = re.sub(r"[^a-z0-9/ ]", "", (name or "").lower())
    return re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", name).strip()


@mcp.tool()
def get_league_settings() -> dict:
    """Get this league's full rulebook: scoring type, per-stat scoring
    values, roster slots, FAAB/waiver budget, trade deadline and veto
    rules, and playoff format. Call this first so recommendations respect
    this league's actual rules instead of assuming standard defaults."""
    league = get_league()
    settings = league.settings
    trade_deadline = None
    if settings.trade_deadline:
        trade_deadline = datetime.fromtimestamp(
            settings.trade_deadline / 1000
        ).isoformat()
    return {
        "league_name": settings.name,
        "team_count": settings.team_count,
        "scoring_type": settings.scoring_type,
        "median_scoring": settings.median_scoring,
        "roster_positions": settings.position_slot_counts,
        "scoring_format": [
            {"stat": s["label"], "abbr": s["abbr"], "points": s["points"]}
            for s in settings.scoring_format
        ],
        "waiver": {
            "uses_faab": settings.faab,
            "faab_budget": settings.acquisition_budget,
        },
        "trade_rules": {
            "trade_deadline": trade_deadline,
            "veto_votes_required": settings.veto_votes_required,
        },
        "regular_season_weeks": settings.reg_season_count,
        "playoff_team_count": settings.playoff_team_count,
        "playoff_weeks_per_round": settings.playoff_matchup_period_length,
        "playoff_seed_tiebreaker": settings.playoff_seed_tie_rule,
        "matchup_tiebreaker": settings.tie_rule,
        "keeper_count": settings.keeper_count,
    }


@mcp.tool()
def get_draft_board(position: Optional[str] = None, limit: int = 15) -> dict:
    """THE one call to make when it's your pick: live draft status (current
    pick, who's on the clock, picks until your turn), your roster so far
    with the starting slots still open, and the best available players by
    value over replacement (VBD), plus the top few at each position. Player
    data comes from the local cache and live picks are polled in the
    background, so this answers in milliseconds. vbd = projected points over
    the last league-wide starter at that position; picks_past_adp > 0 means
    he's lasting longer than drafters usually let him.

    Args:
        position: only show this position in best_available (QB, RB, WR, TE, D/ST, K).
        limit: how many best-available players to return (default 15).
    """
    state = draft_state()
    clock = _clock(state)
    cache = player_cache()
    next_pick = clock.get("current_pick", {}).get("overall")
    avail = _available(state, position)
    ranked = sorted(
        avail,
        key=lambda p: (p["vbd"] is None, -(p["vbd"] or 0), p["espn_rank"] or 9999),
    )
    roster = _my_team_players(state) if not state["drafted"] else []
    by_position = {}
    for pos in ("QB", "RB", "WR", "TE", "D/ST", "K"):
        if pos in cache["starting_slots"] or any(pos in FLEX_SLOTS[f] for f in cache["starting_slots"] if f in FLEX_SLOTS):
            top = sorted((p for p in avail if p["position"] == pos and p["projected_points"]),
                         key=lambda p: -p["projected_points"])[:3]
            by_position[pos] = [f"{p['name']} ({p['projected_points']}, vbd {p['vbd']})" for p in top]
    return {
        "draft": clock,
        "last_picks": [_pick_label(p) for p in state["picks"][-5:]],
        "your_roster": [f"{p['name']} ({p['position']}, bye {p.get('bye_week')})" for p in roster],
        "open_starting_slots": _open_starting_slots(roster) if MY_TEAM_ID else None,
        "best_available": [_board_entry(p, next_pick) for p in ranked[:limit]],
        "top_by_position": by_position,
        "player_data_as_of": cache["built_at"],
        "picks_as_of_seconds_ago": round(time.time() - _draft_state_at, 1),
    }


@mcp.tool()
def get_draft_status() -> dict:
    """Get current draft progress: whether the draft has started, the current
    pick, whose turn it is, when you pick next, and the last 10 picks.
    Reads ESPN's live pick feed (refreshed every few seconds)."""
    state = draft_state()
    return {
        **_clock(state),
        "draft_type": state["type"],
        "draft_order": [_team_name(t) for t in state["order"]],
        "recent_picks": [_pick_label(p) for p in state["picks"][-10:]],
    }


@mcp.tool()
def get_drafted_players(team: Optional[str] = None) -> list[dict]:
    """Get every player already drafted, in draft order (live). Use this to
    know who is off the board.

    Args:
        team: optional team name (or part of it) to see just that team's picks.
    """
    state = draft_state()
    cache = player_cache()
    out = []
    for p in state["picks"]:
        team_name = _team_name(p["teamId"])
        if team and team.lower() not in team_name.lower():
            continue
        pl = cache["players"].get(str(p["playerId"]), {})
        out.append({
            "overall": p["overallPickNumber"],
            "round": p["roundId"],
            "pick": p["roundPickNumber"],
            "team": team_name,
            "player": pl.get("name", str(p["playerId"])),
            "position": pl.get("position"),
            "pro_team": pl.get("pro_team"),
            **({"bid": p["bidAmount"]} if p.get("bidAmount") else {}),
        })
    return out


@mcp.tool()
def get_available_players(position: Optional[str] = None, limit: int = 40, sort: str = "vbd") -> list[dict]:
    """Get the best undrafted players from the local cache (instant), minus
    everyone already picked in the live draft. Optionally filter by
    position: QB, RB, WR, TE, K, D/ST.

    Args:
        position: position filter, e.g. "RB". Omit for all positions.
        limit: max number of players to return (default 40).
        sort: "vbd" (value over replacement, default), "projection", "rank" (ESPN), or "adp".
    """
    state = draft_state()
    avail = _available(state, position)
    keys = {
        "vbd": lambda p: (p["vbd"] is None, -(p["vbd"] or 0)),
        "projection": lambda p: -(p["projected_points"] or 0),
        "rank": lambda p: p["espn_rank"] or 9999,
        "adp": lambda p: p["avg_draft_position"] or 9999,
    }
    avail.sort(key=keys.get(sort, keys["vbd"]))
    next_pick = _clock(state).get("current_pick", {}).get("overall")
    return [_board_entry(p, next_pick) for p in avail[:limit]]


@mcp.tool()
def search_players(name: str) -> list[dict]:
    """Look up players by name (partial or misspelled is fine) in the local
    cache: projection, rank, ADP, bye, injury, outlook, and whether he's
    still available or which team drafted him."""
    state = draft_state()
    cache = player_cache()
    drafted_by = {str(p["playerId"]): p for p in state["picks"]}
    wanted = _normalize(name)
    players = list(cache["players"].values())
    hits = [p for p in players if wanted and wanted in _normalize(p["name"])]
    if not hits:
        names = {_normalize(p["name"]): p for p in players}
        hits = [names[n] for n in get_close_matches(wanted, names.keys(), n=5, cutoff=0.6)]
    out = []
    for p in hits[:8]:
        pick = drafted_by.get(str(p["id"]))
        status = (f"drafted R{pick['roundId']}.{pick['roundPickNumber']} by {_team_name(pick['teamId'])}"
                  if pick else "available")
        out.append({**{k: v for k, v in p.items() if k != "id"}, "draft_status": status})
    return out


@mcp.tool()
def refresh_player_cache() -> dict:
    """Re-download the player pool (projections, ranks, ADP, injuries) and
    save it locally. Run this during draft prep or if injury news broke; it
    takes 10-20 seconds, so avoid it while you're on the clock."""
    cache = build_player_cache()
    counts: dict = {}
    for p in cache["players"].values():
        counts[p["position"]] = counts.get(p["position"], 0) + 1
    return {"players_cached": len(cache["players"]), "by_position": counts,
            "built_at": cache["built_at"], "file": str(PLAYER_CACHE_FILE)}


@mcp.tool()
def get_my_roster() -> list[dict]:
    """Get your own team's current roster: your picks so far while the draft
    is running (live), or your full ESPN roster once the draft is done.
    Requires ESPN_TEAM_ID to be set in .env."""
    if not MY_TEAM_ID:
        return [{"error": "ESPN_TEAM_ID not set in .env — see README for how to find it."}]
    state = draft_state()
    if not state["drafted"]:
        return [
            {"name": p["name"], "position": p["position"], "pro_team": p.get("pro_team"),
             "bye_week": p.get("bye_week"), "injury_status": p.get("injury_status")}
            for p in _my_team_players(state)
        ]
    league = get_league()
    league.refresh()
    team_id = int(MY_TEAM_ID)
    for team in league.teams:
        if team.team_id == team_id:
            return [
                {
                    "name": pl.name,
                    "position": pl.position,
                    "pro_team": pl.proTeam,
                }
                for pl in team.roster
            ]
    return [{"error": f"No team found with id {team_id}"}]


@mcp.tool()
def get_matchup_results(week: Optional[int] = None) -> list[dict]:
    """Get final matchup results for a given week: each game's two teams,
    final scores, projected scores, the winner, and margin of victory.
    Defaults to the most recently completed week ("last week") if no week
    is given — pass an explicit week number to look at a different one."""
    league = get_league()
    league.refresh()
    if week is None:
        week = max(league.current_week - 1, 1)
    results = []
    for box in league.box_scores(week=week):
        if not box.home_team or not box.away_team:
            continue
        margin = round(box.home_score - box.away_score, 1)
        if margin > 0:
            winner = box.home_team.team_name
        elif margin < 0:
            winner = box.away_team.team_name
        else:
            winner = "Tie"
        results.append({
            "week": week,
            "home_team": box.home_team.team_name,
            "home_score": round(box.home_score, 1),
            "home_projected": round(box.home_projected, 1),
            "away_team": box.away_team.team_name,
            "away_score": round(box.away_score, 1),
            "away_projected": round(box.away_projected, 1),
            "winner": winner,
            "margin": abs(margin),
        })
    return results


@mcp.tool()
def get_top_performers(week: Optional[int] = None, limit: int = 10) -> list[dict]:
    """Get the highest-scoring starters (bench/IR excluded) across the whole
    league for a given week, with actual vs. projected points — useful for
    calling out standout and disappointing performances in a weekly recap.
    Defaults to the most recently completed week if no week is given."""
    league = get_league()
    league.refresh()
    if week is None:
        week = max(league.current_week - 1, 1)
    performers = []
    for box in league.box_scores(week=week):
        for team, lineup in ((box.home_team, box.home_lineup), (box.away_team, box.away_lineup)):
            if not team:
                continue
            for p in lineup:
                if p.slot_position in ("BE", "IR"):
                    continue
                performers.append({
                    "player": p.name,
                    "team": team.team_name,
                    "position": p.slot_position,
                    "pro_team": p.proTeam,
                    "points": round(p.points, 1),
                    "projected_points": round(p.projected_points, 1),
                    "vs_projection": round(p.points - p.projected_points, 1),
                })
    performers.sort(key=lambda x: x["points"], reverse=True)
    return performers[:limit]


@mcp.tool()
def get_all_teams() -> list[dict]:
    """List every team in the league with their id, name, and owner —
    useful for finding your ESPN_TEAM_ID or seeing what other teams have
    drafted."""
    league = get_league()
    return [
        {
            "team_id": t.team_id,
            "team_name": t.team_name,
            "owner": t.owners[0].get("firstName", "") if t.owners else "",
        }
        for t in league.teams
    ]


class BearerAuthMiddleware:
    """Minimal ASGI middleware: rejects HTTP requests that don't carry the
    shared secret as `Authorization: Bearer <token>`. Only applied when
    MCP_AUTH_TOKEN is set — this is what stands between the public internet
    (once tunneled) and your ESPN session cookies, so it's not optional in
    HTTP mode."""

    def __init__(self, app, token: str):
        self.app = app
        self.token = token

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = dict(scope.get("headers") or [])
            auth = headers.get(b"authorization", b"").decode()
            if auth != f"Bearer {self.token}":
                from starlette.responses import JSONResponse

                response = JSONResponse({"error": "unauthorized"}, status_code=401)
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


if __name__ == "__main__":
    threading.Thread(target=_background_refresh, daemon=True).start()
    threading.Thread(target=_draft_poller, daemon=True).start()
    if MCP_HTTP_PORT:
        import uvicorn

        if not MCP_AUTH_TOKEN:
            raise RuntimeError(
                "MCP_HTTP_PORT is set but MCP_AUTH_TOKEN is not — refusing to "
                "serve ESPN credentials over HTTP with no auth."
            )
        app = BearerAuthMiddleware(mcp.streamable_http_app(), MCP_AUTH_TOKEN)
        uvicorn.run(app, host="0.0.0.0", port=int(MCP_HTTP_PORT))
    else:
        mcp.run()
