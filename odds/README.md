# nfl-odds-mcp

MCP server exposing NFL game odds (spreads, totals, moneylines), pulled from
ESPN's public scoreboard API (which embeds ESPN BET / Caesars-sourced lines).
No API key needed.

## Tools

- `get_week_odds({ week?, year?, seasontype? })` — spreads/totals for a whole week's slate. Omit params for the current week.
- `get_team_odds({ team, week?, year?, seasontype? })` — odds for one team's game.

`seasontype`: 1=preseason, 2=regular season, 3=postseason.

## Requires Node 20+

This server crashes on **every** MCP request (not just ESPN calls — `tools/list`
itself fails) under Node 18, with `crypto is not defined` thrown inside the SDK's
`@hono/node-server`-based transport. It works cleanly on Node 20. Before deploying,
confirm what the Pi actually runs:
```bash
node --version
```
If it's Node 18 (common with Raspberry Pi OS's stock `apt install nodejs`), install
Node 20+ (e.g. via nvm, or NodeSource) before continuing — otherwise every tool call
will silently fail once it's live, even though `/health` still reports OK (see the
smoke test in step 3 — it deliberately checks more than `/health` for this reason).

## Deploy on the Pi (same pattern as CoManager/Draft)

1. **Copy the code over:**
   ```bash
   rsync -avz nfl-odds-mcp/ <user>@<your-pi>:~/nfl-odds-mcp/
   ```

2. **Install dependencies on the Pi:**
   ```bash
   cd ~/nfl-odds-mcp
   npm install
   ```

3. **Quick test run** — `/health` alone is not enough proof; it stays "ok" even when
   the MCP transport itself is broken (this is exactly how the Node 18 bug above
   hides). Test an actual MCP call:
   ```bash
   node index.js &
   curl http://localhost:4002/health
   curl -s -X POST http://localhost:4002/mcp \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
   # expect a JSON-RPC result listing 2 tools, NOT a "Parse error"/"crypto is not defined"
   kill %1
   ```

4. **Systemd service.** First find the exact node binary the test above actually
   used — `which node` — since systemd does **not** source your shell profile/nvm,
   so `ExecStart=/usr/bin/node` can silently run a different (often older,
   apt-installed) Node than the one you just tested with:
   ```bash
   which node
   ```
   ```bash
   sudo nano /etc/systemd/system/nfl-odds.service
   ```
   ```ini
   [Unit]
   Description=NFL Odds MCP
   After=network.target

   [Service]
   ExecStart=/full/path/from/which-node/above /home/pi/nfl-odds-mcp/index.js
   WorkingDirectory=/home/pi/nfl-odds-mcp
   Environment=PORT=4002
   Restart=always
   User=pi

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now nfl-odds
   # then repeat the tools/list curl from step 3 against the systemd-run instance
   ```

5. **Expose it via Tailscale Funnel**, alongside your existing paths:
   ```bash
   sudo tailscale funnel --bg --set-path /odds/mcp http://localhost:4002/mcp
   ```
   This gives you `https://<your-pi>.<your-tailnet>.ts.net/odds/mcp`.

6. **Add it as a connector** in Claude (Settings → Connectors → Add connector → Remote), pointing at that URL.

## Notes

- Team abbreviations follow ESPN's standard codes (`KC`, `SF`, `BUF`, etc).
- Written without live network access, so the response parsing (`flattenGames()` in
  `index.js`) is defensive but untested against a live payload. If odds come back null,
  run `curl "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"` on
  the Pi and check whether `competitions[0].odds[0]` still has the fields the code expects —
  ESPN doesn't always publish odds for every game (e.g. preseason, bye weeks) and field
  names have shifted before.
