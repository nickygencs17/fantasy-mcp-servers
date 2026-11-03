import { espnApi } from '../services/espnApi.js';

// League-wide tools: standings, scoreboard, box scores, schedule, power
// rankings, playoff picture, activity, transactions, player card, defense vs
// position and trending players. All ESPN reads go through
// espnApi.getLeagueData(), which caches identical requests for 60s.

const POSITIONS: { [id: number]: string } = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };
const POSITION_IDS: { [pos: string]: number } = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, 'D/ST': 16, DST: 16 };
// Lineup slot that a position fills, used for ESPN's filterSlotIds
const POSITION_SLOT_IDS: { [pos: string]: number } = { QB: 0, RB: 2, WR: 4, TE: 6, K: 17, 'D/ST': 16, DST: 16 };
const LINEUP_SLOTS: { [id: number]: string } = {
  0: 'QB', 1: 'TQB', 2: 'RB', 3: 'RB/WR', 4: 'WR', 5: 'WR/TE', 6: 'TE', 7: 'OP',
  16: 'D/ST', 17: 'K', 20: 'Bench', 21: 'IR', 23: 'FLEX'
};
const SLOT_ORDER = [0, 1, 2, 3, 4, 5, 6, 23, 7, 16, 17, 20, 21];
const BENCH_SLOT = 20;
const IR_SLOT = 21;
const STAT_SOURCE_ACTUAL = 0;
const STAT_SOURCE_PROJECTED = 1;

// ESPN stat ids -> readable names, for the player card's season line
const STAT_NAMES: { [id: string]: string } = {
  0: 'passAtt', 1: 'passComp', 3: 'passYds', 4: 'passTD', 20: 'passINT',
  23: 'rushAtt', 24: 'rushYds', 25: 'rushTD',
  58: 'targets', 53: 'receptions', 42: 'recYds', 43: 'recTD', 72: 'fumblesLost',
  83: 'fgMade', 84: 'fgAtt', 86: 'xpMade', 87: 'xpAtt',
  99: 'sacks', 95: 'defINT', 96: 'fumbleRec', 94: 'defTD', 98: 'safeties',
  120: 'pointsAllowed', 127: 'yardsAllowed'
};

const ACTIVITY_MESSAGE_TYPES: { [id: number]: string } = {
  178: 'ADD (FA)', 180: 'ADD (waiver)', 179: 'DROP', 181: 'DROP', 239: 'DROP', 244: 'TRADE'
};

const round = (n: number | null | undefined, digits = 2): number | null =>
  n === null || n === undefined || Number.isNaN(n) ? null : Number(n.toFixed(digits));

const isoDate = (ms: number | undefined): string | null => (ms ? new Date(ms).toISOString() : null);

function requireLeague(leagueId: string) {
  if (!leagueId) throw new Error('League ID is required');
}

function parseTeamId(teamId: string | number | undefined): number {
  const id = parseInt(String(teamId), 10);
  if (Number.isNaN(id)) throw new Error('Team ID is required');
  return id;
}

// ---------------------------------------------------------------------------
// Shared league context (one cached request covers teams, standings, settings
// and the full season schedule with scores)
// ---------------------------------------------------------------------------

interface LeagueContext {
  raw: any;
  name: string;
  season: number;
  currentMatchupPeriod: number;
  scoringPeriodId: number;
  finalScoringPeriod: number;
  regularSeasonWeeks: number;
  playoffTeams: number;
  faabBudget: number;
  teams: Map<number, any>;
  owners: Map<number, string[]>;
  schedule: any[];
}

async function getLeagueContext(leagueId: string): Promise<LeagueContext> {
  requireLeague(leagueId);
  const raw = await espnApi.getLeagueData(leagueId, ['mTeam', 'mStandings', 'mSettings', 'mMatchupScore']);
  const members = new Map<string, string>(
    (raw.members || []).map((m: any) => [m.id, m.displayName || `${m.firstName || ''} ${m.lastName || ''}`.trim()])
  );
  const teams = new Map<number, any>();
  const owners = new Map<number, string[]>();
  for (const team of raw.teams || []) {
    // Team names often carry stray leading/trailing spaces
    teams.set(team.id, { ...team, name: (team.name || '').trim() || `Team ${team.id}` });
    owners.set(team.id, (team.owners || []).map((id: string) => members.get(id)).filter(Boolean));
  }
  const settings = raw.settings || {};
  return {
    raw,
    name: settings.name || 'Unknown League',
    season: raw.seasonId,
    currentMatchupPeriod: raw.status?.currentMatchupPeriod || 1,
    scoringPeriodId: raw.scoringPeriodId || 1,
    finalScoringPeriod: raw.status?.finalScoringPeriod || 17,
    regularSeasonWeeks: settings.scheduleSettings?.matchupPeriodCount || 14,
    playoffTeams: settings.scheduleSettings?.playoffTeamCount || 6,
    faabBudget: settings.acquisitionSettings?.acquisitionBudget ?? 250,
    teams,
    owners,
    schedule: raw.schedule || []
  };
}

function teamName(ctx: LeagueContext, teamId: number): string {
  return ctx.teams.get(teamId)?.name || `Team ${teamId}`;
}

function teamAbbrev(ctx: LeagueContext, teamId: number): string {
  return ctx.teams.get(teamId)?.abbrev || `T${teamId}`;
}

function getTeamOrThrow(ctx: LeagueContext, teamId: number): any {
  const team = ctx.teams.get(teamId);
  if (!team) {
    throw new Error(`Team ${teamId} not found in league. Available teams: ${[...ctx.teams.keys()].join(', ')}`);
  }
  return team;
}

function resolveWeek(ctx: LeagueContext, week: number | string | undefined): number {
  if (week === undefined || week === null || week === '') return ctx.currentMatchupPeriod;
  const n = parseInt(String(week), 10);
  if (Number.isNaN(n) || n < 1 || n > ctx.finalScoringPeriod) {
    throw new Error(`Week must be between 1 and ${ctx.finalScoringPeriod}`);
  }
  return n;
}

// Matchup period -> the scoring period to read player stats for. Weekly
// leagues map 1:1; for multi-week matchups use the latest period started.
function scoringPeriodForWeek(ctx: LeagueContext, week: number): number {
  const periods: number[] = ctx.raw.settings?.scheduleSettings?.matchupPeriods?.[String(week)] || [week];
  const started = periods.filter((p) => p <= ctx.scoringPeriodId);
  return started.length ? Math.max(...started) : periods[0];
}

function overall(team: any) {
  const r = team.record?.overall || {};
  const wins = r.wins || 0;
  const losses = r.losses || 0;
  const ties = r.ties || 0;
  const games = wins + losses + ties;
  return {
    wins,
    losses,
    ties,
    games,
    winsEquivalent: wins + ties / 2,
    winPct: games ? (wins + ties / 2) / games : 0,
    pointsFor: r.pointsFor || 0,
    pointsAgainst: r.pointsAgainst || 0,
    streak: r.streakType && r.streakType !== 'NONE' ? `${r.streakType[0]}${r.streakLength}` : '-',
    gamesBack: r.gamesBack || 0,
    record: `${wins}-${losses}-${ties}`
  };
}

function sortedBySeed(ctx: LeagueContext): any[] {
  return [...ctx.teams.values()].sort((a, b) => {
    if (a.playoffSeed && b.playoffSeed) return a.playoffSeed - b.playoffSeed;
    const ra = overall(a);
    const rb = overall(b);
    return rb.winsEquivalent - ra.winsEquivalent || rb.pointsFor - ra.pointsFor;
  });
}

function pointsForRanks(ctx: LeagueContext): Map<number, number> {
  const ordered = [...ctx.teams.values()].sort((a, b) => overall(b).pointsFor - overall(a).pointsFor);
  return new Map(ordered.map((t, i) => [t.id, i + 1]));
}

const isRegularSeason = (m: any) => !m.playoffTierType || m.playoffTierType === 'NONE';
const isDecided = (m: any) => m.winner && m.winner !== 'UNDECIDED';

function sideScore(side: any): number {
  return side?.totalPointsLive ?? side?.totalPoints ?? 0;
}

// ---------------------------------------------------------------------------
// Player helpers (box scores, player card)
// ---------------------------------------------------------------------------

function statFor(player: any, source: number, scoringPeriodId: number, season?: number): number | null {
  const stat = (player?.stats || []).find(
    (s: any) =>
      s.statSourceId === source &&
      s.scoringPeriodId === scoringPeriodId &&
      s.statSplitTypeId === 1 &&
      (season === undefined || s.seasonId === season)
  );
  return stat ? stat.appliedTotal ?? 0 : null;
}

type ProGameIndex = Map<number, Map<number, { opponent: string; opponentId: number; kickoff: string | null }>>;

// week -> proTeamId -> "vs KC" / "@KC"
async function getProGameIndex(): Promise<{ games: ProGameIndex; abbrevs: Map<number, string>; byes: Map<number, number> }> {
  const proTeams = await espnApi.getProTeamSchedules();
  const abbrevs = new Map<number, string>(proTeams.map((t: any) => [t.id, t.abbrev?.toUpperCase() || 'FA']));
  const byes = new Map<number, number>(proTeams.map((t: any) => [t.id, t.byeWeek]));
  const games: ProGameIndex = new Map();
  for (const team of proTeams) {
    for (const [week, list] of Object.entries<any[]>(team.proGamesByScoringPeriod || {})) {
      const game = list[0];
      if (!game) continue;
      const home = game.homeProTeamId === team.id;
      const oppId = home ? game.awayProTeamId : game.homeProTeamId;
      if (!games.has(Number(week))) games.set(Number(week), new Map());
      games.get(Number(week))!.set(team.id, {
        opponent: `${home ? 'vs ' : '@'}${abbrevs.get(oppId) || oppId}`,
        opponentId: oppId,
        kickoff: isoDate(game.date)
      });
    }
  }
  return { games, abbrevs, byes };
}

function opponentFor(index: ProGameIndex, week: number, proTeamId: number): string {
  if (!proTeamId) return 'FA';
  return index.get(week)?.get(proTeamId)?.opponent || 'BYE';
}

function injuryLabel(player: any): string | undefined {
  const status = player?.injuryStatus;
  return status && !['ACTIVE', 'NORMAL'].includes(status) ? status : undefined;
}

// Resolve player ids to names in one request (negative ids are D/STs)
async function getPlayerLookup(leagueId: string, ids: number[]): Promise<Map<number, any>> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'number' && id !== 0))];
  if (!unique.length) return new Map();
  const data = await espnApi.getLeagueData(leagueId, ['kona_player_info'], {
    filter: {
      players: {
        filterIds: { value: unique },
        filterStatsForTopScoringPeriodIds: { value: 1, additionalValue: [`00${espnApi.getSeasonYear()}`] }
      }
    }
  });
  return new Map((data.players || []).map((p: any) => [p.id, p.player]));
}

function describePlayer(lookup: Map<number, any>, abbrevs: Map<number, string>, id: number) {
  const p = lookup.get(id);
  return {
    player: p?.fullName || `Player ${id}`,
    pos: POSITIONS[p?.defaultPositionId] || undefined,
    nflTeam: p?.proTeamId ? abbrevs.get(p.proTeamId) : undefined
  };
}

// ---------------------------------------------------------------------------
// 1. get_standings
// ---------------------------------------------------------------------------

export async function getStandingsTool(args: { leagueId: string; teamId?: string }) {
  const ctx = await getLeagueContext(args.leagueId);
  const myTeamId = args.teamId ? parseInt(args.teamId, 10) : undefined;
  const pfRanks = pointsForRanks(ctx);
  const standings = sortedBySeed(ctx).map((team, i) => {
    const r = overall(team);
    const counter = team.transactionCounter || {};
    const playoffPct = team.currentSimulationResults?.playoffPct;
    return {
      seed: team.playoffSeed || i + 1,
      teamId: team.id,
      team: team.name,
      abbrev: team.abbrev,
      owners: ctx.owners.get(team.id),
      record: r.record,
      winPct: round(r.winPct, 3),
      pointsFor: round(r.pointsFor),
      pointsForRank: pfRanks.get(team.id),
      pointsAgainst: round(r.pointsAgainst),
      streak: r.streak,
      gamesBack: r.gamesBack,
      playoffOddsPct: playoffPct === undefined ? null : round(playoffPct * 100, 1),
      waiverPriority: team.waiverRank ?? null,
      faabRemaining: ctx.faabBudget - (counter.acquisitionBudgetSpent || 0),
      faabSpent: counter.acquisitionBudgetSpent || 0,
      adds: counter.acquisitions || 0,
      drops: counter.drops || 0,
      trades: counter.trades || 0,
      ...(myTeamId === team.id ? { isYou: true } : {})
    };
  });
  return {
    league: ctx.name,
    season: ctx.season,
    currentWeek: ctx.currentMatchupPeriod,
    regularSeasonWeeks: ctx.regularSeasonWeeks,
    playoffTeams: ctx.playoffTeams,
    seedingTiebreaker: ctx.raw.settings?.scheduleSettings?.playoffSeedingRule || null,
    faabBudget: ctx.faabBudget,
    standings
  };
}

// ---------------------------------------------------------------------------
// 2. get_league_teams
// ---------------------------------------------------------------------------

export async function getLeagueTeamsTool(args: { leagueId: string }) {
  const ctx = await getLeagueContext(args.leagueId);
  return {
    league: ctx.name,
    season: ctx.season,
    currentWeek: ctx.scoringPeriodId,
    currentMatchupPeriod: ctx.currentMatchupPeriod,
    regularSeasonWeeks: ctx.regularSeasonWeeks,
    playoffTeams: ctx.playoffTeams,
    tradeDeadline: isoDate(ctx.raw.settings?.tradeSettings?.deadlineDate),
    teams: [...ctx.teams.values()]
      .sort((a, b) => a.id - b.id)
      .map((t) => ({ teamId: t.id, name: t.name, abbrev: t.abbrev, owners: ctx.owners.get(t.id) }))
  };
}

// ---------------------------------------------------------------------------
// 3. get_scoreboard / 4. get_box_score
// ---------------------------------------------------------------------------

async function getWeekMatchups(leagueId: string, ctx: LeagueContext, week: number) {
  const scoringPeriodId = scoringPeriodForWeek(ctx, week);
  const data = await espnApi.getLeagueData(leagueId, ['mMatchupScore', 'mScoreboard'], {
    scoringPeriodId,
    filter: { schedule: { filterMatchupPeriodIds: { value: [week] } } }
  });
  const matchups = (data.schedule || []).filter((m: any) => m.matchupPeriodId === week);
  return { scoringPeriodId, matchups };
}

function starterTotals(side: any, scoringPeriodId: number) {
  let projected = 0;
  for (const entry of side?.rosterForCurrentScoringPeriod?.entries || []) {
    if (entry.lineupSlotId === BENCH_SLOT || entry.lineupSlotId === IR_SLOT) continue;
    projected += statFor(entry.playerPoolEntry?.player, STAT_SOURCE_PROJECTED, scoringPeriodId) || 0;
  }
  return projected;
}

function matchupStatus(ctx: LeagueContext, week: number, m: any): 'final' | 'in_progress' | 'upcoming' {
  if (isDecided(m)) return 'final';
  if (week > ctx.currentMatchupPeriod) return 'upcoming';
  return sideScore(m.home) > 0 || sideScore(m.away) > 0 ? 'in_progress' : 'upcoming';
}

function winnerName(ctx: LeagueContext, m: any): string | null {
  if (m.winner === 'HOME') return teamName(ctx, m.home.teamId);
  if (m.winner === 'AWAY' && m.away) return teamName(ctx, m.away.teamId);
  if (m.winner === 'TIE') return 'TIE';
  return null;
}

export async function getScoreboardTool(args: { leagueId: string; week?: number }) {
  const ctx = await getLeagueContext(args.leagueId);
  const week = resolveWeek(ctx, args.week);
  const { scoringPeriodId, matchups } = await getWeekMatchups(args.leagueId, ctx, week);

  const side = (s: any) =>
    s && {
      teamId: s.teamId,
      team: teamName(ctx, s.teamId),
      score: round(sideScore(s)),
      projected: round(s.totalProjectedPointsLive ?? starterTotals(s, scoringPeriodId))
    };

  return {
    week,
    currentWeek: ctx.currentMatchupPeriod,
    matchups: matchups.map((m: any) => ({
      matchupId: m.id,
      home: side(m.home),
      away: side(m.away) || 'BYE',
      winner: winnerName(ctx, m),
      status: matchupStatus(ctx, week, m),
      playoff: !isRegularSeason(m),
      ...(isRegularSeason(m) ? {} : { bracket: m.playoffTierType })
    }))
  };
}

export async function getBoxScoreTool(args: { leagueId: string; teamId: string; week?: number }) {
  const ctx = await getLeagueContext(args.leagueId);
  const teamId = parseTeamId(args.teamId);
  getTeamOrThrow(ctx, teamId);
  const week = resolveWeek(ctx, args.week);
  const [{ scoringPeriodId, matchups }, pro] = await Promise.all([
    getWeekMatchups(args.leagueId, ctx, week),
    getProGameIndex()
  ]);
  const matchup = matchups.find((m: any) => m.home?.teamId === teamId || m.away?.teamId === teamId);
  if (!matchup) {
    throw new Error(`${teamName(ctx, teamId)} has no matchup in week ${week} (bye or eliminated)`);
  }

  const describeSide = (s: any) => {
    if (!s) return 'BYE';
    const players = (s.rosterForCurrentScoringPeriod?.entries || [])
      .map((entry: any) => {
        const p = entry.playerPoolEntry?.player || {};
        const actual = statFor(p, STAT_SOURCE_ACTUAL, scoringPeriodId);
        const projected = statFor(p, STAT_SOURCE_PROJECTED, scoringPeriodId);
        return {
          slotId: entry.lineupSlotId,
          slot: LINEUP_SLOTS[entry.lineupSlotId] || `Slot ${entry.lineupSlotId}`,
          name: p.fullName || `Player ${entry.playerId}`,
          pos: POSITIONS[p.defaultPositionId],
          nflTeam: pro.abbrevs.get(p.proTeamId) || 'FA',
          opponent: opponentFor(pro.games, scoringPeriodId, p.proTeamId),
          actual: round(actual),
          projected: round(projected),
          injury: injuryLabel(p)
        };
      })
      .sort((a: any, b: any) => SLOT_ORDER.indexOf(a.slotId) - SLOT_ORDER.indexOf(b.slotId));
    const strip = ({ slotId, ...rest }: any) => rest;
    const starters = players.filter((p: any) => p.slotId !== BENCH_SLOT && p.slotId !== IR_SLOT);
    const bench = players.filter((p: any) => p.slotId === BENCH_SLOT);
    const ir = players.filter((p: any) => p.slotId === IR_SLOT);
    return {
      teamId: s.teamId,
      team: teamName(ctx, s.teamId),
      score: round(sideScore(s)),
      projected: round(s.totalProjectedPointsLive ?? starterTotals(s, scoringPeriodId)),
      benchPoints: round(bench.reduce((sum: number, p: any) => sum + (p.actual || 0), 0)),
      starters: starters.map(strip),
      bench: bench.map(strip),
      ...(ir.length ? { ir: ir.map(strip) } : {})
    };
  };

  const mineIsHome = matchup.home?.teamId === teamId;
  return {
    week,
    status: matchupStatus(ctx, week, matchup),
    winner: winnerName(ctx, matchup),
    ...(isRegularSeason(matchup) ? {} : { bracket: matchup.playoffTierType }),
    team: describeSide(mineIsHome ? matchup.home : matchup.away),
    opponent: describeSide(mineIsHome ? matchup.away : matchup.home)
  };
}

// ---------------------------------------------------------------------------
// 5. get_team_schedule
// ---------------------------------------------------------------------------

function remainingOpponents(ctx: LeagueContext, teamId: number): number[] {
  return ctx.schedule
    .filter((m) => isRegularSeason(m) && !isDecided(m) && (m.home?.teamId === teamId || m.away?.teamId === teamId))
    .map((m) => (m.home.teamId === teamId ? m.away?.teamId : m.home.teamId))
    .filter((id): id is number => typeof id === 'number');
}

export async function getTeamScheduleTool(args: { leagueId: string; teamId: string }) {
  const ctx = await getLeagueContext(args.leagueId);
  const teamId = parseTeamId(args.teamId);
  const team = getTeamOrThrow(ctx, teamId);
  const pfRanks = pointsForRanks(ctx);

  const games = ctx.schedule
    .filter((m) => m.home?.teamId === teamId || m.away?.teamId === teamId)
    .sort((a, b) => a.matchupPeriodId - b.matchupPeriodId)
    .map((m) => {
      const home = m.home.teamId === teamId;
      const mine = home ? m.home : m.away;
      const theirs = home ? m.away : m.home;
      const decided = isDecided(m);
      const score = sideScore(mine);
      const oppScore = theirs ? sideScore(theirs) : null;
      let result: string | null = null;
      if (decided) {
        result = m.winner === 'TIE' ? 'T' : (m.winner === 'HOME') === home ? 'W' : 'L';
      }
      const opp = theirs ? ctx.teams.get(theirs.teamId) : undefined;
      return {
        week: m.matchupPeriodId,
        opponent: opp ? opp.name : 'BYE',
        opponentId: opp?.id,
        homeAway: home ? 'home' : 'away',
        ...(decided || score > 0 ? { score: round(score), opponentScore: round(oppScore) } : {}),
        result,
        margin: decided && oppScore !== null ? round(score - oppScore) : null,
        ...(!decided && opp
          ? { opponentRecord: overall(opp).record, opponentPointsForRank: pfRanks.get(opp.id) }
          : {}),
        ...(isRegularSeason(m) ? {} : { bracket: m.playoffTierType })
      };
    });

  // Remaining strength of schedule for every team, so this team's can be ranked
  const sosByTeam = [...ctx.teams.values()].map((t) => {
    const opps = remainingOpponents(ctx, t.id).map((id) => ctx.teams.get(id)).filter(Boolean);
    const avgWinPct = opps.length ? opps.reduce((s, o) => s + overall(o).winPct, 0) / opps.length : 0;
    return { teamId: t.id, avgWinPct };
  });
  const sosRank = [...sosByTeam].sort((a, b) => b.avgWinPct - a.avgWinPct).findIndex((s) => s.teamId === teamId) + 1;

  const remaining = remainingOpponents(ctx, teamId).map((id) => ctx.teams.get(id)).filter(Boolean);
  const played = games.filter((g) => g.result);
  const r = overall(team);
  return {
    team: team.name,
    teamId,
    record: r.record,
    pointsFor: round(r.pointsFor),
    pointsForRank: pfRanks.get(teamId),
    games,
    strengthOfSchedule: {
      remainingGames: remaining.length,
      remainingOpponentsAvgWinPct: remaining.length
        ? round(remaining.reduce((s, o) => s + overall(o).winPct, 0) / remaining.length, 3)
        : null,
      remainingOpponentsAvgPointsForRank: remaining.length
        ? round(remaining.reduce((s, o) => s + (pfRanks.get(o.id) || 0), 0) / remaining.length, 1)
        : null,
      remainingDifficultyRank: remaining.length ? sosRank : null,
      remainingDifficultyNote: `1 = hardest remaining schedule of ${ctx.teams.size} (by opponents' win %)`,
      playedOpponentsAvgScore: played.length
        ? round(played.reduce((s, g) => s + (g.opponentScore || 0), 0) / played.length)
        : null
    }
  };
}

// ---------------------------------------------------------------------------
// 6. get_power_rankings
// ---------------------------------------------------------------------------

export async function getPowerRankingsTool(args: { leagueId: string; teamId?: string }) {
  const ctx = await getLeagueContext(args.leagueId);
  const myTeamId = args.teamId ? parseInt(args.teamId, 10) : undefined;
  const completed = ctx.schedule.filter((m) => isRegularSeason(m) && isDecided(m));
  if (!completed.length) {
    return { note: 'No completed regular-season weeks yet', rankings: [] };
  }

  // week -> [{teamId, score, result}]
  const byWeek = new Map<number, { teamId: number; score: number; result: number }[]>();
  for (const m of completed) {
    const list = byWeek.get(m.matchupPeriodId) || [];
    const homeResult = m.winner === 'TIE' ? 0.5 : m.winner === 'HOME' ? 1 : 0;
    list.push({ teamId: m.home.teamId, score: m.home.totalPoints || 0, result: homeResult });
    if (m.away) list.push({ teamId: m.away.teamId, score: m.away.totalPoints || 0, result: 1 - homeResult });
    byWeek.set(m.matchupPeriodId, list);
  }
  const weeks = [...byWeek.keys()].sort((a, b) => a - b);

  const stats = new Map<number, any>();
  for (const t of ctx.teams.values()) {
    stats.set(t.id, { apW: 0, apL: 0, apT: 0, expectedWins: 0, actualWins: 0, games: 0, points: 0, history: [] as any[] });
  }
  for (const week of weeks) {
    const entries = byWeek.get(week)!;
    for (const e of entries) {
      const s = stats.get(e.teamId);
      if (!s) continue;
      let w = 0, l = 0, t = 0;
      for (const other of entries) {
        if (other.teamId === e.teamId) continue;
        if (e.score > other.score) w++;
        else if (e.score < other.score) l++;
        else t++;
      }
      s.apW += w; s.apL += l; s.apT += t;
      const opponents = entries.length - 1;
      s.expectedWins += opponents ? (w + t / 2) / opponents : 0;
      s.actualWins += e.result;
      s.games += 1;
      s.points += e.score;
      s.history.push({ week, score: e.score, result: e.result });
    }
  }

  const pfRanks = pointsForRanks(ctx);
  const rows = [...stats.entries()].map(([teamId, s]) => {
    const apGames = s.apW + s.apL + s.apT;
    const allPlayPct = apGames ? (s.apW + s.apT / 2) / apGames : 0;
    const winPct = s.games ? s.actualWins / s.games : 0;
    const last3 = s.history.slice(-3);
    const recentAvg = last3.length ? last3.reduce((sum: number, h: any) => sum + h.score, 0) / last3.length : 0;
    const resultLetter = (r: number) => (r === 1 ? 'W' : r === 0 ? 'L' : 'T');
    return {
      teamId,
      team: teamName(ctx, teamId),
      record: overall(ctx.teams.get(teamId)).record,
      allPlayRecord: `${s.apW}-${s.apL}-${s.apT}`,
      allPlayWinPct: allPlayPct,
      actualWinPct: winPct,
      luckWins: s.actualWins - s.expectedWins,
      pointsPerGame: s.games ? s.points / s.games : 0,
      pointsForRank: pfRanks.get(teamId),
      last3: {
        results: last3.map((h: any) => resultLetter(h.result)).join(''),
        avgPoints: recentAvg
      }
    };
  });

  // Power score: 40% all-play win %, 30% points per game, 20% last-3 scoring,
  // 10% actual win %, each scaled against the league's best (0-100).
  const maxPpg = Math.max(...rows.map((r) => r.pointsPerGame)) || 1;
  const maxRecent = Math.max(...rows.map((r) => r.last3.avgPoints)) || 1;
  const rankings = rows
    .map((r) => ({
      ...r,
      powerScore:
        100 *
        (0.4 * r.allPlayWinPct + 0.3 * (r.pointsPerGame / maxPpg) + 0.2 * (r.last3.avgPoints / maxRecent) + 0.1 * r.actualWinPct)
    }))
    .sort((a, b) => b.powerScore - a.powerScore)
    .map((r, i) => ({
      rank: i + 1,
      teamId: r.teamId,
      team: r.team,
      powerScore: round(r.powerScore, 1),
      record: r.record,
      allPlayRecord: r.allPlayRecord,
      allPlayWinPct: round(r.allPlayWinPct, 3),
      actualWinPct: round(r.actualWinPct, 3),
      luckWins: round(r.luckWins, 1),
      pointsPerGame: round(r.pointsPerGame),
      pointsForRank: r.pointsForRank,
      last3: { results: r.last3.results, avgPoints: round(r.last3.avgPoints) },
      ...(myTeamId === r.teamId ? { isYou: true } : {})
    }));

  return {
    weeksCounted: weeks,
    formula: 'powerScore = 100 x (0.4 all-play win% + 0.3 PPG/best PPG + 0.2 last-3 avg/best last-3 avg + 0.1 actual win%)',
    luckNote: 'luckWins = actual wins minus expected wins from all-play; positive = lucky, negative = unlucky',
    rankings
  };
}

// ---------------------------------------------------------------------------
// 7. get_playoff_picture
// ---------------------------------------------------------------------------

export async function getPlayoffPictureTool(args: { leagueId: string; teamId?: string }) {
  const ctx = await getLeagueContext(args.leagueId);
  const myTeamId = args.teamId ? parseInt(args.teamId, 10) : undefined;
  const seeded = sortedBySeed(ctx);
  const n = ctx.playoffTeams;
  const cutoff = seeded[n - 1];
  const firstOut = seeded[n];
  const cut = overall(cutoff);
  const out = firstOut ? overall(firstOut) : undefined;

  const info = seeded.map((t) => {
    const r = overall(t);
    const remaining = remainingOpponents(ctx, t.id);
    return { team: t, r, remaining, maxWins: r.winsEquivalent + remaining.length };
  });

  const teams = info.map(({ team, r, remaining, maxWins }, i) => {
    const seed = i + 1;
    const inPosition = seed <= n;
    const others = info.filter((o) => o.team.id !== team.id);
    // Wins ties are broken by points scored, so only strictly-better counts
    // are safe for clinching/elimination.
    const clinched = others.filter((o) => o.maxWins >= r.winsEquivalent).length <= n - 1;
    const eliminated = others.filter((o) => o.r.winsEquivalent > maxWins).length >= n;
    const gamesBack = ((cut.wins - r.wins) + (r.losses - cut.losses)) / 2;
    const gamesAhead = out ? ((r.wins - out.wins) + (out.losses - r.losses)) / 2 : null;
    let status: string;
    if (clinched) status = 'clinched';
    else if (eliminated) status = 'eliminated';
    else if (inPosition) status = gamesAhead !== null && gamesAhead <= 1 ? 'in (bubble)' : 'in';
    else status = gamesBack <= 1 ? 'out (bubble)' : 'chasing';

    const compareTo = inPosition ? out : cut;
    const playoffPct = team.currentSimulationResults?.playoffPct;
    return {
      seed,
      teamId: team.id,
      team: team.name,
      record: r.record,
      pointsFor: round(r.pointsFor),
      status,
      ...(inPosition
        ? { gamesAheadOf7th: gamesAhead }
        : { gamesBackOf6th: gamesBack }),
      ...(compareTo && compareTo.winsEquivalent === r.winsEquivalent && team.id !== (inPosition ? firstOut?.id : cutoff.id)
        ? { tiedOnWinsWith: inPosition ? firstOut.name : cutoff.name, pointsForEdge: round(r.pointsFor - compareTo.pointsFor) }
        : {}),
      maxPossibleWins: maxWins,
      espnPlayoffOddsPct: playoffPct === undefined ? null : round(playoffPct * 100, 1),
      remainingSchedule: remaining.map((id) => `${teamAbbrev(ctx, id)} (${overall(ctx.teams.get(id)).record})`),
      ...(myTeamId === team.id ? { isYou: true } : {})
    };
  });

  return {
    currentWeek: ctx.currentMatchupPeriod,
    regularSeasonWeeks: ctx.regularSeasonWeeks,
    playoffTeams: n,
    tiebreaker: ctx.raw.settings?.scheduleSettings?.playoffSeedingRule || null,
    cutLine: `${n}th seed: ${cutoff.name} at ${cut.record}, ${round(cut.pointsFor)} PF` +
      (firstOut ? `; first out: ${firstOut.name} at ${out!.record}, ${round(out!.pointsFor)} PF` : ''),
    teams
  };
}

// ---------------------------------------------------------------------------
// 8. get_recent_activity
// ---------------------------------------------------------------------------

export async function getRecentActivityTool(args: { leagueId: string; limit?: number }) {
  requireLeague(args.leagueId);
  const limit = Math.min(Math.max(parseInt(String(args.limit ?? 25), 10) || 25, 1), 100);
  const [ctx, data] = await Promise.all([
    getLeagueContext(args.leagueId),
    espnApi.getLeagueData(args.leagueId, ['kona_league_communication'], {
      subPath: '/communication/',
      filter: {
        topics: {
          filterType: { value: ['ACTIVITY_TRANSACTIONS'] },
          limit,
          sortMessageDate: { sortPriority: 1, sortAsc: false },
          filterIncludeMessageTypeIds: { value: Object.keys(ACTIVITY_MESSAGE_TYPES).map(Number) }
        }
      }
    })
  ]);
  const topics = data.topics || [];
  const playerIds = topics.flatMap((t: any) => (t.messages || []).map((m: any) => m.targetId));
  const [lookup, pro] = await Promise.all([getPlayerLookup(args.leagueId, playerIds), getProGameIndex()]);
  const validTeam = (id: number) => ctx.teams.has(id);

  const activity = topics.map((topic: any) => {
    const moves = (topic.messages || [])
      .filter((m: any) => ACTIVITY_MESSAGE_TYPES[m.messageTypeId])
      .map((m: any) => {
        const action = ACTIVITY_MESSAGE_TYPES[m.messageTypeId];
        // ESPN puts the team in a different field depending on message type
        const teamId = m.messageTypeId === 239 ? m.for : m.messageTypeId === 244 ? m.from : m.to;
        return {
          action,
          ...describePlayer(lookup, pro.abbrevs, m.targetId),
          ...(action === 'TRADE'
            ? {
                fromTeam: validTeam(m.from) ? teamName(ctx, m.from) : undefined,
                toTeam: validTeam(m.to) ? teamName(ctx, m.to) : undefined
              }
            : { team: validTeam(teamId) ? teamName(ctx, teamId) : undefined })
        };
      });
    return { date: isoDate(topic.date), moves };
  });
  return { count: activity.length, activity };
}

// ---------------------------------------------------------------------------
// 9. get_transactions
// ---------------------------------------------------------------------------

export async function getTransactionsTool(args: { leagueId: string; week?: number }) {
  const ctx = await getLeagueContext(args.leagueId);
  const week = resolveWeek(ctx, args.week);
  const data = await espnApi.getLeagueData(args.leagueId, ['mTransactions2'], {
    scoringPeriodId: week,
    filter: { transactions: { filterType: { value: ['FREEAGENT', 'WAIVER', 'WAIVER_ERROR', 'TRADE_ACCEPT'] } } }
  });
  // Pending/canceled claims are private to the team that made them (and ESPN
  // only returns the cookie owner's), so never expose them to league mates.
  // (isPending stays true on executed trades, so go by status alone.)
  const transactions = (data.transactions || []).filter(
    (t: any) => t.status !== 'PENDING' && t.status !== 'CANCELED' && t.scoringPeriodId === week
  );
  const playerIds = transactions.flatMap((t: any) => (t.items || []).map((i: any) => i.playerId));
  const [lookup, pro] = await Promise.all([getPlayerLookup(args.leagueId, playerIds), getProGameIndex()]);
  const nameOf = (id: number) => describePlayer(lookup, pro.abbrevs, id).player;

  const byDateDesc = (a: any, b: any) => (b.processDate || b.proposedDate || 0) - (a.processDate || a.proposedDate || 0);
  const addDrop = (t: any) => {
    const add = (t.items || []).filter((i: any) => i.type === 'ADD').map((i: any) => nameOf(i.playerId));
    const drop = (t.items || []).filter((i: any) => i.type === 'DROP').map((i: any) => nameOf(i.playerId));
    return { ...(add.length ? { add: add.join(', ') } : {}), ...(drop.length ? { drop: drop.join(', ') } : {}) };
  };

  const waiverClaims = transactions
    .filter((t: any) => t.type === 'WAIVER' || t.type === 'WAIVER_ERROR')
    .sort((a: any, b: any) => byDateDesc(a, b) || (b.bidAmount || 0) - (a.bidAmount || 0))
    .map((t: any) => ({
      date: isoDate(t.processDate || t.proposedDate),
      team: teamName(ctx, t.teamId),
      result: t.status === 'EXECUTED' ? 'won' : `failed (${String(t.status).replace(/^FAILED_/, '').toLowerCase()})`,
      bid: t.bidAmount ?? 0,
      ...addDrop(t)
    }));

  const freeAgentMoves = transactions
    .filter((t: any) => t.type === 'FREEAGENT' && t.status === 'EXECUTED')
    .sort(byDateDesc)
    .map((t: any) => ({ date: isoDate(t.processDate || t.proposedDate), team: teamName(ctx, t.teamId), ...addDrop(t) }));

  const trades = transactions
    .filter((t: any) => String(t.type).startsWith('TRADE') && t.status === 'EXECUTED')
    .sort(byDateDesc)
    .map((t: any) => ({
      date: isoDate(t.processDate || t.proposedDate),
      moves: (t.items || [])
        .filter((i: any) => i.type === 'TRADE')
        .map((i: any) => ({ player: nameOf(i.playerId), from: teamName(ctx, i.fromTeamId), to: teamName(ctx, i.toTeamId) }))
    }));

  return {
    week,
    faabSpentThisWeek: waiverClaims.filter((c: any) => c.result === 'won').reduce((s: number, c: any) => s + c.bid, 0),
    waiverClaims,
    freeAgentMoves,
    trades
  };
}

// ---------------------------------------------------------------------------
// 10. get_player_card
// ---------------------------------------------------------------------------

export async function getPlayerCardTool(args: { leagueId: string; playerName: string }) {
  const { leagueId, playerName } = args;
  if (!leagueId || !playerName) throw new Error('League ID and Player Name are required');
  const season = espnApi.getSeasonYear();

  const search = await espnApi.getLeagueData(leagueId, ['kona_player_info'], {
    filter: {
      players: {
        filterName: { value: playerName },
        limit: 5,
        sortDraftRanks: { sortPriority: 100, sortAsc: true, value: 'PPR' },
        filterStatsForTopScoringPeriodIds: { value: 1, additionalValue: [`00${season}`] }
      }
    }
  });
  const candidates = search.players || [];
  if (!candidates.length) throw new Error(`Player "${playerName}" not found`);
  const wanted = playerName.trim().toLowerCase();
  const match = candidates.find((p: any) => p.player?.fullName?.toLowerCase() === wanted) || candidates[0];

  const [ctx, detail, pro, news] = await Promise.all([
    getLeagueContext(leagueId),
    espnApi.getLeagueData(leagueId, ['kona_player_info'], {
      filter: {
        players: {
          filterIds: { value: [match.id] },
          filterStatsForSourceIds: { value: [STAT_SOURCE_ACTUAL, STAT_SOURCE_PROJECTED] },
          filterStatsForSplitTypeIds: { value: [0, 1] },
          filterStatsForScoringPeriodIds: { value: Array.from({ length: 18 }, (_, i) => i) }
        }
      }
    }),
    getProGameIndex(),
    espnApi.getPlayerNews(match.id, 5).catch(() => [])
  ]);
  const entry = (detail.players || [])[0] || match;
  const p = entry.player || {};
  const stats = (p.stats || []).filter((s: any) => s.seasonId === season);
  const pos = POSITIONS[p.defaultPositionId];
  const current = ctx.scoringPeriodId;

  const seasonActual = stats.find((s: any) => s.statSourceId === STAT_SOURCE_ACTUAL && s.statSplitTypeId === 0 && s.scoringPeriodId === 0);
  const seasonLine: { [k: string]: number } = {};
  for (const [id, value] of Object.entries<number>(seasonActual?.stats || {})) {
    if (STAT_NAMES[id] && value) seasonLine[STAT_NAMES[id]] = round(value, 1)!;
  }

  const weekly = (week: number) => ({
    actual: statFor(p, STAT_SOURCE_ACTUAL, week, season),
    projected: statFor(p, STAT_SOURCE_PROJECTED, week, season)
  });
  const playedWeeks = Array.from({ length: ctx.finalScoringPeriod }, (_, i) => i + 1).filter(
    (w) => w < current || (w === current && weekly(w).actual !== null)
  );
  const recentWeeks = playedWeeks.slice(-5).map((w) => {
    const { actual, projected } = weekly(w);
    return {
      week: w,
      opponent: opponentFor(pro.games, w, p.proTeamId),
      actual: round(actual),
      projected: round(projected),
      diff: actual !== null && projected !== null ? round(actual - projected) : null
    };
  });

  const futureWeeks = Array.from({ length: ctx.finalScoringPeriod - current + 1 }, (_, i) => current + i).filter(
    (w) => !playedWeeks.includes(w)
  );
  const rosProjected = futureWeeks.reduce((s, w) => s + (weekly(w).projected || 0), 0);
  const rosGames = futureWeeks.filter((w) => (weekly(w).projected || 0) > 0).length;
  const dvp = detail.positionAgainstOpponent?.positionalRatings?.[String(p.defaultPositionId)]?.ratingsByOpponent || {};
  const upcoming = futureWeeks.slice(0, 4).map((w) => {
    const game = pro.games.get(w)?.get(p.proTeamId);
    return {
      week: w,
      opponent: game?.opponent || 'BYE',
      projected: round(weekly(w).projected),
      ...(game && dvp[game.opponentId] ? { opponentRankVsPos: dvp[game.opponentId].rank } : {})
    };
  });

  const outlooksByWeek = p.outlooks?.outlooksByWeek || {};
  const latestOutlookWeek = Object.keys(outlooksByWeek).map(Number).sort((a, b) => b - a)[0];
  const gamesPlayed = playedWeeks.filter((w) => weekly(w).actual !== null).length;

  return {
    player: {
      id: p.id,
      name: p.fullName,
      pos,
      nflTeam: pro.abbrevs.get(p.proTeamId) || 'FA',
      byeWeek: pro.byes.get(p.proTeamId) || null,
      injury: injuryLabel(p) || 'ACTIVE'
    },
    leagueStatus: entry.onTeamId
      ? { rosteredBy: teamName(ctx, entry.onTeamId), teamId: entry.onTeamId }
      : { rosteredBy: null, availability: entry.status === 'WAIVERS' ? 'waivers' : 'free agent' },
    ownership: {
      percentOwned: round(p.ownership?.percentOwned, 1),
      weeklyChange: round(p.ownership?.percentChange, 2),
      percentStarted: round(p.ownership?.percentStarted, 1)
    },
    season: {
      fantasyPoints: round(seasonActual?.appliedTotal),
      gamesPlayed,
      pointsPerGame: gamesPlayed ? round((seasonActual?.appliedTotal || 0) / gamesPlayed) : null,
      positionRank: entry.ratings?.['0']?.positionalRanking ?? null,
      stats: seasonLine
    },
    recentWeeks,
    restOfSeason: {
      weeks: futureWeeks.length ? `${futureWeeks[0]}-${futureWeeks[futureWeeks.length - 1]}` : null,
      games: rosGames,
      projectedPoints: round(rosProjected, 1),
      projectedPerGame: rosGames ? round(rosProjected / rosGames) : null
    },
    upcoming,
    opponentRankNote: 'opponentRankVsPos: 1 = defense allows the fewest points to this position (toughest), 32 = most (easiest)',
    outlook: latestOutlookWeek ? { week: latestOutlookWeek, text: outlooksByWeek[latestOutlookWeek] } : p.seasonOutlook || null,
    news: news.slice(0, 3).map((a: any) => ({
      date: a.published,
      headline: a.headline,
      // Player blurbs repeat the headline as the description
      ...(a.description && a.description !== a.headline ? { summary: a.description } : {})
    })),
    ...(candidates.length > 1
      ? { otherMatches: candidates.filter((c: any) => c.id !== match.id).map((c: any) => c.player?.fullName) }
      : {})
  };
}

// ---------------------------------------------------------------------------
// 11. get_defense_vs_position
// ---------------------------------------------------------------------------

export async function getDefenseVsPositionTool(args: { leagueId: string; position?: string }) {
  requireLeague(args.leagueId);
  const wanted = args.position ? args.position.toUpperCase() : undefined;
  if (wanted && !POSITION_IDS[wanted]) throw new Error(`Unknown position "${args.position}". Use QB, RB, WR, TE, K or D/ST`);
  const positions = wanted ? [wanted === 'DST' ? 'D/ST' : wanted] : ['QB', 'RB', 'WR', 'TE', 'K'];

  const [data, pro] = await Promise.all([
    espnApi.getLeagueData(args.leagueId, ['kona_player_info'], {
      filter: { players: { limit: 1, sortDraftRanks: { sortPriority: 100, sortAsc: true, value: 'PPR' } } }
    }),
    getProGameIndex()
  ]);
  const ratings = data.positionAgainstOpponent?.positionalRatings || {};
  const result: { [pos: string]: any[] } = {};
  for (const pos of positions) {
    const byOpponent = ratings[String(POSITION_IDS[pos])]?.ratingsByOpponent || {};
    result[pos] = Object.entries<any>(byOpponent)
      .map(([proTeamId, r]) => ({ rank: r.rank, defense: pro.abbrevs.get(Number(proTeamId)) || proTeamId, avgPointsAllowed: round(r.average) }))
      .sort((a, b) => a.rank - b.rank);
  }
  return {
    note: 'Fantasy points per game allowed to each position, using this league\'s scoring. Rank 1 = fewest allowed (toughest matchup), 32 = most (easiest).',
    positions: result
  };
}

// ---------------------------------------------------------------------------
// 12. get_trending_players
// ---------------------------------------------------------------------------

export async function getTrendingPlayersTool(args: { leagueId: string; position?: string; limit?: number }) {
  requireLeague(args.leagueId);
  const limit = Math.min(Math.max(parseInt(String(args.limit ?? 10), 10) || 10, 1), 50);
  const wanted = args.position ? args.position.toUpperCase() : undefined;
  if (wanted && POSITION_SLOT_IDS[wanted] === undefined) {
    throw new Error(`Unknown position "${args.position}". Use QB, RB, WR, TE, K or D/ST`);
  }
  const season = espnApi.getSeasonYear();

  // ESPN ignores sortPercentChanged, so pull the players who matter (top
  // season scorers) and sort by ownership change here.
  const [ctx, data, pro] = await Promise.all([
    getLeagueContext(args.leagueId),
    espnApi.getLeagueData(args.leagueId, ['kona_player_info'], {
      filter: {
        players: {
          ...(wanted ? { filterSlotIds: { value: [POSITION_SLOT_IDS[wanted]] } } : {}),
          limit: wanted ? 200 : 500,
          sortAppliedStatTotal: { sortPriority: 1, sortAsc: false, value: `00${season}` },
          filterStatsForTopScoringPeriodIds: { value: 1, additionalValue: [`00${season}`] }
        }
      }
    }),
    getProGameIndex()
  ]);

  const players = (data.players || []).map((entry: any) => {
    const p = entry.player || {};
    const seasonTotal = (p.stats || []).find((s: any) => s.id === `00${season}`);
    return {
      name: p.fullName,
      pos: POSITIONS[p.defaultPositionId],
      nflTeam: pro.abbrevs.get(p.proTeamId) || 'FA',
      percentOwned: round(p.ownership?.percentOwned, 1),
      weeklyChange: round(p.ownership?.percentChange, 2) ?? 0,
      seasonPoints: round(seasonTotal?.appliedTotal, 1),
      injury: injuryLabel(p),
      inYourLeague: entry.onTeamId ? teamName(ctx, entry.onTeamId) : entry.status === 'WAIVERS' ? 'waivers' : 'free agent',
      available: !entry.onTeamId
    };
  });
  const sorted = [...players].sort((a, b) => (b.weeklyChange as number) - (a.weeklyChange as number));
  return {
    position: wanted || 'ALL',
    note: 'weeklyChange = ESPN-wide change in % rostered this week; available = not on a roster in this league',
    risers: sorted.filter((p) => (p.weeklyChange as number) > 0).slice(0, limit),
    fallers: sorted.filter((p) => (p.weeklyChange as number) < 0).reverse().slice(0, limit)
  };
}

// ---------------------------------------------------------------------------
// 13. get_clinch_scenarios
// ---------------------------------------------------------------------------

// Small seeded PRNG so the same week gives the same simulated odds
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// Can every team in `needs` (teamId -> wins still required) get there at once,
// given the remaining games among teams other than the one being checked?
// Each game is one win for either side, so this is bipartite matching between
// games and "win slots" (team t gets needs[t] slots); feasible iff every slot fills.
function canAllReach(needs: Map<number, number>, games: [number, number][]): boolean {
  const slots: number[] = [];
  for (const [team, need] of needs) for (let i = 0; i < need; i++) slots.push(team);
  if (!slots.length) return true;
  const relevant = games.filter(([a, b]) => needs.has(a) || needs.has(b));
  if (relevant.length < slots.length) return false;
  const gameOwner = new Array<number>(relevant.length).fill(-1); // game -> slot index

  // Kuhn's augmenting path
  const tryFill = (slot: number, visited: boolean[]): boolean => {
    const team = slots[slot];
    for (let g = 0; g < relevant.length; g++) {
      if (visited[g] || (relevant[g][0] !== team && relevant[g][1] !== team)) continue;
      visited[g] = true;
      if (gameOwner[g] === -1 || tryFill(gameOwner[g], visited)) {
        gameOwner[g] = slot;
        return true;
      }
    }
    return false;
  };

  for (let slot = 0; slot < slots.length; slot++) {
    if (!tryFill(slot, new Array(relevant.length).fill(false))) return false;
  }
  return true;
}

function combinations<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, acc: T[]) => {
    if (acc.length === size) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i <= items.length - (size - acc.length); i++) pick(i + 1, [...acc, items[i]]);
  };
  pick(0, []);
  return out;
}

export async function getClinchScenariosTool(args: { leagueId: string; teamId?: string }) {
  const ctx = await getLeagueContext(args.leagueId);
  const myTeamId = args.teamId ? parseInt(args.teamId, 10) : undefined;
  const n = ctx.playoffTeams;
  const teamIds = [...ctx.teams.keys()];
  const current = new Map(teamIds.map((id) => [id, overall(ctx.teams.get(id))]));

  const remainingGames: [number, number][] = ctx.schedule
    .filter((m) => isRegularSeason(m) && !isDecided(m) && m.home && m.away)
    .map((m) => [m.home.teamId, m.away.teamId]);
  const remainingCount = new Map(teamIds.map((id) => [id, 0]));
  for (const [a, b] of remainingGames) {
    remainingCount.set(a, remainingCount.get(a)! + 1);
    remainingCount.set(b, remainingCount.get(b)! + 1);
  }

  // --- Worst-case lock: smallest final win total that guarantees a top-n
  // finish no matter how every other game goes. Ties in wins count against
  // you (the points tiebreak is still unknown).
  const lockWins = new Map<number, number | null>();
  for (const x of teamIds) {
    const base = current.get(x)!.winsEquivalent;
    const xGames = remainingGames.map((g, i) => ({ g, i })).filter(({ g }) => g[0] === x || g[1] === x);
    const otherGames = remainingGames.filter(([a, b]) => a !== x && b !== x);
    let lock: number | null = null;
    for (let k = 0; k <= xGames.length && lock === null; k++) {
      const finalWins = base + k;
      let threatened = false;
      // Every way X could win exactly k of its games
      for (const wonIdx of combinations(xGames.map((_, i) => i), k)) {
        const credit = new Map<number, number>();
        xGames.forEach(({ g }, i) => {
          if (wonIdx.includes(i)) return;
          const opp = g[0] === x ? g[1] : g[0];
          credit.set(opp, (credit.get(opp) || 0) + 1);
        });
        const needs = new Map<number, number>();
        for (const t of teamIds) {
          if (t === x) continue;
          const have = current.get(t)!.winsEquivalent + (credit.get(t) || 0);
          const need = Math.max(0, Math.ceil(finalWins - have - 1e-9));
          const possible = otherGames.filter((g) => g.includes(t)).length;
          if (need <= possible) needs.set(t, need);
        }
        if (needs.size < n) continue;
        // Cheapest threats first makes a feasible set likely to be found early
        const candidates = [...needs.keys()].sort((a, b) => needs.get(a)! - needs.get(b)!);
        for (const group of combinations(candidates, n)) {
          if (canAllReach(new Map(group.map((t) => [t, needs.get(t)!])), otherGames)) {
            threatened = true;
            break;
          }
        }
        if (threatened) break;
      }
      if (!threatened) lock = finalWins;
    }
    lockWins.set(x, lock);
  }

  // --- Monte Carlo: each team's weekly score ~ Normal(mean, sd), with the
  // mean regressed 30% toward the league average.
  const completed = ctx.schedule.filter((m) => isRegularSeason(m) && isDecided(m));
  const scores = new Map<number, number[]>(teamIds.map((id) => [id, []]));
  for (const m of completed) {
    scores.get(m.home.teamId)?.push(m.home.totalPoints || 0);
    if (m.away) scores.get(m.away.teamId)?.push(m.away.totalPoints || 0);
  }
  const all = [...scores.values()].flat();
  const leagueMean = all.length ? all.reduce((s, v) => s + v, 0) / all.length : 110;
  let ss = 0;
  let df = 0;
  for (const list of scores.values()) {
    if (list.length < 2) continue;
    const mean = list.reduce((s, v) => s + v, 0) / list.length;
    ss += list.reduce((s, v) => s + (v - mean) ** 2, 0);
    df += list.length - 1;
  }
  const sd = Math.max(df ? Math.sqrt(ss / df) : 20, 12);
  const teamMean = new Map(
    teamIds.map((id) => {
      const list = scores.get(id)!;
      const ppg = list.length ? list.reduce((s, v) => s + v, 0) / list.length : leagueMean;
      return [id, 0.7 * ppg + 0.3 * leagueMean];
    })
  );

  const SIMS = 20000;
  const rand = mulberry32(ctx.currentMatchupPeriod * 7919 + (parseInt(args.leagueId, 10) % 100000));
  const made = new Map(teamIds.map((id) => [id, 0]));
  const top2 = new Map(teamIds.map((id) => [id, 0]));
  const byWins = new Map(teamIds.map((id) => [id, new Map<number, { total: number; made: number }>()]));
  const cutoffWins = new Map<number, number>();
  for (let s = 0; s < SIMS; s++) {
    const wins = new Map(teamIds.map((id) => [id, current.get(id)!.winsEquivalent]));
    const pf = new Map(teamIds.map((id) => [id, current.get(id)!.pointsFor]));
    for (const [a, b] of remainingGames) {
      const sa = teamMean.get(a)! + sd * gaussian(rand);
      const sb = teamMean.get(b)! + sd * gaussian(rand);
      wins.set(sa >= sb ? a : b, wins.get(sa >= sb ? a : b)! + 1);
      pf.set(a, pf.get(a)! + sa);
      pf.set(b, pf.get(b)! + sb);
    }
    const order = [...teamIds].sort((p, q) => wins.get(q)! - wins.get(p)! || pf.get(q)! - pf.get(p)!);
    order.forEach((id, i) => {
      const w = wins.get(id)!;
      const bucket = byWins.get(id)!.get(w) || { total: 0, made: 0 };
      bucket.total++;
      if (i < n) {
        bucket.made++;
        made.set(id, made.get(id)! + 1);
      }
      if (i < 2) top2.set(id, top2.get(id)! + 1);
      byWins.get(id)!.set(w, bucket);
    });
    const cut = wins.get(order[n - 1])!;
    cutoffWins.set(cut, (cutoffWins.get(cut) || 0) + 1);
  }

  const pct = (count: number, of: number) => round((100 * count) / of, 1);
  const recordFor = (id: number, finalWins: number) => {
    const games = current.get(id)!.games + remainingCount.get(id)!;
    return `${finalWins}-${games - finalWins}`;
  };

  const teams = teamIds
    .map((id) => {
      const r = current.get(id)!;
      const lock = lockWins.get(id) ?? null;
      const playoffPct = ctx.teams.get(id).currentSimulationResults?.playoffPct;
      return {
        teamId: id,
        team: teamName(ctx, id),
        record: r.record,
        pointsFor: round(r.pointsFor),
        gamesLeft: remainingCount.get(id),
        simPlayoffPct: pct(made.get(id)!, SIMS),
        simTop2Pct: pct(top2.get(id)!, SIMS),
        espnPlayoffOddsPct: playoffPct === undefined ? null : round(playoffPct * 100, 1),
        guaranteedLock:
          lock === null
            ? { finalRecord: null, note: 'Not guaranteed even by winning out (needs help or the points tiebreak)' }
            : lock <= r.winsEquivalent
              ? { finalRecord: recordFor(id, lock), note: 'Already clinched' }
              : { finalRecord: recordFor(id, lock), moreWinsNeeded: lock - r.winsEquivalent, ofGamesLeft: remainingCount.get(id) },
        chanceByFinalRecord: [...byWins.get(id)!.entries()]
          .sort((a, b) => b[0] - a[0])
          .filter(([, v]) => v.total / SIMS >= 0.002)
          .map(([w, v]) => ({ finalRecord: recordFor(id, w), playoffPct: pct(v.made, v.total), howLikelyPct: pct(v.total, SIMS) })),
        ...(myTeamId === id ? { isYou: true } : {})
      };
    })
    .sort((a, b) => (b.simPlayoffPct || 0) - (a.simPlayoffPct || 0));

  const cutTotal = [...cutoffWins.values()].reduce((s, v) => s + v, 0);
  return {
    currentWeek: ctx.currentMatchupPeriod,
    regularSeasonWeeks: ctx.regularSeasonWeeks,
    playoffTeams: n,
    tiebreaker: ctx.raw.settings?.scheduleSettings?.playoffSeedingRule || null,
    lastPlayoffSeedWins: [...cutoffWins.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([w, c]) => ({ wins: w, pct: pct(c, cutTotal) }))
      .filter((r) => (r.pct || 0) >= 0.5),
    method: {
      guaranteedLock: 'Exact worst case over every remaining result; ties in wins are assumed to go against the team on points.',
      simulation: `${SIMS} season simulations; weekly score ~ Normal(70% team PPG + 30% league PPG, sd ${round(sd, 1)}); seeds by wins then total points.`,
      simTop2Pct: 'Chance of a top-2 seed (the first-round byes in a 6-team bracket)'
    },
    teams
  };
}
