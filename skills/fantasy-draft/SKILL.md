---
name: fantasy-draft
description: Live ESPN Fantasy Football draft pick assistant with a 60-second clock. At prep it caches everything into a local file (600-player pool with projections, ranks, ESPN and market ADP, last season, outlooks, injury report details, byes, fantasy-playoff schedule, VBD, and the league's settings); each pick then runs one bundled script that reads the live picks and ranks the options by value over next available, roster need, injuries and byes, so the answer lands in under 25 seconds. Use whenever the user is drafting or prepping a draft: "my turn", "on the clock", "who should I draft/pick", "prep my draft", or pasted picks that just happened, even without saying "draft help".
---

# Fantasy Draft Assistant

The user is on a 60-second clock. **Every pick answer must land in under
25 seconds: one command, then a one-line answer.** Never research, browse,
or make extra tool calls inside the pick loop.

League and team: read from `.env` (`ESPN_LEAGUE_ID`, `ESPN_TEAM_ID`), or
`--league NNN` for another league or a mock draft.

## Which path to use

- **Local scripts (the Mac, Claude Code / Code tab):** if you can run shell
  commands and the working folder has the user's `.env` (ESPN_S2, ESPN_SWID,
  ESPN_LEAGUE_ID, ESPN_TEAM_ID), use the scripts in this skill's `scripts/`
  folder. This is the fast, smart path.
- **No local shell (claude.ai web/iPhone, desktop chat):** use the
  `espn-fantasy-draft` MCP server's `get_draft_board` instead (see the
  fallback section at the end).

**Other leagues and mock drafts:** if the user gives a different league ID
or an ESPN draft URL (`...?leagueId=NNN`), add `--league NNN` to every
`draft_cache.py` and `pick.py` command for the rest of the draft. The
scripts find the user's team in that league from their ESPN account.

## Prep (once, before the draft; never while on the clock)

Run from the folder that has `.env`:

```bash
python3 <this skill's folder>/scripts/draft_cache.py
```

It caches everything a pick could need to
`draft-cache/board-<league>-<year>.json` in a few seconds, then prints a
summary:
- 600 players: ESPN projection, ESPN rank and positional rank, ESPN ADP
  blended with market ADP (Fantasy Football Calculator, when published),
  auction value, last season's points and points per game, roster %,
  season outlook, bye;
- ESPN's injury report: status, body part, expected return, latest note;
- each player's fantasy-playoff games, rated by defense vs his position;
- FantasyPros expert consensus rankings (rank, tier) as a second opinion:
  the draft cheat sheet before the season, rest-of-season rankings once it's
  underway, in the league's reception scoring;
- league settings: scoring, roster slots, bench, draft type, order and clock;
- VBD for this league's slots.

The summary line says whether projections are full-season (preseason) or
rest-of-season (mid-season mocks). For a real draft, always run prep on
draft day; `pick.py` warns when the board is over 12 hours old.

Re-run it on draft day for fresh injuries. After prep, answer every draft
question from the cache via `pick.py`; don't call other MCP servers or
search the web during the draft.

### Live picks (do this before the draft starts)

ESPN's API hides every pick until the draft is over (each pick slot shows
an empty player while the draft runs), so live picks have to come from the
draft room itself:

1. Start the local bridge in the background (it listens on 127.0.0.1 only
   and saves picks to `draft-cache/room-<league>.json`):

   ```bash
   python3 <this skill's folder>/scripts/room_bridge.py
   ```

2. **Never open the draft room yourself** (no Claude in Chrome tab on the
   draft page): ESPN allows one draft-room connection per person, so a
   second copy disconnects the user's ("Duplicate Connection"). Instead the
   user clicks the **Draft Bridge** bookmarklet once in *their own* draft tab.
   It runs `draftroom.js` there: every 2 seconds it reads the clock, pick
   feed, pick history and the user's roster panel and posts them to the
   bridge. A note at the bottom right of their tab confirms it's sending.
   If they don't have the bookmarklet yet, run
   `python3 <this skill's folder>/scripts/make_bookmarklet.py` and have them
   open `scripts/bookmarklet.html` and drag the link to their bookmarks bar.
   Chrome may ask to let the page access devices on the local network: they
   should allow it.
3. `pick.py` then reads those picks automatically whenever they're under 2
   minutes old ("live picks from the draft room, Ns old"), so each pick is
   still one command with no browser call.
4. **On-page picks:** when the draft room says it's the user's turn, the
   bridge runs `pick.py` itself and the bookmarklet shows a green
   **TAKE: …** box (with the reason and next best) at the top right of the
   draft page within about 2 seconds. The user can pick straight from it;
   "my turn" in chat still works the same way.
5. If `pick.py` prints that the roster panel is showing another team, it
   has ignored the panel and used the pick feed instead; suggest the user
   switch the panel back to their own team.

If the user reloads their draft tab, they click the bookmarklet again. After the scripts change, rerun `make_bookmarklet.py` and have the user replace the old bookmark with the new link (the bookmark holds its own copy of the reader).

## Each pick ("my turn", "who should I take", pasted picks)

1. Run **one** command:

   ```bash
   python3 <this skill's folder>/scripts/pick.py
   ```

   If the user pasted or named picks that just happened, pass them so they
   count even if ESPN's feed hasn't caught up yet:

   ```bash
   python3 <this skill's folder>/scripts/pick.py --taken "Player One, Player Two"
   ```

   It reads the local cache plus the draft room's live picks (from the
   bridge), and prints in under a second:
   - who's on the clock, and the user's current and next pick;
   - `TAKE:` the recommendation, `Next best:`, and a few alternates, each
     with VONA, VBD, roster-need, injury and bye notes;
   - the user's roster so far and open starting slots.

   If the draft cache is missing, say so in one line, run `draft_cache.py`
   (a few seconds), then run `pick.py`.

2. Answer with the script's `TAKE:` line, in the output format below. Trust
   its ranking: it already weighs what the user loses by waiting (VONA:
   projected points over the best player left at that position when the
   user's next pick comes around, assuming others draft by ADP), value over
   replacement, open starting slots (holding D/ST until the last rounds and
   forcing open starters when picks run short), injury tags (with body part
   and expected return), bye stacking, a small nudge for easy or tough
   fantasy-playoff schedules, and FantasyPros' expert rank. "Who's gone
   before your next pick" comes from a pick-by-pick simulation of the other
   teams (ADP adjusted for each team's roster needs and position runs);
   `likely gone by pick N` on an alternate means don't count on him later. Only override it if the user told you something it can't
   know (e.g. "I don't want any Jets").

3. **If the user says that player is gone:** run `pick.py --taken "<name>"`
   again and answer with the new `TAKE:`.

   Other questions, same speed, from the cache plus live picks:
   - "tell me about X" / "is X still there?": `pick.py --player "X"`
     (ranks, projection, ADP, last season, injury details, outlook,
     playoff games, and available or who drafted him);
   - "best TE left?": `pick.py --position TE`.

4. **Not the user's turn yet:** the script's first line says how many picks
   until they're up and the board assumes others draft by ADP until then.
   Give the target, and say it's a projection.

## After the draft

Offer the report card (it takes a second):

```bash
python3 <this skill's folder>/scripts/draft_report.py   # add --league NNN for a mock
```

It grades the user's draft (projected starting lineup vs every other team),
lists each pick against ADP (best value, biggest reach), and saves
`draft-cache/report-<league>.md`. Share the headline (grade, rank, best
value, biggest reach) in a few lines. Then stop `room_bridge.py`.

## Output format

Default to **one line, nothing else**:

```
**Take [Player]** ([Pos], [Team]) — [3-6 word reason]
```

Add a second line only when it changes the decision:
- the top two are close → `Next best: [Player]`
- the pick carries an injury tag (Q/D/O) or stacks a bye at that position →
  state it in a few words.

No restating the roster, no "here's what I checked".

## Fallback without a local shell

On the `espn-fantasy-draft` MCP server:
- Prep: `refresh_player_cache` (10-20 seconds; never on the clock).
- Each pick: **one** `get_draft_board` call. It returns who's on the clock,
  the user's roster and `open_starting_slots`, `best_available` ranked by
  `vbd` (with `injury_status`, `bye_week`, `picks_past_adp`), and
  `top_by_position`. Pick the best `best_available` player that fills an
  open starting slot; prefer the position with the bigger drop to the next
  player in `top_by_position` when the user's next pick is far away; hold
  D/ST until the last rounds. If the user pasted picks the board doesn't
  show yet, skip those names. To check one player, use `search_players`.
- Same one-line output format.
