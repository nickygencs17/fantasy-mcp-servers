"""
ESPN Fantasy Football MCP Server
---------------------------------
Exposes live draft/league state from a private ESPN Fantasy Football
league to any MCP client (e.g. Claude Desktop). Read-only: it does NOT
submit draft picks (ESPN doesn't support that via API during a live
draft) — you still pick in ESPN's UI. This server just gives Claude
the live state so it can advise you.

Setup:
    pip install -r requirements.txt
    cp .env.example .env   # fill in your values
    python server.py       # for local testing
Then point Claude Desktop's config at this server (see README.md).
"""

import os
from datetime import datetime
from typing import Optional

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
def get_draft_status() -> dict:
    """Get current draft progress: how many picks have been made, whose
    turn it is (if draft is in progress), and the full draft order."""
    league = get_league()
    league.refresh()
    picks = league.draft
    return {
        "total_picks_made": len(picks),
        "is_active": league.settings.name is not None,
        "recent_picks": [
            {
                "round": p.round_num,
                "pick_in_round": p.round_pick,
                "team": p.team.team_name,
                "player": p.playerName,
            }
            for p in picks[-10:]
        ],
    }


@mcp.tool()
def get_drafted_players() -> list[dict]:
    """Get the full list of players already drafted, in draft order.
    Use this to know who is off the board."""
    league = get_league()
    league.refresh()
    return [
        {
            "round": p.round_num,
            "pick": p.round_pick,
            "team": p.team.team_name,
            "player": p.playerName,
        }
        for p in league.draft
    ]


@mcp.tool()
def get_available_players(position: Optional[str] = None, limit: int = 40) -> list[dict]:
    """Get top available (undrafted) free agent players, ranked by ESPN's
    projection. Optionally filter by position: QB, RB, WR, TE, K, D/ST.

    Args:
        position: position filter, e.g. "RB". Omit for all positions.
        limit: max number of players to return (default 40).
    """
    league = get_league()
    players = league.free_agents(size=limit * 3, position=position)
    out = []
    for p in players[:limit]:
        out.append({
            "name": p.name,
            "position": p.position,
            "pro_team": p.proTeam,
            "projected_points": round(p.projected_total_points, 1) if p.projected_total_points else None,
            "avg_draft_position": getattr(p, "posRank", None),
            "injury_status": p.injuryStatus,
        })
    return out


@mcp.tool()
def get_my_roster() -> list[dict]:
    """Get your own team's current roster (players drafted so far this
    draft, or full roster if season has started). Requires ESPN_TEAM_ID
    to be set in .env."""
    league = get_league()
    league.refresh()
    if not MY_TEAM_ID:
        return [{"error": "ESPN_TEAM_ID not set in .env — see README for how to find it."}]
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
