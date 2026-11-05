"""Who to draft right now, in under a second. Reads the local board cache
(draft_cache.py), makes one small request for the live picks, and ranks
the options.

    python3 <skill>/scripts/pick.py                      # live draft
    python3 <skill>/scripts/pick.py --league NNN  # another league / mock draft
    python3 <skill>/scripts/pick.py --taken "Name, Name"  # picks ESPN hasn't shown yet
    python3 <skill>/scripts/pick.py --simulate-picks 23   # test: rewind a finished draft

How it decides:
- Simulates every pick before your turn, and between your turn and your next
  one, team by team in snake order: each team takes the player the room
  values most (a blend of ADP, ESPN's current rank and the expert rank,
  re-fit to this draft's own picks after 8 picks) after adjusting for its
  roster (a team with its QB or TE filled rarely takes another early; nobody
  takes D/ST or K before the last rounds; teams already deep at RB/WR slow
  down) and for position runs (two of the last three picks at a position
  make it more likely). 40 randomized runs give each player's chance of
  lasting to your next pick.
- One-pick lookahead: each top option is paired with the best player likely
  left at your next pick, so someone who'll still be there waits and a
  scarce player goes now.
- Handcuffs: after the starting rounds, the backup RB behind each of your
  starting RBs gets a bonus (a quarter of the starter's value over
  replacement), taken when he might not last or the free bench picks run out.
- VONA (value over next available): a player's projection minus the best
  projection left at his position when your next pick comes around, i.e.
  what you lose by waiting. Blended with VBD (value over replacement).
- Weighted by roster need (open starting slot > flex > bench), D/ST and K
  held until the last rounds, injury tags, bye-week stacking, and a small
  (+/-3%) nudge for easy or tough fantasy-playoff matchups.

Other views, all from the local cache plus the live picks:
    --player "Name"    full card: ranks, projection, ADP, last season,
                       injury details, outlook, playoff games, still available?
    --position RB      best available at one position
"""

import argparse
import json
import math
import os
import random
import re
import sys
import time
from datetime import datetime
from difflib import get_close_matches
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from draftlib import FLEX_SLOTS, Espn, cache_path, load_env, slot_counts, bench_count, team_for_pick, use_league_arg  # noqa: E402

INJURY_FACTOR = {"OUT": 0.45, "INJURY_RESERVE": 0.45, "SUSPENSION": 0.45, "DOUBTFUL": 0.7, "QUESTIONABLE": 0.92}
VONA_WEIGHT, VBD_WEIGHT = 0.55, 0.45
LATE_POSITIONS = ("D/ST", "K")
# Look one pick ahead: for the top options, add the value of the best player
# likely left at your next pick (from SIM_RUNS randomized runs of the picks in
# between), so a player who'll still be there waits and the one who won't is
# taken now. LOOKAHEAD scales that second pick (0 turns it off).
LOOKAHEAD = float(os.environ.get("DRAFT_LOOKAHEAD", "1.0"))
LOOKAHEAD_TOP = 8
# Handcuffs: once the starting rounds are done, the backup RB on the same NFL
# team as one of your starting RBs gets a bonus worth this share of that
# starter's value over replacement (x1.5 if the starter is already hurt), so
# you can plug him in if the starter goes down.
HANDCUFF_SHARE = float(os.environ.get("DRAFT_HANDCUFF_SHARE", "0.25"))
SIM_RUNS = 40
# How the other drafters pick: a blend of ESPN ADP, ESPN's current rank and
# the FantasyPros expert rank. Re-fit from the draft's own picks once
# CALIBRATE_AFTER picks are in (mock drafters follow ESPN's rank; a real
# preseason room follows ADP more).
SOURCES = ("adp", "rank", "ecr")
DEFAULT_WEIGHTS = {"adp": 0.4, "rank": 0.4, "ecr": 0.2}
DEFAULT_SIGMA = 0.3
CALIBRATE_AFTER = 8


def norm(name: str) -> str:
    name = re.sub(r"[^a-z0-9/ ]", "", (name or "").lower())
    return re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", name).strip()


def expected_pick(p: dict, weights: dict = None) -> float:
    """Where the room is expected to take this player (overall pick)."""
    weights = weights or DEFAULT_WEIGHTS
    total = wsum = 0.0
    for key, w in weights.items():
        v = p.get(key)
        if w and v:
            total += w * v
            wsum += w
    return total / wsum if wsum else 400.0


def calibrate(picked: list) -> tuple:
    """Fit the blend to picks already made: picked = [(overall, player)].
    Returns (weights, sigma, note). Sigma is the spread of log(actual /
    expected), used to randomize the simulation."""
    rows = [(o, p) for o, p in picked if p and o > 0]
    if len(rows) < CALIBRATE_AFTER:
        return DEFAULT_WEIGHTS, DEFAULT_SIGMA, ""
    present = [s for s in SOURCES if sum(1 for _, p in rows if p.get(s)) >= 0.6 * len(rows)]
    grid = []
    steps = [i / 4 for i in range(5)]
    for a in steps:
        for b in steps:
            c = round(1 - a - b, 2)
            if c < 0:
                continue
            w = {k: v for k, v in zip(SOURCES, (a, b, c)) if k in present and v}
            if w and abs(sum(w.values()) - 1) < 1e-6:
                grid.append(w)
    if not grid:
        return DEFAULT_WEIGHTS, DEFAULT_SIGMA, ""

    def resid(w):
        return [math.log(o / expected_pick(p, w)) for o, p in rows]
    best = min(grid, key=lambda w: sum(abs(r) for r in resid(w)))
    res = resid(best)
    mean = sum(res) / len(res)
    sigma = max(0.15, min(0.6, (sum((r - mean) ** 2 for r in res) / len(res)) ** 0.5))
    note = "room drafts by " + " + ".join(f"{int(v * 100)}% {k.replace('ecr', 'experts').replace('rank', 'ESPN rank').replace('adp', 'ADP')}"
                                          for k, v in sorted(best.items(), key=lambda kv: -kv[1]))
    return best, sigma, note


def market_order(players: list, weights: dict = None) -> list:
    """How other drafters are likely to pick."""
    return sorted(players, key=lambda p: expected_pick(p, weights))


def team_weight(p: dict, roster: list, slots: dict, rounds_left: int, recent: list) -> float:
    """How likely a team is to want this position now (1 = normal; lower =
    they'll pass on him even if his ADP says otherwise)."""
    pos = p["pos"]
    have = sum(1 for r in roster if r["pos"] == pos)
    if pos in LATE_POSITIONS:
        if have:
            return 0.05
        return 1.0 if rounds_left <= 2 else 0.15
    dedicated = slots.get(pos, 0)
    flex = sum(n for f, n in slots.items() if f in FLEX_SLOTS and pos in FLEX_SLOTS[f])
    if pos in ("QB", "TE") and dedicated and have >= dedicated:
        weight = 0.35 if have == dedicated else 0.1
    elif have >= dedicated + flex + 2:
        weight = 0.7
    else:
        weight = 1.0
    if sum(1 for x in recent[-3:] if x == pos) >= 2:  # position run in progress
        weight *= 1.15
    return weight


def simulate(pool: list, start: int, end: int, order: list, dtype: str, me, rosters: dict,
             slots: dict, rounds: int, n: int, recent: list, weights: dict = None,
             sigma: float = 0.0, rng=None):
    """Picks start..end-1 by the other teams. Returns (ids taken, rosters, recent).
    With sigma and rng, each player's expected pick is randomized once per run
    (drafters disagree), for the chance-he-lasts estimate."""
    value = {p["id"]: expected_pick(p, weights) for p in pool}
    if sigma and rng:
        value = {k: v * math.exp(rng.gauss(0, sigma)) for k, v in value.items()}
    market = sorted(pool, key=lambda p: value[p["id"]])
    rosters = {t: list(v) for t, v in rosters.items()}
    recent = list(recent)
    gone = set()
    for k in range(start, end):
        team = team_for_pick(order, dtype, k)
        if team == me or team is None:
            continue
        roster = rosters.setdefault(team, [])
        rounds_left = rounds - ((k - 1) // n + 1)
        best, best_score, looked = None, None, 0
        for cand in market:
            if cand["id"] in gone:
                continue
            score = value[cand["id"]] / team_weight(cand, roster, slots, rounds_left, recent)
            if best_score is None or score < best_score:
                best, best_score = cand, score
            looked += 1
            if looked >= 40:
                break
        if best is None:
            break
        gone.add(best["id"])
        roster.append(best)
        recent.append(best["pos"])
    return gone, rosters, recent


def gone_chance(pool: list, start: int, end: int, order: list, dtype: str, me, rosters: dict,
                slots: dict, rounds: int, n: int, recent: list, weights: dict, sigma: float,
                seed: int, runs: int = SIM_RUNS) -> tuple:
    """Randomized runs of picks start..end-1. Returns (chance each player is
    taken, the set taken in each run)."""
    rng = random.Random(seed)
    count, sets = {}, []
    for _ in range(runs):
        gone, _, _ = simulate(pool, start, end, order, dtype, me, rosters, slots, rounds, n, recent, weights, sigma, rng)
        sets.append(gone)
        for pid in gone:
            count[pid] = count.get(pid, 0) + 1
    return {pid: c / runs for pid, c in count.items()}, sets


def open_slots(roster: list, slots: dict) -> dict:
    remaining = dict(slots)
    leftovers = []
    for p in roster:
        if remaining.get(p["pos"], 0) > 0:
            remaining[p["pos"]] -= 1
        else:
            leftovers.append(p["pos"])
    for pos in leftovers:
        for flex, eligible in FLEX_SLOTS.items():
            if pos in eligible and remaining.get(flex, 0) > 0:
                remaining[flex] -= 1
                break
    return {k: v for k, v in remaining.items() if v > 0}


def show_lookup(args, players: dict, picks: list, taken: set, cache: dict) -> None:
    drafted_by = {p["playerId"]: p for p in picks}
    team_name = lambda tid: cache["teams"].get(str(tid), {}).get("name", f"Team {tid}")  # noqa: E731
    if args.player:
        want = norm(args.player)
        hits = [p for p in players.values() if want and want in norm(p["name"])]
        if not hits:
            names = {norm(p["name"]): p for p in players.values()}
            hits = [names[k] for k in get_close_matches(want, names.keys(), n=3, cutoff=0.6)]
        if not hits:
            print(f"No cached player matches \"{args.player}\".")
        for p in hits[:3]:
            pick = drafted_by.get(p["id"])
            status = (f"DRAFTED R{pick['roundId']}.{pick['roundPickNumber']} by {team_name(pick['teamId'])}"
                      if pick else ("TAKEN (per --taken)" if p["id"] in taken else "AVAILABLE"))
            print(f"{p['name']} ({p['pos']}, {p['team']}, bye {p['bye']}) — {status}")
            print(f"  {p.get('pos_rank')} | ESPN rank {p['rank']} | ADP {p['adp']} (ESPN {p['adp_espn']}"
                  f"{', market ' + str(p['adp_market']) if p.get('adp_market') else ''}) | proj {p['proj']} | VBD {p['vbd']}")
            print(f"  last season {p['last_season']} pts, {p['last_season_ppg']} ppg | {p['owned']}% rostered")
            d = p.get("injury_detail") or {}
            if p["injury"] != "ACTIVE" or d.get("status") not in (None, "Active"):
                print(f"  injury: {p['injury']} {d.get('body_part') or ''} {('back ~' + d['return']) if d.get('return') else ''} — {d.get('note', '')}")
            if p.get("playoff_games"):
                print(f"  playoffs: {', '.join(p['playoff_games'])} (avg defense rank vs {p['pos']}: {p.get('playoff_matchup_rank')}, 32 = easiest)")
            if p.get("outlook"):
                print(f"  outlook: {p['outlook']}")
    if args.position:
        pos = args.position.upper().replace("DST", "D/ST")
        avail = sorted((p for p in players.values() if p["pos"] == pos and p["id"] not in taken and p["proj"] is not None),
                       key=lambda p: -(p["vbd"] if p["vbd"] is not None else -999))
        print(f"Best available {pos}:")
        for p in avail[:args.top + 5]:
            inj = "" if p["injury"] == "ACTIVE" else f", {p['injury']}"
            print(f"  {p['name']} ({p['team']}, bye {p['bye']}) proj {p['proj']}, VBD {p['vbd']}, ADP {p['adp']}{inj}")


def need_factor(p: dict, opened: dict, my_picks_left: int) -> tuple:
    if p["pos"] in LATE_POSITIONS:
        late_slots = sum(opened.get(x, 0) for x in LATE_POSITIONS)
        if opened.get(p["pos"], 0) and my_picks_left <= late_slots + 1:
            return 1.0, f"fills {p['pos']}"
        if opened.get(p["pos"], 0):
            return 0.2, "too early for " + p["pos"]
        return 0.05, "no slot"
    if opened.get(p["pos"], 0):
        return 1.0, f"fills {p['pos']}"
    for flex, eligible in FLEX_SLOTS.items():
        if p["pos"] in eligible and opened.get(flex, 0):
            return 0.95, f"fills {flex}"
    # Running out of picks to fill starting slots: bench picks can wait
    if my_picks_left <= sum(opened.values()):
        return 0.05, "bench (starters still open)"
    return (0.35 if p["pos"] == "QB" else 0.55), "bench depth"


def room_seen(room: dict, cache: dict) -> dict:
    """Picks the draft room showed: {overall: (player name, fantasy team)}.
    Pick History rows sometimes pick up the clock (":02") or a "DRAFTED"
    label as the team, so a row only counts when its team is a real team in
    this league, and the scrolling feed (more reliable) wins over the table."""
    n = cache["team_count"]
    known = {norm(t["name"]) for t in cache["teams"].values()}
    bogus = {"queue", "draft", "drafted", "add", "remove"}

    def ok(team, name):
        t = norm(team)
        return t not in bogus and (t in known or not known) and norm(name) not in known

    seen = {}
    for overall, name, team in room.get("history", []):
        if ok(team, name) and 0 < overall <= n * 40:
            seen[overall] = (name, team)
    for rnd, pick_in_round, name, team in room.get("feed", []):
        if ok(team, name):
            seen[(rnd - 1) * n + pick_in_round] = (name, team)
    return seen


def handcuffs(roster: list, players, slots: dict) -> dict:
    """{backup RB id: (your starter, bonus)} for each of your starting RBs:
    the highest-projected healthy RB on the same NFL team besides him."""
    flex_rb = sum(c for f, c in slots.items() if f in FLEX_SLOTS and "RB" in FLEX_SLOTS[f])
    starters = sorted((p for p in roster if p["pos"] == "RB"), key=lambda p: -(p["proj"] or 0))
    starters = starters[: slots.get("RB", 0) + flex_rb]
    mine = {p["id"] for p in roster}
    out = {}
    for st in starters:
        if not st.get("team") or (st["vbd"] or 0) <= 0:
            continue
        backups = [p for p in players if p["pos"] == "RB" and p["team"] == st["team"] and p["id"] != st["id"]
                   and p["injury"] not in ("OUT", "INJURY_RESERVE", "SUSPENSION") and (p["proj"] or 0) > 0]
        if not backups:
            continue
        backup = max(backups, key=lambda p: p["proj"])
        if backup["id"] in mine:
            continue
        hurt = 1.5 if st["injury"] != "ACTIVE" else 1.0
        out[backup["id"]] = (st, HANDCUFF_SHARE * st["vbd"] * hurt)
    return out


def rank_options(avail: list, roster: list, opened: dict, mine: list, current: int, order: list, dtype: str,
                 me, rosters: dict, slots: dict, rounds: int, n: int, recent: list,
                 weights: dict = None, sigma: float = DEFAULT_SIGMA, lookahead: float = None,
                 all_players: list = None) -> tuple:
    """Score the options for the user's next pick (mine[0]).
    Returns (scored, chance each player is gone by the pick after that)."""
    lookahead = LOOKAHEAD if lookahead is None else lookahead
    my_pick = mine[0]
    # Expected board when your pick comes up, then what's gone by your next one
    gone_first, rosters_at_mine, recent_at_mine = simulate(avail, current, my_pick, order, dtype, me, rosters,
                                                           slots, rounds, n, recent, weights)
    pool = [p for p in avail if p["id"] not in gone_first]
    next_mine = mine[1] if len(mine) > 1 else my_pick + 1
    gone_later, _, _ = simulate(pool, my_pick + 1, next_mine, order, dtype, me, rosters_at_mine, slots, rounds, n,
                                recent_at_mine, weights)
    chance, runs = gone_chance(pool, my_pick + 1, next_mine, order, dtype, me, rosters_at_mine, slots, rounds, n,
                               recent_at_mine, weights, sigma, seed=my_pick) if len(mine) > 1 else ({}, [])
    my_byes = {(p["pos"], p["bye"]) for p in roster}
    picks_left = len(mine)
    # Handcuffs only after the starting rounds (bench rounds)
    late = (my_pick - 1) // n + 1 > sum(slots.values())
    cuffs = handcuffs(roster, all_players or avail, slots) if late and HANDCUFF_SHARE else {}
    cuffs = {k: v for k, v in cuffs.items() if any(p["id"] == k for p in pool)}
    # Picks not needed for open starting slots; once they're down to the
    # number of handcuffs still on the board, it's now or never
    free_picks = picks_left - sum(opened.values())
    now_or_never = free_picks <= len(cuffs)

    scored = []
    top = sorted(pool, key=lambda p: -(p["vbd"] or 0))[:60]
    top += [p for p in pool if p["id"] in cuffs and p not in top]
    for c in top:
        later = [p for p in pool if p["id"] != c["id"] and p["id"] not in gone_later]
        next_same = max((p["proj"] for p in later if p["pos"] == c["pos"]), default=0)
        vona = c["proj"] - next_same
        need, need_why = need_factor(c, opened, picks_left)
        injury = INJURY_FACTOR.get(c["injury"], 1.0)
        bye = 0.97 if (c["pos"], c["bye"]) in my_byes and c["id"] not in cuffs else 1.0
        # Playoff schedule nudge: rank 1 (toughest) -3% ... rank 32 (easiest) +3%
        playoff = 1 + 0.03 * ((c.get("playoff_matchup_rank") or 16.5) - 16.5) / 15.5
        base = VONA_WEIGHT * max(vona, 0) + VBD_WEIGHT * max(c["vbd"] or 0, 0)
        if base <= 0:  # late rounds: everyone's below replacement, go by projection
            base = 0.1 * c["proj"]
        # Expert second opinion (FantasyPros): +/-10% when experts rank him
        # well above or below where drafters take him
        ecr, market_rank = c.get("ecr"), c["adp"] or c["rank"]
        expert = 1 + max(-0.1, min(0.1, 0.1 * (market_rank - ecr) / max(ecr, 10))) if ecr and market_rank else 1.0
        score = base * need * injury * bye * playoff * expert
        if c["id"] in cuffs and need_why == "bench depth":
            starter, bonus = cuffs[c["id"]]
            # Wait rule for handcuffs: only worth a pick now if he might not
            # last to the next one, or the free bench picks are running out
            urgency = 1.0 if now_or_never or not chance else chance.get(c["id"], 0)
            score += bonus * injury * urgency
            last = [w for w in starter["name"].split() if w.rstrip(".") not in ("Jr", "Sr", "II", "III", "IV", "V")][-1]
            need_why = f"handcuff to {last} ({starter['team']})"
        scored.append((score, c, vona, need_why, base * injury * playoff * expert))
    scored.sort(key=lambda x: -x[0])

    if lookahead and runs:
        # Pair this pick with the best player expected at the next one: take
        # c now, then in each randomized run, the best player still there
        # (scored for the roster with c on it). Averaged over the runs.
        def next_value(c):
            opened_after = open_slots(roster + [c], slots)
            later = sorted(((rest * need_factor(d, opened_after, picks_left - 1)[0], d["id"])
                            for _, d, _, _, rest in scored if d["id"] != c["id"]), reverse=True)
            total = 0.0
            for gone in runs:
                total += next((v for v, pid in later if pid not in gone), 0.0)
            return total / len(runs)
        top = [(s[0] + lookahead * next_value(s[1]),) + s[1:] for s in scored[:LOOKAHEAD_TOP]]
        top.sort(key=lambda x: -x[0])
        scored = top + scored[LOOKAHEAD_TOP:]
    return [s[:4] for s in scored], chance


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--taken", default="", help="comma-separated names already drafted that ESPN hasn't shown yet")
    ap.add_argument("--simulate-picks", type=int, default=int(os.environ["DRAFT_SIMULATE_PICKS"]) if os.environ.get("DRAFT_SIMULATE_PICKS") else None,
                    help="test only: pretend only the first N picks happened (or set DRAFT_SIMULATE_PICKS)")
    ap.add_argument("--top", type=int, default=5)
    ap.add_argument("--picks-made", type=int, help="picks made so far, read from the draft room (ESPN's API hides live picks)")
    ap.add_argument("--mine", default="", help="comma-separated names already on your team (from the draft room)")
    ap.add_argument("--player", help="show the cached card for this player (partial names OK)")
    ap.add_argument("--position", help="list the best available at one position (QB, RB, WR, TE, D/ST, K)")
    ap.add_argument("--picks-json", help="output of scripts/draftroom.js from the draft-room tab (live picks ESPN's API hides)")
    use_league_arg()
    args = ap.parse_args()
    t0 = time.time()

    espn = Espn(load_env())
    path = cache_path(espn)
    if not path.exists():
        raise SystemExit(f"No board cache at {path}. Run draft_cache.py first (5-15s).")
    cache = json.loads(path.read_text())
    players = {p["id"]: p for p in cache["players"]}
    try:
        age_h = (time.time() - datetime.fromisoformat(cache["built_at"]).timestamp()) / 3600
        if age_h > 12:
            print(f"(board is {age_h:.0f}h old; rerun draft_cache.py for fresh injuries and rankings)")
    except (KeyError, ValueError):
        pass

    unseen = 0  # picks the draft room didn't show us; assume ADP's top players went
    room_picks = []  # (overall, player name, fantasy team name) from the draft room
    room = json.loads(args.picks_json) if args.picks_json else None
    room_file = path.parent / f"room-{espn.league_id}.json"
    if room is None and room_file.exists():
        # Saved by room_bridge.py from the draft-room tab; only trust it if fresh
        saved = json.loads(room_file.read_text())
        if time.time() - saved.get("received_at", 0) < 120:
            room = saved
            print(f"(live picks from the draft room, {time.time() - saved['received_at']:.0f}s old)")
    if room:
        teams_n = cache["team_count"]
        my_name = norm(cache["teams"].get(str(cache.get("my_team_id")), {}).get("name", ""))
        room["roster"] = [r for r in room.get("roster", []) if norm(r[1]) not in {"queue", "draft", "add", "remove"}]
        seen = room_seen(room, cache)
        mine_names = [name for name, team in seen.values() if norm(team) == my_name]
        other_names = [name for name, team in seen.values() if norm(team) != my_name]
        made = (room["clock"] - 1) if room.get("clock") else max(seen, default=0)
        room_picks = sorted((k, name, team) for k, (name, team) in seen.items())

        # Roster panel names like "C. Brown": match first initial + last name,
        # preferring the higher-ranked player if two fit
        panel = []
        for slot, short in room.get("roster", []):
            if " D/ST" in short or "." not in short:
                panel.append(short)
                continue
            initial, last = short.split(".", 1)
            allowed = {"FLEX": ("RB", "WR", "TE")}.get(slot, (slot,)) if slot != "BE" else None
            fits = [p for p in players.values()
                    if norm(p["name"]).startswith(norm(initial))
                    and " ".join(norm(p["name"]).split()[1:]) == norm(last)
                    and (allowed is None or p["pos"] in allowed)]
            if fits:
                panel.append(min(fits, key=lambda p: p["rank"] or 9999)["name"])
        # The panel can show any team; only trust it when it's clearly yours:
        # its team label matches, or (no label) it has no more players than
        # you've drafted and none of them were picked by someone else.
        league = cache.get("league", {})
        order_ids = league.get("draft_order_ids") or sorted(int(k) for k in cache["teams"])
        my_made = sum(1 for k in range(1, made + 1)
                      if team_for_pick(order_ids, league.get("draft_type") or "SNAKE", k) == cache.get("my_team_id"))
        label = norm(room.get("roster_team") or "")
        others = {norm(x) for x in other_names}
        if label:
            panel_ok = label == my_name or my_name.startswith(label.rstrip("."))
        else:
            panel_ok = len(panel) <= my_made and not any(norm(x) in others for x in panel)
        if panel and not panel_ok:
            print("(draft room's roster panel is showing another team; using the pick feed for your roster)")
        else:
            mine_names += panel
        args.mine = ",".join(filter(None, [args.mine] + mine_names))
        args.taken = ",".join(filter(None, [args.taken] + other_names))
        args.picks_made = max(args.picks_made or 0, made)
        unseen = max(made - len(seen), 0)
        if unseen:
            print(f"(draft room showed {len(seen)} of {made} picks; assuming the {unseen} missing ones went by ADP)")

    # During a live draft ESPN's API hides the picks, so with fresh draft-room
    # picks the only thing ESPN adds is the draft order (set when the draft
    # starts). Save that response once per draft and skip ESPN after that.
    settings_file = path.parent / f"live-{espn.league_id}.json"
    live = None
    if room and settings_file.exists():
        saved_live = json.loads(settings_file.read_text())
        draft_start = (cache.get("league", {}).get("draft_date") or 0) / 1000
        fetched = saved_live.get("_fetched_at", 0)
        # Trust it if it was fetched after the draft started (order is final) and recently
        if fetched > draft_start + 30 and time.time() - fetched < 6 * 3600:
            live = saved_live
    try:
        if live is None:
            live = espn.get(espn.league_url, ["mDraftDetail", "mSettings"], timeout=8)
            live["_fetched_at"] = time.time()
            if room:
                settings_file.write_text(json.dumps(live))
    except Exception as exc:  # ESPN down, or a finished mock league already deleted
        if room is None and not (args.player or args.position):
            raise SystemExit(f"Couldn't reach ESPN ({exc}) and no draft-room picks are available.")
        league = cache.get("league", {})
        order_ids = league.get("draft_order_ids") or sorted(int(k) for k in cache["teams"])
        live = {"draftDetail": {"picks": []}, "settings": {
            "draftSettings": {"pickOrder": order_ids, "type": league.get("draft_type") or "SNAKE",
                              "timePerSelection": league.get("seconds_per_pick")},
            "rosterSettings": {}}}
        print(f"(ESPN API unavailable: {exc}; using cached league settings)")
    detail = live.get("draftDetail", {})
    settings = live.get("settings", {})
    ds = settings.get("draftSettings", {})
    order, dtype = ds.get("pickOrder") or [], ds.get("type", "SNAKE")
    picks = sorted((p for p in detail.get("picks", []) if p.get("playerId") not in (None, 0, -1)),
                   key=lambda p: p["overallPickNumber"])
    drafted = bool(detail.get("drafted"))
    if args.simulate_picks is not None:
        picks, drafted = picks[: args.simulate_picks], False
    slots = slot_counts(settings) or cache["starting_slots"]
    rounds = sum(slots.values()) + (bench_count(settings) or cache["bench"])
    n = len(order) or cache["team_count"]
    total = rounds * n
    if drafted or len(picks) >= total:
        if args.player or args.position:
            show_lookup(args, players, picks, {p["playerId"] for p in picks}, cache)
        print(f"Draft is complete ({len(picks)} picks).")
        return

    me = cache.get("my_team_id") or espn.team_id
    taken = {p["playerId"] for p in picks}
    unknown = []
    mine_ids = set()
    by_norm = {norm(p["name"]): p for p in players.values()}

    def find(name: str):
        hit = by_norm.get(norm(name)) or next((p for k, p in by_norm.items() if norm(name) in k), None)
        if not hit:
            close = get_close_matches(norm(name), by_norm.keys(), n=1, cutoff=0.75)
            hit = by_norm[close[0]] if close else None
        return hit

    for name in filter(None, (x.strip() for x in (args.taken + "," + args.mine).split(","))):
        hit = find(name)
        if hit:
            taken.add(hit["id"])
            if norm(name) in [norm(x) for x in args.mine.split(",")]:
                mine_ids.add(hit["id"])
        else:
            unknown.append(name)

    current = max(args.picks_made or 0, len(picks)) + 1
    mine = [k for k in range(current, total + 1) if team_for_pick(order, dtype, k) == me]
    if not mine:
        print("You have no picks left.")
        return
    my_pick = mine[0]
    before_me = my_pick - current
    wait = (mine[1] - my_pick - 1) if len(mine) > 1 else 0

    roster = [players[p["playerId"]] for p in picks if p["teamId"] == me and p["playerId"] in players]
    roster += [players[i] for i in mine_ids if all(r["id"] != i for r in roster)]
    opened = open_slots(roster, slots)
    avail = [p for p in players.values() if p["id"] not in taken and p["proj"] is not None]

    # Every team's roster so far, for the team-aware simulation, and every
    # pick seen so far, to learn how this room drafts
    team_by_name = {norm(t["name"]): int(tid) for tid, t in cache["teams"].items()}
    rosters, picked = {}, []
    for pk in picks:
        if pk["playerId"] in players:
            rosters.setdefault(pk["teamId"], []).append(players[pk["playerId"]])
            picked.append((pk["overallPickNumber"], players[pk["playerId"]]))
    for overall, name, team in room_picks:
        pl, tid = find(name), team_by_name.get(norm(team))
        if pl and tid is not None:
            rosters.setdefault(tid, []).append(pl)
            picked.append((overall, pl))
    weights, sigma, room_note = calibrate(picked)
    if unseen:
        assumed = {p["id"] for p in market_order(avail, weights)[:unseen]}
        avail = [p for p in avail if p["id"] not in assumed]
    if args.player or args.position:
        show_lookup(args, players, picks, taken, cache)
        print(f"[{len(picks)} picks live from ESPN; board cached {cache['built_at']}; {time.time() - t0:.2f}s]")
        return
    recent = [p["pos"] for _, p in sorted(picked, key=lambda x: x[0])][-3:]
    scored, mine_next_gone = rank_options(avail, roster, opened, mine, current, order, dtype, me, rosters,
                                          slots, rounds, n, recent, weights, sigma, all_players=list(players.values()))
    my_byes = {(p["pos"], p["bye"]) for p in roster}

    def line(s):
        _, c, vona, why = s
        tags = [f"VONA {vona:+.0f}", f"VBD {c['vbd']:+.0f}" if c["vbd"] is not None else "", why]
        if c["injury"] != "ACTIVE":
            d = c.get("injury_detail") or {}
            tags.append(" ".join(x for x in (c["injury"], d.get("body_part"), f"back ~{d['return']}" if d.get("return") else "") if x))
        pm = c.get("playoff_matchup_rank")
        if pm and (pm <= 8 or pm >= 25):
            tags.append(f"{'easy' if pm >= 25 else 'tough'} playoff schedule ({', '.join(c.get('playoff_games', []))})")
        if (c["pos"], c["bye"]) in my_byes and not why.startswith("handcuff"):
            tags.append(f"same bye ({c['bye']}) as your {c['pos']}")
        if c["adp"]:
            tags.append(f"ADP {c['adp']:.0f}")
        if c.get("ecr"):
            tags.append(f"experts #{c['ecr']}" + (f" (tier {c['ecr_tier']})" if c.get("ecr_tier") else ""))
        if len(mine) > 1:
            chance = mine_next_gone.get(c["id"], 0)
            if chance >= 0.6:
                tags.append(f"likely gone by pick {mine[1]} ({chance:.0%})")
            elif chance <= 0.25:
                tags.append(f"should last to pick {mine[1]} ({1 - chance:.0%})")
        return f"{c['name']} ({c['pos']}, {c['team']}, bye {c['bye']}) — " + ", ".join(t for t in tags if t)

    rnd, pir = (my_pick - 1) // n + 1, (my_pick - 1) % n + 1
    if before_me == 0:
        print(f"YOU'RE ON THE CLOCK: pick {my_pick} (R{rnd}.{pir}), {ds.get('timePerSelection', '?')}s. After this: pick {mine[1] if len(mine) > 1 else '-'} ({wait} picks later).")
    else:
        up = cache["teams"].get(str(team_for_pick(order, dtype, current)), {}).get("name", "?")
        print(f"On the clock: {up}, pick {current}. You're up in {before_me} picks (pick {my_pick}, R{rnd}.{pir}); board below simulates the picks before then (how this room drafts + each team's needs).")
    print("TAKE: " + line(scored[0]))
    if len(scored) > 1:
        print("Next best: " + line(scored[1]))
    for s in scored[2:args.top]:
        print("  also: " + line(s))
    print("Your roster: " + (", ".join(f"{p['name']} ({p['pos']})" for p in roster) or "none yet")
          + " | open: " + (", ".join(f"{k} {v}" for k, v in opened.items()) or "starters full"))
    if unknown:
        print("Couldn't match --taken names: " + ", ".join(unknown))
    if room_note:
        print(f"({room_note}, learned from {len(picked)} picks)")
    print(f"[{len(picks)} picks live from ESPN; board cached {cache['built_at']}; {time.time() - t0:.2f}s]")


if __name__ == "__main__":
    main()
