# Fantasy MCP Servers

Six MCP servers that give Claude live context for an ESPN fantasy football
league: league data, the draft, injuries and news, Vegas odds, ADP, and a
value-based draft board. They run on a Raspberry Pi as systemd services and
are exposed to Claude (web, desktop and iOS) through Tailscale Funnel on one
hostname, each behind its own bearer token.

| Folder | Service | Port | Funnel path | Language | What it does |
|---|---|---|---|---|---|
| [`comanager/`](comanager/) | `espn-fantasy-comanager` | 8766 | `/comanager/mcp` | TypeScript | Rosters, lineup/start-sit, waivers, trades, plus league tools: standings, scoreboard, box scores, schedules, power rankings, playoff picture, clinch scenarios, activity, transactions, player cards, defense vs position, trending players |
| [`draft/`](draft/) | `espn-fantasy-draft` | 8765 | `/mcp` | Python | Live draft state, league settings, rosters, matchup results (via `espn_api`) |
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

## Credits

`comanager/` is derived from
[JayMishra-source/Fantasy-Football-AI-CoManager](https://github.com/JayMishra-source/Fantasy-Football-AI-CoManager)
(MIT License, per that project's README), extended with the league tools in
`fantasy-engine/mcp-server/src/tools/league.ts` and fixes to player lookup.
See [NOTICE](NOTICE).
