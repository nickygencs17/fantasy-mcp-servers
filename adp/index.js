import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = process.env.MCP_HTTP_PORT || 4004;

// This server is HTTP-only (no stdio mode) and gets exposed to the public
// internet via Tailscale Funnel, so — same as the other espn-fantasy MCP
// servers on this box — it refuses to run without a bearer token.
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
if (!MCP_AUTH_TOKEN) {
  throw new Error(
    "MCP_AUTH_TOKEN is not set — refusing to serve over HTTP with no auth."
  );
}

const ADP_BASE = "https://fantasyfootballcalculator.com/api/v1/adp";

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; fantasy-mcp/1.0)",
  Accept: "application/json",
};

async function fetchAdp({ scoringFormat, teams }) {
  const url = `${ADP_BASE}/${scoringFormat}?teams=${teams}&year=${new Date().getFullYear()}`;
  const res = await fetch(url, { headers: FETCH_HEADERS });
  const payload = await res.json();
  if (!res.ok || payload?.status !== "Success") {
    const detail = (payload?.errors ?? []).join(", ") || `HTTP ${res.status}`;
    throw new Error(`Fantasy Football Calculator ADP request failed: ${detail}`);
  }
  return payload;
}

/**
 * Note on "movement": this only returns a current snapshot — Fantasy
 * Football Calculator's own ADP figure is already a rolling window over
 * recent drafts (see payload.meta.start_date/end_date), not a single-day
 * number, but there's no day-over-day trend here. `stdev`/`high`/`low` are
 * the closest thing to a market-disagreement signal available in one call:
 * a wide spread means drafters don't agree on this player's value, which is
 * often a more useful red flag than a moving average would be anyway.
 */
function flattenPlayer(p) {
  return {
    name: p?.name ?? "Unknown",
    position: p?.position ?? null,
    team: p?.team ?? null,
    adp: p?.adp ?? null,
    adpFormatted: p?.adp_formatted ?? null,
    timesDrafted: p?.times_drafted ?? null,
    high: p?.high ?? null,
    low: p?.low ?? null,
    stdev: p?.stdev ?? null,
    bye: p?.bye ?? null,
  };
}

function buildServer() {
  const server = new McpServer({ name: "nfl-adp", version: "1.0.0" });
  registerTools(server);
  return server;
}

function registerTools(server) {
  server.registerTool(
    "get_adp_board",
    {
      title: "Get current fantasy football ADP",
      description:
        "Get current fantasy football average draft position (ADP) from Fantasy Football Calculator's " +
        "aggregated mock/live draft data. Reflects a recent rolling window of drafts (see the returned " +
        "dateRange), not a single day — this is a current snapshot, not a day-over-day trend. Each " +
        "player's stdev/high/low show how much drafters disagree on their value, which is the closest " +
        "thing to a market-sentiment signal available in one call. Optionally filter by position.",
      inputSchema: {
        scoringFormat: z
          .enum(["standard", "ppr", "half-ppr"])
          .optional()
          .describe("League scoring format. Defaults to 'half-ppr'."),
        teams: z.number().int().min(2).max(20).optional().describe("League size. Defaults to 10."),
        position: z.string().optional().describe("Filter to one position, e.g. 'RB'. Omit for all positions."),
        limit: z.number().int().min(1).max(300).optional().describe("Max players to return (default 100)."),
      },
    },
    async ({ scoringFormat, teams, position, limit }) => {
      try {
        const payload = await fetchAdp({
          scoringFormat: scoringFormat ?? "half-ppr",
          teams: teams ?? 10,
        });
        let players = (payload?.players ?? []).map(flattenPlayer);
        if (position) {
          const pos = position.toUpperCase();
          players = players.filter((p) => p.position?.toUpperCase() === pos);
        }
        players = players.slice(0, limit ?? 100);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  scoringFormat: payload?.meta?.type ?? scoringFormat ?? "half-ppr",
                  teams: payload?.meta?.teams ?? teams ?? 10,
                  dateRange: {
                    start: payload?.meta?.start_date ?? null,
                    end: payload?.meta?.end_date ?? null,
                  },
                  totalDrafts: payload?.meta?.total_drafts ?? null,
                  count: players.length,
                  players,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error fetching ADP: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_player_adp",
    {
      title: "Get a specific player's ADP",
      description:
        "Look up current ADP for a specific player by name (partial, case-insensitive match).",
      inputSchema: {
        playerName: z.string().describe("Player name or partial name, e.g. 'Gibbs'."),
        scoringFormat: z
          .enum(["standard", "ppr", "half-ppr"])
          .optional()
          .describe("League scoring format. Defaults to 'half-ppr'."),
        teams: z.number().int().min(2).max(20).optional().describe("League size. Defaults to 10."),
      },
    },
    async ({ playerName, scoringFormat, teams }) => {
      try {
        const payload = await fetchAdp({
          scoringFormat: scoringFormat ?? "half-ppr",
          teams: teams ?? 10,
        });
        const players = (payload?.players ?? []).map(flattenPlayer);
        const needle = playerName.toLowerCase();
        const matches = players.filter((p) => p.name.toLowerCase().includes(needle));
        if (matches.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No ADP data found for "${playerName}" — they may be undrafted-in-mocks-so-far or the name didn't match.`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error fetching player ADP: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}

const app = express();
app.use(express.json());

app.post("/mcp", (req, res, next) => {
  if (req.headers["authorization"] !== `Bearer ${MCP_AUTH_TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`nfl-adp MCP server listening on port ${PORT}`);
});
