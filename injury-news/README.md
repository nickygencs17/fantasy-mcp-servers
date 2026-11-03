# nfl-injury-news-mcp

MCP server exposing NFL injury reports and news headlines, pulled from
ESPN's public (unauthenticated) site API. No API key needed.

## Tools

- `get_injury_report({ team? })` — full league injury report, or filtered to one team abbreviation (e.g. `KC`).
- `get_player_injury_status({ playerName })` — look up a specific player's current designation.
- `get_recent_news({ team?, limit? })` — recent NFL headlines, optionally filtered by team.

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

1. **Copy the code over** (from wherever you unzip this, e.g. your Mac):
   ```bash
   rsync -avz nfl-injury-news-mcp/ <user>@<your-pi>:~/nfl-injury-news-mcp/
   ```

2. **Install dependencies on the Pi** (this needs real internet, not Tailscale):
   ```bash
   cd ~/nfl-injury-news-mcp
   npm install
   ```

3. **Quick test run** — `/health` alone is not enough proof; it stays "ok" even when
   the MCP transport itself is broken (this is exactly how the Node 18 bug above
   hides). Test an actual MCP call:
   ```bash
   node index.js &
   curl http://localhost:4001/health
   curl -s -X POST http://localhost:4001/mcp \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
   # expect a JSON-RPC result listing 3 tools, NOT a "Parse error"/"crypto is not defined"
   kill %1
   ```

4. **Systemd service** so it survives reboots. First find the exact node binary the
   test above actually used — `which node` — since systemd does **not** source your
   shell profile/nvm, so `ExecStart=/usr/bin/node` can silently run a different
   (often older, apt-installed) Node than the one you just tested with:
   ```bash
   which node
   ```
   ```bash
   sudo nano /etc/systemd/system/nfl-injury-news.service
   ```
   ```ini
   [Unit]
   Description=NFL Injury/News MCP
   After=network.target

   [Service]
   ExecStart=/full/path/from/which-node/above /home/pi/nfl-injury-news-mcp/index.js
   WorkingDirectory=/home/pi/nfl-injury-news-mcp
   Environment=PORT=4001
   Restart=always
   User=pi

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now nfl-injury-news
   # then repeat the tools/list curl from step 3 against the systemd-run instance
   ```

5. **Expose it via Tailscale Funnel**, alongside your existing `/comanager/mcp` and `/mcp` paths — add a new path mapping, e.g.:
   ```bash
   sudo tailscale funnel --bg --set-path /injury-news/mcp http://localhost:4001/mcp
   ```
   This gives you `https://<your-pi>.<your-tailnet>.ts.net/injury-news/mcp`.

6. **Add it as a connector** in Claude (Settings → Connectors → Add connector → Remote), pointing at that URL — same as CoManager/Draft.

## Notes

- Team filters use ESPN's standard 2-3 letter abbreviations (`KC`, `SF`, `BUF`, etc).
- I wrote this without live network access, so the ESPN response parsing is defensive
  (multiple fallback fields) but hasn't been tested against a live response. If a tool
  call comes back oddly shaped, run `curl https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries`
  on the Pi and compare the JSON shape to what `flattenInjuries()` expects in `index.js` —
  ESPN has changed field names before without notice.
