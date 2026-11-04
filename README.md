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

## Credits

`comanager/` is derived from
[JayMishra-source/Fantasy-Football-AI-CoManager](https://github.com/JayMishra-source/Fantasy-Football-AI-CoManager)
(MIT License, per that project's README), extended with the league tools in
`fantasy-engine/mcp-server/src/tools/league.ts` and fixes to player lookup.
See [NOTICE](NOTICE).
