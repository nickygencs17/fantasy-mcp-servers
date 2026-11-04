# Fantasy MCP Servers

Six MCP servers that give Claude live context for an ESPN fantasy football
league: league data, the draft, injuries and news, Vegas odds, ADP, and a
value-based draft board. They run on a Raspberry Pi as systemd services and
are exposed to Claude (web, desktop and iOS) through Tailscale Funnel on one
hostname, each behind its own bearer token.

| Folder | Service | Port | Funnel path | Language | What it does |
|---|---|---|---|---|---|
| [`comanager/`](comanager/) | `espn-fantasy-comanager` | 8766 | `/comanager/mcp` | TypeScript | Rosters, lineup/start-sit, waivers, trades, plus league tools: standings, scoreboard, box scores, schedules, power rankings, playoff picture, clinch scenarios, trade value chart with buy/sell signals and lineup-based trade analysis, activity, transactions, player cards, defense vs position, trending players |
| [`draft/`](draft/) | `espn-fantasy-draft` | 8765 | `/mcp` | Python | Live draft: one-call `get_draft_board` (who's on the clock, your needs, best available by VBD) from a locally cached player pool plus ESPN's live pick feed; also league settings and matchup results |
| [`injury-news/`](injury-news/) | `nfl-injury-news` | 8767 | `/injury-news/mcp` | Node | NFL injury report and news (ESPN public API, no key) |
| [`odds/`](odds/) | `nfl-odds` | 8768 | `/odds/mcp` | Node | Spreads, totals, moneylines (ESPN public API, no key) |
| [`adp/`](adp/) | `nfl-adp` | 8770 | `/adp/mcp` | Node | Current ADP (Fantasy Football Calculator public API; empty mid-season) |
| [`beer-sheet/`](beer-sheet/) | `beer-sheet` | 8769 | `/beer-sheet/mcp` | Node | VBD "beer sheet" draft board calculator |

## Configuration

Nothing secret is committed. Each server reads:

- `MCP_HTTP_PORT`: serve over HTTP on this port. Without it, the servers
  run over stdio for local Claude Desktop use.
- `MCP_AUTH_TOKEN`: required whenever `MCP_HTTP_PORT` is set; requests
  need `Authorization: Bearer <token>`. Use a different random token per
  server (`openssl rand -hex 32`).

The two ESPN servers also need league cookies in a `.env` next to the
server (see each `.env.example`): `ESPN_S2` and `ESPN_SWID` from your
browser's espn.com cookies, plus `ESPN_LEAGUE_ID` / `ESPN_TEAM_ID` for
`draft/`.

## Deploying on the Pi

Each folder deploys to its own directory under `/opt` (see the unit files
in [`deploy/systemd/`](deploy/systemd/), which load the port and token from
`/etc/fantasy-mcp/<service>.env`).

```bash
# Node servers (injury-news, odds, adp, beer-sheet)
cd /opt/<server> && npm ci --omit=dev

# CoManager (TypeScript; `shared/` must be built first)
cd /opt/espn-fantasy/fantasy-comanager/fantasy-engine/shared && npm ci && npm run build
cd ../mcp-server && npm ci && npm run build:local

# Draft (Python)
cd /opt/espn-fantasy && python3 -m venv venv && venv/bin/pip install -r requirements.txt

sudo systemctl daemon-reload && sudo systemctl restart <service>
```

Tailscale Funnel routes one public hostname to the six local ports by path:

```bash
tailscale funnel --bg --set-path /comanager   http://127.0.0.1:8766
tailscale funnel --bg --set-path /injury-news http://127.0.0.1:8767
# ...and so on for each path in the table above
```

## Skills

[`skills/fantasy-draft/`](skills/fantasy-draft/) is the Claude skill that drafts with these servers on a
60-second (or 30-second) clock. `draft_cache.py` caches the whole player pool
locally at prep (ESPN projections, ADP, FantasyPros expert rankings, injury
details, byes, playoff schedule, VBD); `pick.py` ranks each pick in well under a
second (value over next available from a team-aware simulation of the other
teams' picks, roster needs, injuries, byes). ESPN's API hides live picks until a
draft ends and allows one draft-room connection per person, so the "Draft
Bridge" bookmarklet (`make_bookmarklet.py`) runs `draftroom.js` in your own
draft tab and posts picks to `room_bridge.py` on 127.0.0.1, which also shows the
recommended pick on the draft page. `draft_report.py` grades the draft afterward.
Credentials come from a local `.env` (`ESPN_S2`, `ESPN_SWID`, `ESPN_LEAGUE_ID`,
`ESPN_TEAM_ID`); nothing secret is in the skill.

### Setting up the live draft assistant

You need a Mac (or any computer) with Python 3.9+ and Chrome, plus Claude
Code or the Claude desktop app's Code tab. The scripts use only the Python
standard library, so there is nothing to `pip install`.

**1. Install the skill.** Copy [`skills/fantasy-draft/`](skills/fantasy-draft/)
into your project's `.claude/skills/` folder (or `~/.claude/skills/` for all
projects). To use it on claude.ai too, zip the folder and upload it under
Settings → Capabilities → Skills.

```bash
mkdir -p ~/fantasy/.claude/skills && cp -R skills/fantasy-draft ~/fantasy/.claude/skills/
```

**2. Add your league's `.env`** in the folder you'll run Claude from (here
`~/fantasy`). Get `ESPN_S2` and `SWID` from your browser's espn.com cookies
(DevTools → Application → Cookies → `espn_s2` and `SWID`); the league id is
`leagueId=` in your league's URL, and the team id is `teamId=` on your team
page. Never commit this file.

```bash
cat > ~/fantasy/.env <<'EOF'
ESPN_S2=your_espn_s2_cookie
ESPN_SWID={YOUR-SWID-WITH-BRACES}
ESPN_LEAGUE_ID=123456789
ESPN_TEAM_ID=4
ESPN_YEAR=2026
EOF
```

`ESPN_ENV_FILE` points the scripts at a `.env` somewhere else. For a mock
draft, add `--league <mock league id>` to any script; your team in that league
is found from your SWID.

**3. Prep before the draft** (takes about 20 seconds; re-run on draft day for
fresh injuries). This writes `draft-cache/board-<league>-<year>.json`:

```bash
cd ~/fantasy && python3 .claude/skills/fantasy-draft/scripts/draft_cache.py
```

**4. Install the Draft Bridge bookmark (once).**

```bash
cd ~/fantasy && python3 .claude/skills/fantasy-draft/scripts/make_bookmarklet.py
```

Open `scripts/bookmarklet.html` in Chrome and drag the **Draft Bridge** link to
your bookmarks bar. Check the bookmark's URL starts with `javascript:`. If it
starts with `file://`, you saved the install page instead: run
`pbcopy < .claude/skills/fantasy-draft/scripts/bookmarklet.txt` and paste that
as the bookmark's URL. After the scripts change, run `make_bookmarklet.py`
again and replace the bookmark; a newer bookmark replaces an older reader
already running in the tab.

**5. On draft day:**

1. Start the bridge and leave it running. It listens on 127.0.0.1:8781 only
   (`DRAFT_BRIDGE_PORT` changes the port):
   ```bash
   cd ~/fantasy && python3 .claude/skills/fantasy-draft/scripts/room_bridge.py
   ```
2. Join the draft in your own Chrome tab and click **Draft Bridge** once. A
   note at the bottom right confirms it's sending. Click it again if you reload
   the tab. Don't open the draft room anywhere else (another browser, or Claude
   in Chrome): ESPN allows one connection per person and will drop yours.
3. When you're on the clock, a green **TAKE** box shows the pick on the draft
   page, usually within a second. You can also say "my turn" to Claude, which
   runs:
   ```bash
   python3 .claude/skills/fantasy-draft/scripts/pick.py --top 3
   ```
   `--player "<name>"` looks up one player, and `--position RB` lists the best
   available at a position.
4. After the draft, grade it (grade, value vs ADP, how your lineup ranks) and stop the bridge (Ctrl+C):
   ```bash
   python3 .claude/skills/fantasy-draft/scripts/draft_report.py
   ```

**Troubleshooting**

- *No green box:* check the bridge is running, then click the bookmark again.
  If the bookmark opens a new tab, fix its URL as in step 4. Chrome may ask
  once to allow the page to reach devices on your local network; allow it.
- *"board is Nh old":* the cache is over 12 hours old; re-run `draft_cache.py` before the draft starts.
- *Wrong picks or team:* make sure the draft tab's league matches the
  `--league` (or `ESPN_LEAGUE_ID`) you prepped.

## Credits

`comanager/` is derived from
[JayMishra-source/Fantasy-Football-AI-CoManager](https://github.com/JayMishra-source/Fantasy-Football-AI-CoManager)
(MIT License, per that project's README), extended with the league tools in
`fantasy-engine/mcp-server/src/tools/league.ts` and fixes to player lookup.
See [NOTICE](NOTICE).
