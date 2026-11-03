import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = process.env.MCP_HTTP_PORT || 4001;

// This server is HTTP-only (no stdio mode) and gets exposed to the public
// internet via Tailscale Funnel, so — same as the other espn-fantasy MCP
// servers on this box — it refuses to run without a bearer token.
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
if (!MCP_AUTH_TOKEN) {
  throw new Error(
    "MCP_AUTH_TOKEN is not set — refusing to serve over HTTP with no auth."
  );
}

const INJURIES_URL =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries";
const NEWS_URL =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/news";

// ESPN's public site API is unauthenticated but is picky about a
// missing User-Agent on some networks — set one to be safe.
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
 * Normalizes the injuries payload into a flat list of
 * { team, player, position, status, detail, date } records.
 * ESPN's shape has shifted before, so this is defensive about
 * missing fields rather than assuming one exact structure.
 */
function flattenInjuries(payload) {
  const teams = payload?.injuries ?? [];
  const rows = [];

  for (const teamBlock of teams) {
    const teamInjuries = teamBlock?.injuries ?? [];

    for (const inj of teamInjuries) {
      // The team-level block only carries { id, displayName, injuries } — the
      // abbreviation actually lives on each injury's nested athlete.team.
      const teamAbbr = inj?.athlete?.team?.abbreviation ?? "UNK";
      const teamName =
        teamBlock?.displayName ?? inj?.athlete?.team?.displayName ?? teamAbbr;

      rows.push({
        team: teamAbbr,
        teamName,
        player: inj?.athlete?.displayName ?? "Unknown",
        position:
          inj?.athlete?.position?.abbreviation ?? inj?.athlete?.position?.name ?? null,
        status: inj?.status ?? "Unknown",
        // shortComment/longComment carry the actual reported note; details.detail
        // is frequently just the placeholder string "Not Specified".
        detail: inj?.shortComment ?? inj?.longComment ?? inj?.details?.detail ?? null,
        date: inj?.date ?? null,
      });
    }
  }
  return rows;
}

function flattenNews(payload, limit) {
  const articles = payload?.articles ?? [];
  return articles.slice(0, limit).map((a) => ({
    headline: a?.headline ?? "Untitled",
    description: a?.description ?? null,
    published: a?.published ?? null,
    link: a?.links?.web?.href ?? null,
    teams:
      (a?.categories ?? [])
        .map((c) => c?.team?.abbreviation)
        .filter(Boolean) ?? [],
  }));
}

// A fresh McpServer + transport is created per request (see the /mcp handler
// below). Reusing one McpServer across concurrent requests is unsafe: the SDK
// keeps a single mutable transport reference on the server, so two in-flight
// requests can have their responses cross-wired to the wrong client.
function buildServer() {
  const server = new McpServer({
    name: "nfl-injury-news",
    version: "1.0.0",
  });

  registerTools(server);
  return server;
}

function registerTools(server) {
server.registerTool(
  "get_injury_report",
  {
    title: "Get NFL injury report",
    description:
      "Get current NFL injury designations (Out/Doubtful/Questionable/IR etc). " +
      "Optionally filter to a single team by abbreviation (e.g. 'KC', 'SF').",
    inputSchema: {
      team: z
        .string()
        .optional()
        .describe("Team abbreviation to filter to, e.g. 'KC'. Omit for the full league report."),
    },
  },
  async ({ team }) => {
    try {
      const payload = await fetchJson(INJURIES_URL);
      let rows = flattenInjuries(payload);
      if (team) {
        const t = team.toUpperCase();
        rows = rows.filter((r) => r.team.toUpperCase() === t);
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ count: rows.length, injuries: rows }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error fetching injury report: ${err.message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "get_player_injury_status",
  {
    title: "Get a specific player's injury status",
    description:
      "Search the current league-wide injury report for a specific player by name " +
      "(partial, case-insensitive match).",
    inputSchema: {
      playerName: z.string().describe("Player name or partial name to search for, e.g. 'Mahomes'."),
    },
  },
  async ({ playerName }) => {
    try {
      const payload = await fetchJson(INJURIES_URL);
      const rows = flattenInjuries(payload);
      const needle = playerName.toLowerCase();
      const matches = rows.filter((r) => r.player.toLowerCase().includes(needle));
      if (matches.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No injury designation found for "${playerName}" — they may not be on the current injury report (i.e. likely active/healthy), or the name didn't match.`,
            },
          ],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error fetching injury status: ${err.message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "get_recent_news",
  {
    title: "Get recent NFL news",
    description:
      "Get recent NFL news headlines from ESPN. Optionally filter to articles tagged with a specific team.",
    inputSchema: {
      team: z.string().optional().describe("Team abbreviation to filter to, e.g. 'BUF'. Omit for all news."),
      limit: z.number().int().min(1).max(50).optional().describe("Max articles to return (default 10)."),
    },
  },
  async ({ team, limit }) => {
    try {
      const payload = await fetchJson(NEWS_URL);
      // Flatten *all* articles before filtering by team, then apply the
      // requested limit last — otherwise a team filter combined with a small
      // limit could truncate away matching articles before they're ever
      // checked against the team.
      let articles = flattenNews(payload, Infinity);
      if (team) {
        const t = team.toUpperCase();
        articles = articles.filter((a) => a.teams.includes(t));
      }
      articles = articles.slice(0, limit ?? 10);
      return { content: [{ type: "text", text: JSON.stringify({ count: articles.length, articles }, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error fetching news: ${err.message}` }],
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
  console.log(`nfl-injury-news MCP server listening on port ${PORT}`);
});
