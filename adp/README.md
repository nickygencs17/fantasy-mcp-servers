# nfl-adp-mcp

Current fantasy football ADP (average draft position), pulled from Fantasy
Football Calculator's free, unauthenticated public API. No API key needed.

## What this is (and isn't)

This is a **current snapshot**, not a day-over-day trend. Fantasy Football
Calculator's own ADP figure is already a rolling window over recent drafts
(the response's `dateRange` shows exactly which window — as of writing,
roughly the trailing week), but there's no historical/movement query
exposed by their API. Real "is this player rising or falling" movement would
need daily snapshots saved somewhere and diffed over time, which this server
deliberately does not fake.

What it does give you in one call: each player's `stdev`/`high`/`low` across
all the drafts in that window — a wide spread means drafters disagree a lot
about that player's value right now, which is a genuinely useful signal on
its own, separate from any trend.

## Tools

- `get_adp_board({ scoringFormat?, teams?, position?, limit? })` — full ADP
  list, optionally filtered to one position. `scoringFormat` is
  `standard`/`ppr`/`half-ppr` (default `half-ppr`), `teams` is league size
  (default 10).
- `get_player_adp({ playerName, scoringFormat?, teams? })` — look up one
  player by name (partial, case-insensitive).

## Status: deployed

Live on the Pi as a systemd service, same pattern as the other espn-fantasy
MCP servers:

- Code: `/opt/nfl-adp-mcp`
- Service: `nfl-adp.service` (enabled, `Restart=always`)
- Port: `8770` (localhost only)
- Public URL: `https://<your-pi>.<your-tailnet>.ts.net/adp/mcp`
- Auth: requires `Authorization: Bearer <token>` — see
  `/etc/systemd/system/nfl-adp.service` on the Pi, or `mcp_tokens.txt` on
  the Desktop.

Verify it's alive:
```bash
ssh <user>@<your-pi> systemctl status nfl-adp
```

## Requires Node 20+

Same underlying SDK as the other servers here — under Node 18, every MCP
request (not just this tool) fails with `crypto is not defined` inside the
SDK's `@hono/node-server`-based transport. `/health` alone won't catch this;
always smoke-test with a real `tools/call`, not just `/health`.
