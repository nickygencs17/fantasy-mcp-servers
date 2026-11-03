import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = process.env.MCP_HTTP_PORT || 4003;

// This server is HTTP-only (no stdio mode) and gets exposed to the public
// internet via Tailscale Funnel, so — same as the other espn-fantasy MCP
// servers on this box — it refuses to run without a bearer token.
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
if (!MCP_AUTH_TOKEN) {
  throw new Error(
    "MCP_AUTH_TOKEN is not set — refusing to serve over HTTP with no auth."
  );
}

// Keys in a roster-slots object that never represent draftable starting
// slots, regardless of count.
const NON_STARTER_KEYS = new Set(["BE", "BN", "IR", ""]);

// Compound keys that use "/" as part of a literal position name rather than
// as a flex-position separator (ESPN's own convention: Defense/Special Teams).
const LITERAL_COMPOUND_POSITIONS = new Set(["D/ST"]);

/**
 * Value-Based Drafting (VBD) — the methodology behind fantasy "beer sheet"
 * cheat sheets. Every player's value is their projection minus the
 * projection of the last starter-quality player at their position (the
 * "replacement" baseline), not their raw projection — this is what lets a
 * QB, RB, WR, and TE all be ranked on one list.
 *
 * Two baselines are supported:
 *  - VOLS (Value Over Last Starter): baseline = the Nth-best player at a
 *    position, where N is exactly how many starting slots across the whole
 *    league draw from that position (accounting for shared FLEX slots).
 *    This is the standard, unambiguous VBD baseline.
 *  - VORP: extends VOLS's baseline rank by a share of each team's bench
 *    slots, proportional to how many starters a position has. There's no
 *    single canonical VORP formula (real waiver-wire value varies by
 *    league), so this is a documented approximation, not an exact
 *    replication of any specific tool's numbers.
 *
 * This intentionally does not attempt BeerSheets' own "BEER" baseline
 * (a games-played/durability-adjusted replacement level) — that requires a
 * proprietary injury/attrition model this server has no access to. Faking
 * that data would produce numbers that look precise but aren't trustworthy.
 */
function computeDraftBoard({ players, rosterSlots, teamCount, baseline }) {
  const byPosition = new Map();
  for (const p of players) {
    if (!byPosition.has(p.position)) byPosition.set(p.position, []);
    byPosition.get(p.position).push(p);
  }
  for (const arr of byPosition.values()) {
    arr.sort((a, b) => b.projectedPoints - a.projectedPoints);
  }

  const dedicated = [];
  const flexGroups = [];
  for (const [key, perTeam] of Object.entries(rosterSlots)) {
    if (!perTeam || perTeam <= 0) continue;
    if (NON_STARTER_KEYS.has(key)) continue;

    const positions = LITERAL_COMPOUND_POSITIONS.has(key)
      ? [key]
      : key.split("/").map((s) => s.trim()).filter(Boolean);

    if (positions.length <= 1) {
      dedicated.push({ position: positions[0] ?? key, slots: perTeam * teamCount });
    } else {
      flexGroups.push({ positions, slots: perTeam * teamCount });
    }
  }

  const started = new Map();
  for (const { position, slots } of dedicated) {
    started.set(position, (started.get(position) ?? 0) + slots);
  }

  // Fill narrower flex groups (e.g. RB/WR) before broader ones (e.g.
  // RB/WR/TE) so a two-way flex doesn't get starved by a three-way one.
  flexGroups.sort((a, b) => a.positions.length - b.positions.length);

  const consumedIndex = new Map();
  for (const position of byPosition.keys()) {
    consumedIndex.set(position, started.get(position) ?? 0);
  }

  for (const { positions, slots } of flexGroups) {
    const candidates = [];
    for (const pos of positions) {
      const arr = byPosition.get(pos) ?? [];
      const startIdx = consumedIndex.get(pos) ?? 0;
      for (let i = startIdx; i < arr.length; i++) {
        candidates.push({ pos, projectedPoints: arr[i].projectedPoints });
      }
    }
    candidates.sort((a, b) => b.projectedPoints - a.projectedPoints);
    const chosen = candidates.slice(0, slots);

    const countPerPos = {};
    for (const c of chosen) countPerPos[c.pos] = (countPerPos[c.pos] ?? 0) + 1;
    for (const pos of positions) {
      const add = countPerPos[pos] ?? 0;
      started.set(pos, (started.get(pos) ?? 0) + add);
      consumedIndex.set(pos, (consumedIndex.get(pos) ?? 0) + add);
    }
  }

  let benchSlotsPerTeam = 0;
  for (const key of ["BE", "BN"]) {
    if (rosterSlots[key]) benchSlotsPerTeam = Math.max(benchSlotsPerTeam, rosterSlots[key]);
  }
  const totalBenchSlots = benchSlotsPerTeam * teamCount;
  const totalStarters = [...started.values()].reduce((a, b) => a + b, 0);

  const positionBaselines = {};
  for (const [position, arr] of byPosition.entries()) {
    let rank = started.get(position) ?? 0;
    if (baseline === "VORP" && totalStarters > 0 && totalBenchSlots > 0) {
      const share = (started.get(position) ?? 0) / totalStarters;
      rank += Math.round(totalBenchSlots * share);
    }

    if (rank <= 0 || arr.length === 0) {
      positionBaselines[position] = {
        starterSlots: rank,
        baselineProjectedPoints: null,
        note: "This league doesn't start this position (0 slots), so VBD isn't meaningful here.",
      };
      continue;
    }

    const idx = Math.min(rank, arr.length) - 1;
    positionBaselines[position] = {
      starterSlots: rank,
      baselineProjectedPoints: Math.round(arr[idx].projectedPoints * 100) / 100,
    };
  }

  const results = players.map((p) => {
    const base = positionBaselines[p.position]?.baselineProjectedPoints;
    const vbdValue = base == null ? null : Math.round((p.projectedPoints - base) * 100) / 100;
    return { ...p, vbdValue };
  });

  results.sort((a, b) => {
    if (a.vbdValue == null && b.vbdValue == null) return b.projectedPoints - a.projectedPoints;
    if (a.vbdValue == null) return 1;
    if (b.vbdValue == null) return -1;
    return b.vbdValue - a.vbdValue;
  });

  const posCounter = {};
  for (const r of results) {
    posCounter[r.position] = (posCounter[r.position] ?? 0) + 1;
    r.positionRank = posCounter[r.position];
  }
  results.forEach((r, i) => {
    r.overallRank = i + 1;
  });

  return { baseline, teamCount, positionBaselines, count: results.length, players: results };
}

function buildServer() {
  const s = new McpServer({ name: "beer-sheet", version: "1.0.0" });
  registerTools(s);
  return s;
}

function registerTools(server) {
  server.registerTool(
    "compute_draft_board",
    {
      title: "Compute a Value-Based-Drafting draft board (a 'beer sheet')",
      description:
        "Turns a flat list of player projections into a single VBD-ranked draft board — " +
        "the same core method behind fantasy football 'beer sheet' cheat sheets. Every " +
        "player gets a vbdValue = their projected points minus the projected points of the " +
        "last startable player at their position (the replacement baseline), which is what " +
        "makes players at different positions directly comparable on one ranked list, " +
        "instead of just sorting by raw projection. Pass league roster settings straight " +
        "from ESPN's own roster_positions object (e.g. {\"QB\":1,\"RB\":2,\"WR\":2,\"TE\":1," +
        "\"RB/WR/TE\":2,\"D/ST\":1,\"K\":1,\"BE\":7}) — flex slots (any key with '/' other " +
        "than the literal 'D/ST') are pooled across their eligible positions automatically.",
      inputSchema: {
        players: z
          .array(
            z.object({
              name: z.string(),
              position: z.string().describe("e.g. 'QB', 'RB', 'WR', 'TE', 'D/ST', 'K' — must match a key (or a constituent of a flex key) in rosterSlots to get a baseline."),
              projectedPoints: z.number(),
              team: z.string().optional(),
            }).passthrough()
          )
          .describe("Flat list of every player to rank, across all positions."),
        rosterSlots: z
          .record(z.string(), z.number())
          .describe("Starting slots per team, using ESPN's roster_positions keys directly (bench/IR keys like BE/BN/IR are ignored for the starter baseline; BE is used for the VORP approximation)."),
        teamCount: z.number().int().min(1).describe("Number of teams in the league."),
        baseline: z
          .enum(["VOLS", "VORP"])
          .optional()
          .describe(
            "VOLS (default): baseline = last starter-quality player at the position, given league size and roster slots. " +
              "VORP: VOLS extended by an approximate share of bench slots — an approximation, not a canonical formula."
          ),
      },
    },
    async ({ players, rosterSlots, teamCount, baseline }) => {
      try {
        const board = computeDraftBoard({
          players,
          rosterSlots,
          teamCount,
          baseline: baseline ?? "VOLS",
        });
        return { content: [{ type: "text", text: JSON.stringify(board, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error computing draft board: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}

const app = express();
app.use(express.json({ limit: "5mb" }));

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
  console.log(`beer-sheet MCP server listening on port ${PORT}`);
});
