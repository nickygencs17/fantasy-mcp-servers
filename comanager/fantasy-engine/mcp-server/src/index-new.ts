#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

// Import from shared library
import {
  espnApi,
  llmConfig,
  getMyRoster,
  executeAIWorkflow,
} from '@fantasy-ai/shared';

// Import from local tool implementations (not part of @fantasy-ai/shared)
import { espnApi as localEspnApi } from './services/espnApi.js';
import { getRosterTool, analyzeRosterTool } from './tools/roster.js';
import { optimizeLineupTool, getStartSitAdviceTool } from './tools/lineup.js';
import { findWaiverTargetsTool, analyzePlayerTool } from './tools/waiver.js';
import { analyzeTradesTool, findTradeTargetsTool } from './tools/trades.js';
import {
  getStandingsTool,
  getLeagueTeamsTool,
  getScoreboardTool,
  getBoxScoreTool,
  getTeamScheduleTool,
  getPowerRankingsTool,
  getPlayoffPictureTool,
  getRecentActivityTool,
  getTransactionsTool,
  getPlayerCardTool,
  getDefenseVsPositionTool,
  getTrendingPlayersTool,
  getClinchScenariosTool,
} from './tools/league.js';

// Load environment variables
dotenv.config();

// Initialize ESPN API with cookies if available
const ESPN_S2 = process.env.ESPN_S2 || '';
const ESPN_SWID = process.env.ESPN_SWID || '';

// NOTE: the local tool files (roster/lineup/waiver/trades.ts) import a separate
// espnApi singleton from ./services/espnApi.js, not the one from @fantasy-ai/shared.
// Cookies must be set on both instances or the local ones 401.
if (ESPN_S2 && ESPN_SWID) {
  localEspnApi.setCookies({
    espn_s2: ESPN_S2,
    swid: ESPN_SWID
  });
  espnApi.setCookies({
    espn_s2: ESPN_S2,
    swid: ESPN_SWID
  });
  console.error('ESPN cookies configured from environment');
} else {
  console.error('Warning: ESPN cookies not found in environment. Private league access will not work.');
  console.error('Set ESPN_S2 and ESPN_SWID environment variables for private league access.');
}

// Initialize LLM configuration
await llmConfig.initializeLLM();

// Create MCP server
const server = new Server(
  {
    name: 'espn-fantasy-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define available tools (same tool definitions as before)
const tools: Tool[] = [
  {
    name: 'get_roster',
    description: 'Get the current roster for a fantasy team with all player details',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string', description: 'ESPN Fantasy league ID' },
        teamId: { type: 'string', description: 'Team ID within the league' }
      },
      required: ['leagueId', 'teamId']
    }
  },
  {
    name: 'analyze_roster',
    description: 'Analyze a team roster for strengths, weaknesses, and recommendations',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string' },
        teamId: { type: 'string' }
      },
      required: ['leagueId', 'teamId']
    }
  },
  {
    name: 'optimize_lineup',
    description: 'Get optimal lineup recommendations based on projections and matchups',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string' },
        teamId: { type: 'string' },
        week: { type: 'number', description: 'Week number (optional, defaults to current week)' }
      },
      required: ['leagueId', 'teamId']
    }
  },
  {
    name: 'my_roster',
    description: 'Get simplified current roster information',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string' },
        teamId: { type: 'string' }
      },
      required: ['leagueId', 'teamId']
    }
  },
  {
    name: 'get_start_sit_advice',
    description: 'Get a start/sit recommendation for a specific player on your roster',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string' },
        teamId: { type: 'string' },
        playerName: { type: 'string', description: 'Name (or partial name) of the player' }
      },
      required: ['leagueId', 'teamId', 'playerName']
    }
  },
  {
    name: 'find_waiver_targets',
    description: 'Find the best available free agents to pick up off waivers, optionally filtered by position',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string' },
        teamId: { type: 'string', description: 'Optional, used to tailor drop candidates' },
        position: { type: 'string', description: 'e.g. RB, WR, QB, TE, K, D/ST' },
        maxResults: { type: 'number', description: 'Default 10' }
      },
      required: ['leagueId']
    }
  },
  {
    name: 'analyze_player',
    description: 'Get an add/hold/drop verdict on a specific player (rostered or free agent)',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string' },
        playerName: { type: 'string' }
      },
      required: ['leagueId', 'playerName']
    }
  },
  {
    name: 'analyze_trade',
    description: 'Analyze a proposed trade: which players you would give and receive',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string' },
        teamId: { type: 'string' },
        giving: { type: 'array', items: { type: 'string' }, description: 'Player names you would give up' },
        receiving: { type: 'array', items: { type: 'string' }, description: 'Player names you would receive' }
      },
      required: ['leagueId', 'teamId', 'giving', 'receiving']
    }
  },
  {
    name: 'find_trade_targets',
    description: 'Suggest realistic trade offers to fill a roster need, optionally targeting a position',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string' },
        teamId: { type: 'string' },
        targetPosition: { type: 'string' }
      },
      required: ['leagueId', 'teamId']
    }
  },
  {
    name: 'get_standings',
    description: 'League standings: seed, W-L-T, points for/against, streak, games back, ESPN playoff odds, waiver priority, FAAB remaining and add/drop/trade counts for every team',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string', description: 'ESPN Fantasy league ID' },
        teamId: { type: 'string', description: 'Optional, marks your team in the output' }
      },
      required: ['leagueId']
    }
  },
  {
    name: 'get_league_teams',
    description: 'All teams in the league: team id, name, abbreviation and owner display names, plus the current week and matchup period',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string', description: 'ESPN Fantasy league ID' }
      },
      required: ['leagueId']
    }
  },
  {
    name: 'get_scoreboard',
    description: 'Every matchup for a week with each side\'s score, live projected score, winner and playoff flag',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string', description: 'ESPN Fantasy league ID' },
        week: { type: 'number', description: 'Week number (optional, defaults to current week)' }
      },
      required: ['leagueId']
    }
  },
  {
    name: 'get_box_score',
    description: 'Player-by-player box score of one team\'s matchup: lineup slot, starters vs bench, actual vs projected points, injury status and NFL opponent for both teams',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string', description: 'ESPN Fantasy league ID' },
        teamId: { type: 'string', description: 'Team ID within the league' },
        week: { type: 'number', description: 'Week number (optional, defaults to current week)' }
      },
      required: ['leagueId', 'teamId']
    }
  },
  {
    name: 'get_team_schedule',
    description: 'A team\'s full schedule: every week\'s opponent, score, result and margin, plus remaining opponents\' records and strength of schedule',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string', description: 'ESPN Fantasy league ID' },
        teamId: { type: 'string', description: 'Team ID within the league' }
      },
      required: ['leagueId', 'teamId']
    }
  },
  {
    name: 'get_power_rankings',
    description: 'Power rankings: all-play record, actual vs all-play win % (luck), points-for rank, last-3-week form and a combined power score',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string', description: 'ESPN Fantasy league ID' },
        teamId: { type: 'string', description: 'Optional, marks your team in the output' }
      },
      required: ['leagueId']
    }
  },
  {
    name: 'get_playoff_picture',
    description: 'Playoff race: who is in, on the bubble, clinched or eliminated, games back of the last playoff spot, points-for tiebreaks, remaining schedules and ESPN playoff odds',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string', description: 'ESPN Fantasy league ID' },
        teamId: { type: 'string', description: 'Optional, marks your team in the output' }
      },
      required: ['leagueId']
    }
  },
  {
    name: 'get_recent_activity',
    description: 'Recent league-wide activity: free agent and waiver adds, drops and trades with team, player and date',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string', description: 'ESPN Fantasy league ID' },
        limit: { type: 'number', description: 'Number of transactions to return (default 25, max 100)' }
      },
      required: ['leagueId']
    }
  },
  {
    name: 'get_transactions',
    description: 'A week\'s processed waiver claims with FAAB bids (won and failed), free agent moves and trades',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string', description: 'ESPN Fantasy league ID' },
        week: { type: 'number', description: 'Week number (optional, defaults to current week)' }
      },
      required: ['leagueId']
    }
  },
  {
    name: 'get_player_card',
    description: 'Full player card: season stats, recent actual vs projected points, rest-of-season projection, ESPN outlook, latest news, ownership % and weekly change, who rosters him in this league, and upcoming NFL opponents',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string', description: 'ESPN Fantasy league ID' },
        playerName: { type: 'string', description: 'Name (or partial name) of the player' }
      },
      required: ['leagueId', 'playerName']
    }
  },
  {
    name: 'get_defense_vs_position',
    description: 'Each NFL defense\'s rank and average fantasy points allowed to QB, RB, WR, TE and K (rank 1 = toughest)',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string', description: 'ESPN Fantasy league ID' },
        position: { type: 'string', description: 'Optional: QB, RB, WR, TE, K or D/ST. Defaults to QB/RB/WR/TE/K' }
      },
      required: ['leagueId']
    }
  },
  {
    name: 'get_trending_players',
    description: 'Biggest ESPN-wide ownership risers and fallers this week, marking which are free agents in this league',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string', description: 'ESPN Fantasy league ID' },
        position: { type: 'string', description: 'Optional: QB, RB, WR, TE, K or D/ST' },
        limit: { type: 'number', description: 'Players per list (default 10, max 50)' }
      },
      required: ['leagueId']
    }
  },
  {
    name: 'get_clinch_scenarios',
    description: 'How many wins lock a playoff spot: for every team, the final record that guarantees a spot in the worst case, playoff chances by final record from 20,000 season simulations, chance of a top-2 seed, and how many wins the last playoff seed usually needs',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string', description: 'ESPN Fantasy league ID' },
        teamId: { type: 'string', description: 'Optional, marks your team in the output' }
      },
      required: ['leagueId']
    }
  }
];

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Call tool handler - simplified routing
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: any;

    switch (name) {
      case 'get_roster':
        result = await getRosterTool(args as any);
        break;
      case 'analyze_roster':
        result = await analyzeRosterTool(args as any);
        break;
      case 'optimize_lineup':
        result = await optimizeLineupTool(args as any);
        break;
      case 'my_roster':
        result = await getMyRoster(args as any);
        break;
      case 'get_start_sit_advice':
        result = await getStartSitAdviceTool(args as any);
        break;
      case 'find_waiver_targets':
        result = await findWaiverTargetsTool(args as any);
        break;
      case 'analyze_player':
        result = await analyzePlayerTool(args as any);
        break;
      case 'analyze_trade':
        result = await analyzeTradesTool(args as any);
        break;
      case 'find_trade_targets':
        result = await findTradeTargetsTool(args as any);
        break;
      case 'get_standings':
        result = await getStandingsTool(args as any);
        break;
      case 'get_league_teams':
        result = await getLeagueTeamsTool(args as any);
        break;
      case 'get_scoreboard':
        result = await getScoreboardTool(args as any);
        break;
      case 'get_box_score':
        result = await getBoxScoreTool(args as any);
        break;
      case 'get_team_schedule':
        result = await getTeamScheduleTool(args as any);
        break;
      case 'get_power_rankings':
        result = await getPowerRankingsTool(args as any);
        break;
      case 'get_playoff_picture':
        result = await getPlayoffPictureTool(args as any);
        break;
      case 'get_recent_activity':
        result = await getRecentActivityTool(args as any);
        break;
      case 'get_transactions':
        result = await getTransactionsTool(args as any);
        break;
      case 'get_player_card':
        result = await getPlayerCardTool(args as any);
        break;
      case 'get_defense_vs_position':
        result = await getDefenseVsPositionTool(args as any);
        break;
      case 'get_trending_players':
        result = await getTrendingPlayersTool(args as any);
        break;
      case 'get_clinch_scenarios':
        result = await getClinchScenariosTool(args as any);
        break;
      case 'execute_ai_workflow':
        result = await executeAIWorkflow(args as any);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server. HTTP mode (for remote access via a tunnel, e.g. Tailscale
// Funnel) is opt-in via MCP_HTTP_PORT — `node dist/index-new.js` with no env
// vars still runs stdio, unchanged, for local Claude Desktop use.
const MCP_HTTP_PORT = process.env.MCP_HTTP_PORT;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ESPN Fantasy MCP Server running on stdio');
}

async function mainHttp(port: number) {
  if (!MCP_AUTH_TOKEN) {
    throw new Error(
      'MCP_HTTP_PORT is set but MCP_AUTH_TOKEN is not — refusing to serve ' +
      'ESPN credentials over HTTP with no auth.'
    );
  }

  // Sessions map: the MCP streamable-http spec is stateful (an
  // `initialize` call gets a session id back, used on every request after).
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const httpServer = http.createServer(async (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${MCP_AUTH_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    let body: unknown;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      body = raw ? JSON.parse(raw) : undefined;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport = sessionId ? transports[sessionId] : undefined;

    if (!transport && req.method === 'POST' && isInitializeRequest(body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport!;
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) delete transports[transport!.sessionId];
      };
      await server.connect(transport);
    }

    if (!transport) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No valid session' }));
      return;
    }

    await transport.handleRequest(req, res, body);
  });

  httpServer.listen(port, '0.0.0.0', () => {
    console.error(`ESPN Fantasy MCP Server (HTTP) listening on port ${port}`);
  });
}

if (MCP_HTTP_PORT) {
  mainHttp(parseInt(MCP_HTTP_PORT, 10)).catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
  });
} else {
  main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
  });
}