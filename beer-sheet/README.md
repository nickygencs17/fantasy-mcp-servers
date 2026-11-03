# beer-sheet-mcp

A Value-Based Drafting (VBD) calculator — the core method behind fantasy
football "beer sheet" cheat sheets, packaged as an MCP tool. Give it a flat
list of player projections plus a league's roster settings, and it returns a
single ranked draft board with every player's value expressed relative to a
replacement-level baseline at their position, so a QB, RB, WR, and TE are all
directly comparable on one list.

## Where this comes from

BeerSheets / FA Sheets are themselves built on Value-Based Drafting, a
method Joe Bryant introduced at footballguys.com in 1996: a player's fantasy
value isn't their raw projection, it's their projection minus the projection
of the last startable player at their position (the "baseline" or
"replacement level"). This server implements that directly.

BeerSheets' own refinement — a baseline called "BEER" (Best Ever Evaluation
of Replacement), which adjusts for how many games a player at a given draft
rank is actually expected to play (bye weeks, injury attrition) — is **not**
reproduced here. That requires a proprietary durability/games-played model
that isn't publicly documented, and faking it would produce numbers that
look precise without being trustworthy. Instead this implements the two
baselines that *are* fully specified:

- **VOLS** (Value Over Last Starter, default) — baseline = the Nth-best
  player at a position, where N is exactly how many of that league's
  starting slots draw from that position, including a proper accounting of
  shared FLEX slots (see below).
- **VORP** — VOLS extended outward by an approximate share of each team's
  bench slots. There's no single canonical VORP formula (real waiver value
  varies by league dynamics), so this is a documented approximation.

## Tool

- `compute_draft_board({ players, rosterSlots, teamCount, baseline? })` —
  returns every player with a `vbdValue`, `positionRank`, and `overallRank`,
  sorted into one draft board.

`rosterSlots` takes ESPN's own `roster_positions` object shape directly
(from `get_league_settings` on the `espn-fantasy-draft` MCP server) — e.g.
`{"QB":1,"RB":2,"WR":2,"TE":1,"RB/WR/TE":2,"D/ST":1,"K":1,"BE":7}`. Any key
containing `/` is treated as a flex slot pooled across its constituent
positions (narrower flex groups fill before broader ones), **except**
`"D/ST"`, which is ESPN's literal name for Defense/Special Teams, not a
flex separator. `BE`/`BN`/`IR` are ignored for the starter baseline (`BE` is
used only for the VORP approximation).

`players` needs `name`, `position`, and `projectedPoints` per player —
this server doesn't fetch projections itself. Pull those from the existing
`espn-fantasy`/`espn-fantasy-draft` MCP servers' `projectedPoints` field
(already present on `get_available_players`/`my_roster` output) and pass
them straight through.

## Status: deployed

Live on the Pi as a systemd service, same pattern as the other espn-fantasy
MCP servers:

- Code: `/opt/beer-sheet-mcp`
- Service: `beer-sheet.service` (enabled, `Restart=always`)
- Port: `8769` (localhost only)
- Public URL: `https://<your-pi>.<your-tailnet>.ts.net/beer-sheet/mcp`
- Auth: requires `Authorization: Bearer <token>` — see
  `/etc/systemd/system/beer-sheet.service` on the Pi, or `mcp_tokens.txt` /
  `nfl-injury-odds-mcp-deploy.md` on the Desktop.

Verify it's alive:
```bash
ssh <user>@<your-pi> systemctl status beer-sheet
```

## Requires Node 20+

Same underlying SDK as the other two servers here — under Node 18, every
MCP request (not just this tool) fails with `crypto is not defined` inside
the SDK's `@hono/node-server`-based transport. `/health` alone won't catch
this; always smoke-test with a real `tools/call`, not just `/health`.
