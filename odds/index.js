import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = process.env.MCP_HTTP_PORT || 4002;

// This server is HTTP-only (no stdio mode) and gets exposed to the public
// internet via Tailscale Funnel, so — same as the other espn-fantasy MCP
// servers on this box — it refuses to run without a bearer token.
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
if (!MCP_AUTH_TOKEN) {
  throw new Error(
    "MCP_AUTH_TOKEN is not set — refusing to serve over HTTP with no auth."
  );
}

const SCOREBOARD_BASE =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; fantasy-mcp/1.0)",
  Accept: "application/json",
};

async function fetchJson(url) {
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) {
    throw new Error(`ESPN API request failed: ${res.status} ${res.statusText} (${url})`);
  }
  return res.json();
}

/**
 * Builds the scoreboard URL. Regular season = seasontype 2, week 1-18.
 * Leaving params off returns ESPN's "current" scoreboard.
 */
function buildScoreboardUrl({ week, seasontype, year }) {
  const params = new URLSearchParams();
  if (week) params.set("week", String(week));
  if (seasontype) params.set("seasontype", String(seasontype));
  if (year) params.set("year", String(year));
  const qs = params.toString();
  return qs ? `${SCOREBOARD_BASE}?${qs}` : SCOREBOARD_BASE;
}

/**
 * Normalizes scoreboard events into flat game/odds records.
 * ESPN's odds array can contain multiple providers (ESPN BET, etc);
 * this takes the first available entry as the "consensus" line.
 */
function flattenGames(payload) {
  const events = payload?.events ?? [];
  const games = [];

  for (const ev of events) {
    const comp = ev?.competitions?.[0];
    const competitors = comp?.competitors ?? [];
    const home = competitors.find((c) => c.homeAway === "home");
    const away = competitors.find((c) => c.homeAway === "away");
    const oddsEntry = comp?.odds?.[0];

    games.push({
      id: ev?.id ?? null,
      date: ev?.date ?? null,
      shortName: ev?.shortName ?? null,
      homeTeam: home?.team?.abbreviation ?? null,
      awayTeam: away?.team?.abbreviation ?? null,
      provider: oddsEntry?.provider?.name ?? null,
      details: oddsEntry?.details ?? null, // e.g. "KC -3.5"
      spread: oddsEntry?.spread ?? null,
      overUnder: oddsEntry?.overUnder ?? null,
      // homeTeamOdds/awayTeamOdds only carry favorite/underdog flags — the actual
      // moneyline prices live under the separate moneyline.{home,away} blocks.
      homeMoneyline:
        oddsEntry?.moneyline?.home?.close?.odds ??
        oddsEntry?.moneyline?.home?.open?.odds ??
        null,
      awayMoneyline:
        oddsEntry?.moneyline?.away?.close?.odds ??
        oddsEntry?.moneyline?.away?.open?.odds ??
        null,
      status: ev?.status?.type?.description ?? null,
    });
  }
  return games;
}

// A fresh McpServer + transport is created per request (see the /mcp handler
// below). Reusing one McpServer across concurrent requests is unsafe: the SDK
// keeps a single mutable transport reference on the server, so two in-flight
// requests can have their responses cross-wired to the wrong client.
function buildServer() {
  const server = new McpServer({
    name: "nfl-odds",
    version: "1.0.0",
  });

  registerTools(server);
  return server;
}

function registerTools(server) {
server.registerTool(
  "get_week_odds",
  {
    title: "Get NFL odds for a week",
    description:
      "Get spreads, over/unders, and moneylines for NFL games. Omit all params to get " +
      "the current week's scoreboard; pass week/year for a specific one.",
    inputSchema: {
      week: z.number().int().min(1).max(18).optional().describe("Regular season week number, 1-18."),
      year: z.number().int().optional().describe("Season year, e.g. 2026."),
      seasontype: z
        .number()
        .int()
        .optional()
        .describe("1=preseason, 2=regular season, 3=postseason. Defaults to regular season context ESPN infers."),
    },
  },
  async ({ week, year, seasontype }) => {
    try {
      const url = buildScoreboardUrl({ week, year, seasontype });
      const payload = await fetchJson(url);
      const games = flattenGames(payload);
      return { content: [{ type: "text", text: JSON.stringify({ count: games.length, games }, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error fetching odds: ${err.message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "get_team_odds",
  {
    title: "Get odds for a specific team's game",
    description:
      "Get the spread, total, and moneyline for a specific team's game in the current (or specified) week.",
    inputSchema: {
      team: z.string().describe("Team abbreviation, e.g. 'DAL'."),
      week: z.number().int().min(1).max(18).optional(),
      year: z.number().int().optional(),
      seasontype: z.number().int().optional(),
    },
  },
  async ({ team, week, year, seasontype }) => {
    try {
      const url = buildScoreboardUrl({ week, year, seasontype });
      const payload = await fetchJson(url);
      const games = flattenGames(payload);
      const t = team.toUpperCase();
      const match = games.find((g) => g.homeTeam === t || g.awayTeam === t);
      if (!match) {
        return {
          content: [
            { type: "text", text: `No game found for team "${team}" in the requested scoreboard window.` },
          ],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(match, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error fetching team odds: ${err.message}` }],
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
  console.log(`nfl-odds MCP server listening on port ${PORT}`);
});
