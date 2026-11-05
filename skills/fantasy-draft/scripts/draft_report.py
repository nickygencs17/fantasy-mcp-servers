"""Post-draft report card: how the user's picks compare with ADP and value,
their projected starting lineup, and how every team's lineup ranks.

    python3 <skill>/scripts/draft_report.py                      # your league, after the draft
    python3 <skill>/scripts/draft_report.py --league NNN   # a mock (uses the draft-room picks)

Picks come from ESPN once the draft is complete (the API shows them only
then), otherwise from the draft-room data saved by room_bridge.py (mock
leagues are deleted as soon as they end). Prints the report and saves it to
draft-cache/report-<league>.md.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from draftlib import FLEX_SLOTS, Espn, cache_path, load_env, use_league_arg  # noqa: E402
from pick import norm, room_seen  # noqa: E402


def best_lineup(roster: list, slots: dict) -> tuple:
    """Highest projected starting lineup: dedicated slots first, then flex."""
    left = sorted(roster, key=lambda p: -(p.get("proj") or 0))
    lineup = []
    for slot, count in sorted(slots.items(), key=lambda kv: kv[0] in FLEX_SLOTS):
        eligible = FLEX_SLOTS.get(slot, (slot,))
        for _ in range(count):
            pick = next((p for p in left if p["pos"] in eligible), None)
            if pick:
                lineup.append((slot, pick))
                left.remove(pick)
    return lineup, sum(p.get("proj") or 0 for _, p in lineup)


def expert_lineup(roster: list, slots: dict) -> tuple:
    """Starting lineup by FantasyPros expert rank (a second opinion that
    doesn't use the ESPN projections the picks were made with). Returns
    (lineup, average expert rank of the starters; lower is better)."""
    left = sorted(roster, key=lambda p: p.get("ecr") or 400)
    lineup, ranks = [], []
    for slot, count in sorted(slots.items(), key=lambda kv: kv[0] in FLEX_SLOTS):
        if slot in ("K", "D/ST"):  # experts' overall list ranks these in the hundreds; skip them
            continue
        eligible = FLEX_SLOTS.get(slot, (slot,))
        for _ in range(count):
            pick = next((p for p in left if p["pos"] in eligible), None)
            if pick:
                lineup.append((slot, pick))
                left.remove(pick)
            ranks.append(pick.get("ecr") or 400 if pick else 400)  # an empty starting slot counts as rank 400
    return lineup, (sum(ranks) / len(ranks) if ranks else 400)


def grade(rank: int, teams: int) -> str:
    pct = (rank - 1) / max(teams - 1, 1)
    return "A" if pct <= 0.15 else "B" if pct <= 0.4 else "C" if pct <= 0.65 else "D" if pct <= 0.85 else "F"


def main():
    use_league_arg()
    espn = Espn(load_env())
    path = cache_path(espn)
    if not path.exists():
        raise SystemExit(f"No board cache at {path}. Run draft_cache.py first.")
    cache = json.loads(path.read_text())
    players = {p["id"]: p for p in cache["players"]}
    by_norm = {norm(p["name"]): p for p in players.values()}
    teams = {int(k): v["name"] for k, v in cache["teams"].items()}
    team_by_name = {norm(v): k for k, v in teams.items()}
    me = cache.get("my_team_id")
    n = cache["team_count"]

    # (overall, team id, player) for every pick we can see
    picks, source = [], ""
    try:
        detail = espn.get(espn.league_url, ["mDraftDetail"]).get("draftDetail", {})
        made = [p for p in detail.get("picks", []) if p.get("playerId") not in (None, 0, -1)]
        if detail.get("drafted") and made:
            picks = [(p["overallPickNumber"], p["teamId"], players.get(p["playerId"])) for p in made]
            source = "ESPN (completed draft)"
    except Exception:
        pass
    if not picks:
        room_file = path.parent / f"room-{espn.league_id}.json"
        if not room_file.exists():
            raise SystemExit("No picks available: the draft isn't complete on ESPN and no draft-room data was saved.")
        room = json.loads(room_file.read_text())
        seen = room_seen(room, cache)
        for overall, (name, team) in sorted(seen.items()):
            pl = by_norm.get(norm(name)) or next((p for k, p in by_norm.items() if norm(name) in k), None)
            tid = team_by_name.get(norm(team))
            if tid is not None:
                picks.append((overall, tid, pl))
        source = f"draft room ({len(picks)} picks captured)"
    picks.sort(key=lambda x: x[0])

    rosters = {}
    for overall, tid, pl in picks:
        if pl:
            rosters.setdefault(tid, []).append((overall, pl))
    slots = cache["starting_slots"]
    totals = {tid: best_lineup([p for _, p in r], slots)[1] for tid, r in rosters.items()}
    ranking = sorted(totals, key=lambda t: -totals[t])
    has_experts = sum(1 for p in players.values() if p.get("ecr")) > 100
    expert_avg = {tid: expert_lineup([p for _, p in r], slots)[1] for tid, r in rosters.items()}
    expert_ranking = sorted(expert_avg, key=lambda t: expert_avg[t])

    out = [f"# Draft report: {teams.get(me, 'your team')}", f"_Picks from {source}; projections: "
           f"{cache.get('league', {}).get('projection_basis', 'ESPN')}._", ""]
    mine = rosters.get(me, [])
    if not mine:
        raise SystemExit("None of your picks were found in the captured data.")
    lineup, total = best_lineup([p for _, p in mine], slots)
    rank = ranking.index(me) + 1 if me in ranking else None
    values = [(o - pl["adp"], o, pl) for o, pl in mine if pl.get("adp")]
    avg_value = sum(v for v, _, _ in values) / len(values) if values else 0
    out.append(f"**Grade: {grade(rank, len(ranking)) if rank else '?'}** by ESPN projections: starters "
               f"{total:.0f} pts, #{rank} of {len(ranking)}")
    if has_experts and me in expert_avg:
        erank = expert_ranking.index(me) + 1
        out.append(f"**Expert grade: {grade(erank, len(expert_ranking))}** by FantasyPros rankings (a second opinion "
                   f"that doesn't use the projections the picks were made with): QB/RB/WR/TE starters average expert rank "
                   f"{expert_avg[me]:.0f}, #{erank} of {len(expert_ranking)}")
    stale_adp = sum(1 for p in players.values() if p.get("adp_market")) < 20  # no live market ADP (mid-season)
    out.append(f"Average pick {avg_value:+.1f} spots vs ADP ({'value' if avg_value > 0 else 'reaching'}"
               + ("; with no live market ADP, drafters follow ESPN's current rank more than ADP)" if stale_adp else ")"))
    if values:
        steal = max(values, key=lambda v: v[0])
        reach = min(values, key=lambda v: v[0])
        out.append(f"- Best value: {steal[2]['name']} at pick {steal[1]} (ADP {steal[2]['adp']:.0f}, {steal[0]:+.0f})")
        out.append(f"- Biggest reach: {reach[2]['name']} at pick {reach[1]} (ADP {reach[2]['adp']:.0f}, {reach[0]:+.0f})")
    out += ["", "## Your picks", "", "| Pick | Player | Pos | ADP | vs ADP | ESPN rank | Experts | Proj | VBD |",
            "|---|---|---|---|---|---|---|---|---|"]
    for o, pl in mine:
        diff = f"{o - pl['adp']:+.0f}" if pl.get("adp") else "-"
        out.append(f"| {o} | {pl['name']} | {pl['pos']} | {pl.get('adp') or '-'} | {diff} | {pl.get('rank') or '-'} | "
                   f"{pl.get('ecr') or '-'} | {pl.get('proj') or '-'} | {pl.get('vbd') if pl.get('vbd') is not None else '-'} |")
    out += ["", "## Projected starting lineup", ""]
    out += [f"- {slot}: {pl['name']} ({pl['pos']}, {pl['team']}) {pl.get('proj') or 0:.0f}" for slot, pl in lineup]
    out += ["", "## League", "", "| # | Team | Projected starters | Expert rank (avg starter) |", "|---|---|---|---|"]
    for i, tid in enumerate(ranking, 1):
        er = f"#{expert_ranking.index(tid) + 1} ({expert_avg[tid]:.0f})" if has_experts and tid in expert_avg else "-"
        out.append(f"| {i} | {teams.get(tid, tid)}{' (you)' if tid == me else ''} | {totals[tid]:.0f} | {er} |")
    text = "\n".join(out)
    print(text)
    report = path.parent / f"report-{espn.league_id}.md"
    report.write_text(text + "\n")
    print(f"\n(saved to {report})")


if __name__ == "__main__":
    main()
