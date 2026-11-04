"""Draft prep: download everything a pick could need, once, and save it to
draft-cache/board-<league>-<year>.json so every pick reads a local file.

    python3 <skill>/scripts/draft_cache.py          # from the folder with .env
    python3 <skill>/scripts/draft_cache.py --league NNN   # another league / mock draft

Cached (one request per source):
- ESPN player pool (600 deep; kickers too if the league starts one): projection, ESPN rank,
  positional rank, ESPN ADP, auction value, last season's points and
  points per game, roster %, injury tag, season outlook, bye
- ESPN injury report: status, body part, latest note for every listing
- Market ADP from Fantasy Football Calculator (preseason only; skipped
  when empty), blended with ESPN's ADP
- FantasyPros expert consensus rankings (ECR) as a second opinion: the draft
  cheat sheet before the season, rest-of-season rankings once it's underway,
  in the league's reception scoring (standard / half-PPR / PPR)
- Fantasy-playoff schedule: each player's week 15-17 opponents, rated by
  ESPN's defense-vs-position ranks
- League: scoring type, roster slots, bench, draft order and type, pick
  clock, teams and owners
- VBD (value over replacement) for this league's slots

Takes ~3-15 seconds. Run it during prep and again on draft day for fresh
injuries; never while on the clock. Only the live picks are left to fetch
at pick time.
"""

import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from draftlib import FLEX_SLOTS, POSITIONS, Espn, bench_count, cache_path, load_env, my_team_id, slot_counts, use_league_arg  # noqa: E402

POOL_SIZE = 600
INJURY_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries"
FFC_URL = "https://fantasyfootballcalculator.com/api/v1/adp/{fmt}?teams={teams}&year={year}"
POSITION_IDS = {"QB": 1, "RB": 2, "WR": 3, "TE": 4, "K": 5, "D/ST": 16}
FP_URLS = {  # (draft cheat sheet, rest-of-season) by points per reception
    0.0: ("consensus-cheatsheets.php", "ros-overall.php"),
    0.5: ("half-point-ppr-cheatsheets.php", "ros-half-point-ppr-overall.php"),
    1.0: ("ppr-cheatsheets.php", "ros-ppr-overall.php"),
}


def norm(name: str) -> str:
    name = re.sub(r"[^a-z0-9 ]", "", (name or "").lower())
    return " ".join(re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", name).split())


def fetch_json(url: str, timeout: int = 15):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (fantasy-draft skill)",
                                               "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def injury_report() -> dict:
    """(normalized name, team abbrev) -> short injury summary."""
    out = {}
    try:
        data = fetch_json(INJURY_URL)
    except Exception as exc:
        print(f"  injury report unavailable ({exc}); using ESPN fantasy tags only")
        return out
    for team in data.get("injuries", []):
        for inj in team.get("injuries", []):
            ath = inj.get("athlete", {})
            details = inj.get("details") or {}
            note = (inj.get("shortComment") or "").strip()
            out[norm(ath.get("displayName"))] = {
                "status": inj.get("status"),
                "body_part": details.get("type"),
                "return": details.get("returnDate"),
                "note": (note[:200] + "…") if len(note) > 200 else note,
                "date": (inj.get("date") or "")[:10],
            }
    return out


def market_adp(year: int, teams: int, rank_type: str) -> dict:
    """normalized name -> Fantasy Football Calculator ADP (empty mid-season)."""
    fmt = {"PPR": "ppr", "STANDARD": "standard"}.get(rank_type, "half-ppr")
    try:
        data = fetch_json(FFC_URL.format(fmt=fmt, teams=teams, year=year))
    except Exception as exc:
        print(f"  market ADP unavailable ({exc}); using ESPN ADP only")
        return {}
    return {norm(p["name"]): {"adp": p.get("adp"), "high": p.get("high"), "low": p.get("low"), "stdev": p.get("stdev")}
            for p in data.get("players", [])}


def expert_rankings(ppr: float, in_season: bool) -> tuple:
    """FantasyPros consensus: {(normalized name or team for D/ST, pos): ranks}, label."""
    draft_page, ros_page = FP_URLS.get(ppr, FP_URLS[0.5])
    page = ros_page if in_season else draft_page
    url = f"https://www.fantasypros.com/nfl/rankings/{page}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (fantasy-draft skill)"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            html = resp.read().decode("utf-8", "ignore")
        data = json.loads(re.search(r"var ecrData = (\{.*?\});", html, re.S).group(1))
    except Exception as exc:
        print(f"  FantasyPros rankings unavailable ({exc}); using ESPN only")
        return {}, None
    out = {}
    for p in data.get("players", []):
        pos = {"DST": "D/ST"}.get(p.get("player_position_id"), p.get("player_position_id"))
        key = (p.get("player_team_id") or "").upper() if pos == "D/ST" else norm(p.get("player_name"))
        out[(key, pos)] = {"ecr": p.get("rank_ecr"), "ecr_pos": p.get("pos_rank"), "ecr_tier": p.get("tier"),
                           "ecr_std": p.get("rank_std")}
    label = f"FantasyPros {'rest-of-season' if in_season else 'draft'} ECR ({page}, updated {data.get('last_updated')})"
    return out, label


def player_record(entry: dict, year: int, rank_type: str, pro: dict) -> dict:
    pl = entry.get("player", entry)
    stats = {s.get("id"): s for s in pl.get("stats", [])}
    proj = stats.get(f"10{year}", {}).get("appliedTotal")
    last = stats.get(f"00{year - 1}", {})
    ranks = pl.get("draftRanksByRankType", {}).get(rank_type, {})
    own = pl.get("ownership", {})
    team = pro.get(pl.get("proTeamId"), {})
    outlook = (pl.get("seasonOutlook") or "").strip()
    return {
        "id": pl["id"],
        "name": pl.get("fullName"),
        "pos": POSITIONS.get(pl.get("defaultPositionId"), "?"),
        "team": team.get("abbrev", "FA"),
        "pro_team_id": pl.get("proTeamId"),
        "bye": team.get("bye"),
        "rank": ranks.get("rank"),
        "auction": ranks.get("auctionValue"),
        "adp_espn": round(own["averageDraftPosition"], 1) if own.get("averageDraftPosition") else None,
        "proj": round(proj, 1) if proj is not None else None,
        "last_season": round(last["appliedTotal"], 1) if last.get("appliedTotal") is not None else None,
        "last_season_ppg": round(last["appliedAverage"], 1) if last.get("appliedAverage") else None,
        "owned": round(own.get("percentOwned", 0), 1),
        "injury": pl.get("injuryStatus") or "ACTIVE",
        "outlook": (outlook[:400] + "…") if len(outlook) > 400 else outlook,
    }


def add_vbd(players: list, slots: dict, teams: int) -> dict:
    """Projection minus the last league-wide starter at the position (flex
    slots go to the best remaining eligible player). Returns baselines."""
    by_pos = {}
    for p in players:
        if p["proj"] is not None:
            by_pos.setdefault(p["pos"], []).append(p)
    for lst in by_pos.values():
        lst.sort(key=lambda p: p["proj"], reverse=True)
    starters = {pos: slots.get(pos, 0) * teams for pos in by_pos}
    for flex, eligible in FLEX_SLOTS.items():
        for _ in range(slots.get(flex, 0) * teams):
            best = max((pos for pos in eligible if starters.get(pos, 0) < len(by_pos.get(pos, []))),
                       key=lambda pos: by_pos[pos][starters[pos]]["proj"], default=None)
            if best:
                starters[best] += 1
    baselines = {}
    for pos, lst in by_pos.items():
        n = starters.get(pos, 0)
        if n:
            baselines[pos] = lst[min(n, len(lst)) - 1]["proj"]
    for p in players:
        base = baselines.get(p["pos"])
        p["vbd"] = round(p["proj"] - base, 1) if base is not None and p["proj"] is not None else None
    return baselines


def main():
    t0 = time.time()
    use_league_arg()
    espn = Espn(load_env())
    meta = espn.get(espn.league_url, ["mSettings", "mTeam"])
    settings = meta.get("settings", {})
    rank_type = settings.get("scoringSettings", {}).get("playerRankType") or "PPR"
    slots = slot_counts(settings)
    teams = settings.get("size") or len(meta.get("teams", [])) or 10
    regular_weeks = settings.get("scheduleSettings", {}).get("matchupPeriodCount", 14)
    final_week = meta.get("status", {}).get("finalScoringPeriod", 17)
    playoff_weeks = list(range(regular_weeks + 1, final_week + 1))

    season = espn.get(espn.season_url, ["proTeamSchedules_wl"])
    pro, games = {}, {}
    for t in season.get("settings", {}).get("proTeams", []):
        pro[t["id"]] = {"abbrev": (t.get("abbrev") or "FA").upper(), "bye": t.get("byeWeek")}
    for t in season.get("settings", {}).get("proTeams", []):
        for week, lst in (t.get("proGamesByScoringPeriod") or {}).items():
            if lst and int(week) in playoff_weeks:
                g = lst[0]
                home = g["homeProTeamId"] == t["id"]
                opp = g["awayProTeamId"] if home else g["homeProTeamId"]
                games.setdefault(t["id"], {})[int(week)] = (opp, f"{'vs ' if home else '@'}{pro.get(opp, {}).get('abbrev', opp)}")

    stat_ids = [f"00{espn.year}", f"10{espn.year}", f"00{espn.year - 1}"]
    data = espn.get(espn.league_url, ["kona_player_info"], {"players": {
        "limit": POOL_SIZE,
        "sortDraftRanks": {"sortPriority": 100, "sortAsc": True, "value": rank_type},
        "filterStatsForTopScoringPeriodIds": {"value": 1, "additionalValue": stat_ids},
    }}, timeout=60)
    players = [player_record(e, espn.year, rank_type, pro) for e in data.get("players", [])]
    dvp = data.get("positionAgainstOpponent", {}).get("positionalRatings", {})

    injuries = injury_report()
    market = market_adp(espn.year, teams, rank_type)
    ppr = next((float(i.get("points", 0)) for i in settings.get("scoringSettings", {}).get("scoringItems", [])
                if i.get("statId") == 53), 0.5)
    scoring_period = meta.get("scoringPeriodId") or 1
    in_season = scoring_period > 1
    experts, experts_label = expert_rankings(ppr, in_season)
    pos_counter = {}
    for p in sorted(players, key=lambda p: p["rank"] or 9999):
        pos_counter[p["pos"]] = pos_counter.get(p["pos"], 0) + 1
        p["pos_rank"] = f"{p['pos']}{pos_counter[p['pos']]}"
        key = norm(p["name"])
        inj = injuries.get(key)
        if inj:
            p["injury_detail"] = inj
        m = market.get(key)
        if m and m.get("adp"):
            p["adp_market"] = round(m["adp"], 1)
        e = experts.get((p["team"], "D/ST") if p["pos"] == "D/ST" else (key, p["pos"]))
        if e:
            p.update({k: v for k, v in e.items() if v is not None})
        # Blended ADP: average the two markets when both exist
        sources = [x for x in (p.get("adp_market"), p["adp_espn"]) if x]
        p["adp"] = round(sum(sources) / len(sources), 1) if sources else None
        ratings = dvp.get(str(POSITION_IDS.get(p["pos"], 0)), {}).get("ratingsByOpponent", {})
        sched = games.get(p["pro_team_id"], {})
        if sched:
            p["playoff_games"] = [label for _, (_, label) in sorted(sched.items())]
            opp_ranks = [ratings[str(opp)]["rank"] for opp, _ in sched.values() if str(opp) in ratings]
            if opp_ranks:
                # 1 = toughest defense vs his position, 32 = easiest
                p["playoff_matchup_rank"] = round(sum(opp_ranks) / len(opp_ranks), 1)
    baselines = add_vbd(players, slots, teams)

    members = {m["id"]: m for m in meta.get("members", [])}
    team_names = {}
    for t in meta.get("teams", []):
        owner = members.get((t.get("owners") or [None])[0], {})
        team_names[str(t["id"])] = {"name": (t.get("name") or f"Team {t['id']}").strip(),
                                    "abbrev": t.get("abbrev"), "owner": owner.get("firstName", "")}
    ds = settings.get("draftSettings", {})
    cache = {
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "league_id": espn.league_id,
        "year": espn.year,
        "my_team_id": my_team_id(espn, meta.get("teams", [])),
        "league": {
            "name": settings.get("name"),
            "scoring": settings.get("scoringSettings", {}).get("scoringType"),
            "rank_type": rank_type,
            "team_count": teams,
            "starting_slots": slots,
            "bench": bench_count(settings),
            "draft_type": ds.get("type"),
            "draft_order": [team_names.get(str(t), {}).get("name", t) for t in ds.get("pickOrder") or []],
            "draft_order_ids": ds.get("pickOrder") or [],
            "seconds_per_pick": ds.get("timePerSelection"),
            "draft_date": ds.get("date"),
            "playoff_weeks": playoff_weeks,
            "points_per_reception": ppr,
            "projection_basis": (f"rest of season (from week {scoring_period})" if in_season else "full season"),
        },
        "rank_type": rank_type,
        "team_count": teams,
        "starting_slots": slots,
        "bench": bench_count(settings),
        "baselines": baselines,
        "teams": team_names,
        "pro_teams": {str(k): v for k, v in pro.items()},
        "sources": {"players": len(players), "injury_listings": len(injuries), "market_adp": len(market),
                    "expert_rankings": experts_label,
                    "expert_matched": sum(1 for p in players if p.get("ecr"))},
        "players": players,
    }
    path = cache_path(espn)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(cache))
    tmp.replace(path)

    by_pos = {}
    for p in players:
        by_pos[p["pos"]] = by_pos.get(p["pos"], 0) + 1
    top = sorted((p for p in players if p["vbd"] is not None), key=lambda p: -p["vbd"])[:5]
    kb = path.stat().st_size // 1024
    print(f"Cached {len(players)} players ({by_pos}) to {path} ({kb} KB) in {time.time() - t0:.1f}s")
    print(f"Injury listings matched: {sum(1 for p in players if 'injury_detail' in p)} of {len(injuries)}; "
          f"market ADP: {len(market)} players{' (empty: in-season or not published yet)' if not market else ''}")
    print(f"League: {slots}, bench {bench_count(settings)}, {teams} teams, {ppr:g} PPR; playoff weeks {playoff_weeks}")
    print(f"Projections: {'rest of season (week ' + str(scoring_period) + ' on)' if in_season else 'full season'}; "
          f"experts: {experts_label or 'none'} matched {sum(1 for p in players if p.get('ecr'))} players")
    print("Top VBD: " + "; ".join(f"{p['name']} {p['pos']} {p['vbd']}" for p in top))


if __name__ == "__main__":
    main()
