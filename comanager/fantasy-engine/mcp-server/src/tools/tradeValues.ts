import { espnApi } from '../services/espnApi.js';
import {
  POSITIONS,
  round,
  getLeagueContext,
  teamName,
  getProGameIndex,
  injuryLabel,
  LeagueContext,
} from './league.js';

// Trade value chart in the style of the weekly r/fantasyfootball charts
// (PeakedInHighSkool, CBS, FantasyPros): one number per player on a
// top-heavy scale, built for this league instead of a generic format.
//
// - Value = rest-of-season projected points above replacement level at the
//   position (replacement = the last league-wide starter, counting flex
//   slots), in this league's scoring, scaled so the best player is 100.
// - Players at or below replacement keep a small depth value (max 5), like
//   the charts' "anyone not listed is worth ~4" rule.
// - Buy/sell compares rest-of-season positional rank with season-to-date
//   rank: projected to do much better than so far = buy low, much worse =
//   sell high.
// - Trades are judged two ways: chart totals (with the charts' discount for
//   the side receiving extra players) and the change in each team's best
//   possible starting lineup, week by week, for the rest of the season.

const TRADE_VALUE_TTL_MS = 10 * 60 * 1000; // ~7 MB pull; values move slowly
const POOL_SIZE = 350;
const DEPTH_VALUE_MAX = 5;
const EXTRA_PLAYER_DISCOUNT = 0.05; // per extra player received (CBS uses 10% for 2+)

// Starting slot name -> positions that can fill it
const SLOT_ELIGIBILITY: { [slotId: number]: string[] } = {
  0: ['QB'], 2: ['RB'], 3: ['RB', 'WR'], 4: ['WR'], 5: ['WR', 'TE'], 6: ['TE'],
  7: ['QB', 'RB', 'WR', 'TE'], 16: ['D/ST'], 17: ['K'], 23: ['RB', 'WR', 'TE'],
};

interface ValuedPlayer {
  id: number;
  name: string;
  position: string;
  nflTeam: string;
  onTeamId: number;
  injury?: string;
  weekly: Map<number, number>; // remaining week -> projected points
  rosPoints: number;
  rosGames: number;
  playoffPoints: number; // fantasy playoff weeks
  seasonPoints: number;
  seasonPPG: number | null;
  gamesPlayed: number;
  ownershipChange: number;
  vbd: number;
  value: number;
  rosRank?: number; // positional, by rest-of-season PPG
  seasonRank?: number; // positional, by season-to-date PPG
}

interface ValueModel {
  ctx: LeagueContext;
  weeks: number[];
  playoffWeeks: number[];
  players: Map<number, ValuedPlayer>;
  baselines: { [pos: string]: number };
  rosters: Map<number, number[]>; // teamId -> player ids
  slots: { slotId: number; count: number }[];
}

function statsFilter(weeks: number[]) {
  return {
    filterStatsForSourceIds: { value: [0, 1] },
    filterStatsForSplitTypeIds: { value: [0, 1] },
    filterStatsForScoringPeriodIds: { value: [0, ...weeks] },
  };
}

function toValuedPlayer(entry: any, weeks: number[], playoffWeeks: number[], abbrevs: Map<number, string>): ValuedPlayer {
  const p = entry.player || {};
  const season = espnApi.getSeasonYear();
  const stats = (p.stats || []).filter((s: any) => s.seasonId === season);
  const weekly = new Map<number, number>();
  for (const s of stats) {
    if (s.statSourceId === 1 && s.statSplitTypeId === 1 && weeks.includes(s.scoringPeriodId)) {
      weekly.set(s.scoringPeriodId, s.appliedTotal || 0);
    }
  }
  const seasonTotal = stats.find((s: any) => s.statSourceId === 0 && s.statSplitTypeId === 0 && s.scoringPeriodId === 0);
  const seasonPoints = seasonTotal?.appliedTotal || 0;
  const seasonPPG = seasonTotal?.appliedAverage ?? null;
  const rosPoints = [...weekly.values()].reduce((a, b) => a + b, 0);
  return {
    id: p.id,
    name: p.fullName,
    position: POSITIONS[p.defaultPositionId] || '?',
    nflTeam: abbrevs.get(p.proTeamId) || 'FA',
    onTeamId: entry.onTeamId || 0,
    injury: injuryLabel(p),
    weekly,
    rosPoints,
    rosGames: [...weekly.values()].filter((v) => v > 0).length,
    playoffPoints: playoffWeeks.reduce((a, w) => a + (weekly.get(w) || 0), 0),
    seasonPoints,
    seasonPPG: seasonPPG !== null && seasonPPG !== undefined ? seasonPPG : null,
    gamesPlayed: seasonPPG ? Math.round(seasonPoints / seasonPPG) : 0,
    ownershipChange: p.ownership?.percentChange || 0,
    vbd: 0,
    value: 0,
  };
}

async function buildValueModel(leagueId: string): Promise<ValueModel> {
  const ctx = await getLeagueContext(leagueId);
  const season = espnApi.getSeasonYear();
  const first = ctx.scoringPeriodId;
  const weeks = Array.from({ length: Math.max(ctx.finalScoringPeriod - first + 1, 0) }, (_, i) => first + i);
  const playoffWeeks = weeks.filter((w) => w > ctx.regularSeasonWeeks);

  const [poolData, rosterData, pro] = await Promise.all([
    espnApi.getLeagueData(leagueId, ['kona_player_info'], {
      scoringPeriodId: first,
      ttlMs: TRADE_VALUE_TTL_MS,
      filter: {
        players: {
          limit: POOL_SIZE,
          sortAppliedStatTotal: { sortPriority: 1, sortAsc: false, value: `10${season}` },
          ...statsFilter(weeks),
        },
      },
    }),
    espnApi.getLeagueData(leagueId, ['mRoster'], { scoringPeriodId: first }),
    getProGameIndex(),
  ]);

  const players = new Map<number, ValuedPlayer>();
  for (const entry of poolData.players || []) {
    const vp = toValuedPlayer(entry, weeks, playoffWeeks, pro.abbrevs);
    players.set(vp.id, vp);
  }

  const rosters = new Map<number, number[]>();
  for (const team of rosterData.teams || []) {
    const ids = (team.roster?.entries || []).map((e: any) => e.playerId);
    rosters.set(team.id, ids);
    for (const id of ids) {
      const known = players.get(id);
      if (known) known.onTeamId = team.id;
    }
  }

  // Rostered players outside the pool (injured stashes, deep bench) still
  // matter for lineup math, so fetch just those.
  const missing = [...rosters.values()].flat().filter((id) => !players.has(id));
  if (missing.length) {
    const extra = await espnApi.getLeagueData(leagueId, ['kona_player_info'], {
      scoringPeriodId: first,
      ttlMs: TRADE_VALUE_TTL_MS,
      filter: { players: { filterIds: { value: missing }, ...statsFilter(weeks) } },
    });
    for (const entry of extra.players || []) {
      const vp = toValuedPlayer(entry, weeks, playoffWeeks, pro.abbrevs);
      for (const [teamId, ids] of rosters) if (ids.includes(vp.id)) vp.onTeamId = teamId;
      players.set(vp.id, vp);
    }
  }

  const slotCounts = ctx.raw.settings?.rosterSettings?.lineupSlotCounts || {};
  const slots = Object.entries<number>(slotCounts)
    .map(([id, count]) => ({ slotId: Number(id), count }))
    .filter((s) => s.count > 0 && SLOT_ELIGIBILITY[s.slotId]);

  const baselines = computeBaselines([...players.values()], slots, ctx.teams.size);
  const best = Math.max(...[...players.values()].map((p) => p.rosPoints - (baselines[p.position] ?? p.rosPoints)), 1);
  for (const p of players.values()) {
    const baseline = baselines[p.position];
    p.vbd = baseline === undefined ? 0 : p.rosPoints - baseline;
    const depth = baseline ? Math.min(DEPTH_VALUE_MAX, (DEPTH_VALUE_MAX * p.rosPoints) / baseline) : 0;
    p.value = Math.max(0, p.vbd > 0 ? Math.max((100 * p.vbd) / best, depth) : depth);
  }
  rankPositions([...players.values()]);
  return { ctx, weeks, playoffWeeks, players, baselines, rosters, slots };
}

// Replacement level per position: the rest-of-season total of the last
// player who'd start league-wide, with flex slots handed to whichever
// eligible position's next player projects best (the beer-sheet method).
function computeBaselines(players: ValuedPlayer[], slots: { slotId: number; count: number }[], teamCount: number) {
  const byPos: { [pos: string]: number[] } = {};
  for (const p of players) (byPos[p.position] ||= []).push(p.rosPoints);
  for (const list of Object.values(byPos)) list.sort((a, b) => b - a);

  const starters: { [pos: string]: number } = {};
  const flexSlots: string[][] = [];
  for (const { slotId, count } of slots) {
    const eligible = SLOT_ELIGIBILITY[slotId];
    if (eligible.length === 1) starters[eligible[0]] = (starters[eligible[0]] || 0) + count * teamCount;
    else for (let i = 0; i < count * teamCount; i++) flexSlots.push(eligible);
  }
  for (const eligible of flexSlots) {
    const next = eligible
      .filter((pos) => (starters[pos] || 0) < (byPos[pos]?.length || 0))
      .sort((a, b) => byPos[b][starters[b] || 0] - byPos[a][starters[a] || 0])[0];
    if (next) starters[next] = (starters[next] || 0) + 1;
  }
  const baselines: { [pos: string]: number } = {};
  for (const [pos, n] of Object.entries(starters)) {
    const list = byPos[pos] || [];
    if (n > 0 && list.length) baselines[pos] = list[Math.min(n, list.length) - 1];
  }
  return baselines;
}

function rankPositions(players: ValuedPlayer[]) {
  const byPos: { [pos: string]: ValuedPlayer[] } = {};
  for (const p of players) (byPos[p.position] ||= []).push(p);
  for (const list of Object.values(byPos)) {
    [...list]
      .sort((a, b) => b.rosPoints / Math.max(b.rosGames, 1) - a.rosPoints / Math.max(a.rosGames, 1))
      .forEach((p, i) => (p.rosRank = i + 1));
    [...list]
      .filter((p) => p.gamesPlayed >= 3 && p.seasonPPG !== null)
      .sort((a, b) => (b.seasonPPG || 0) - (a.seasonPPG || 0))
      .forEach((p, i) => (p.seasonRank = i + 1));
  }
}

function tierFor(value: number): string {
  if (value >= 80) return '1 - Elite';
  if (value >= 60) return '2 - Star';
  if (value >= 40) return '3 - Strong starter';
  if (value >= 20) return '4 - Starter';
  if (value >= 10) return '5 - Flex';
  if (value > DEPTH_VALUE_MAX) return '6 - Bench';
  return '7 - Depth';
}

function signalFor(p: ValuedPlayer): { signal: 'BUY' | 'SELL' | 'HOLD'; why?: string } {
  if (!p.seasonRank || !p.rosRank || p.rosGames < 2) return { signal: 'HOLD' };
  const gap = p.seasonRank - p.rosRank;
  const threshold = Math.max(6, Math.round(0.35 * Math.min(p.seasonRank, p.rosRank)));
  if (gap >= threshold) {
    return { signal: 'BUY', why: `${p.position}${p.seasonRank} so far, projected ${p.position}${p.rosRank} rest of season` };
  }
  if (-gap >= threshold) {
    return { signal: 'SELL', why: `${p.position}${p.seasonRank} so far, projected only ${p.position}${p.rosRank} rest of season` };
  }
  return { signal: 'HOLD' };
}

function chartRow(model: ValueModel, p: ValuedPlayer) {
  const { signal, why } = signalFor(p);
  return {
    name: p.name,
    position: p.position,
    nflTeam: p.nflTeam,
    value: round(p.value, 1),
    tier: tierFor(p.value),
    rosPoints: round(p.rosPoints, 1),
    rosPPG: p.rosGames ? round(p.rosPoints / p.rosGames, 1) : 0,
    playoffWeeksPoints: round(p.playoffPoints, 1),
    seasonPPG: p.seasonPPG !== null ? round(p.seasonPPG, 1) : null,
    signal,
    ...(why ? { signalReason: why } : {}),
    ...(p.injury ? { injury: p.injury } : {}),
    rosteredBy: p.onTeamId ? teamName(model.ctx, p.onTeamId) : 'free agent',
  };
}

// ---------------------------------------------------------------------------
// get_trade_values
// ---------------------------------------------------------------------------

export async function getTradeValuesTool(args: { leagueId: string; teamId?: string; position?: string; limit?: number }) {
  if (!args.leagueId) throw new Error('League ID is required');
  const model = await buildValueModel(args.leagueId);
  const limit = Math.min(Math.max(parseInt(String(args.limit ?? 60), 10) || 60, 1), 200);
  const pos = args.position ? args.position.toUpperCase().replace('DST', 'D/ST') : undefined;
  const myTeamId = args.teamId ? parseInt(args.teamId, 10) : undefined;

  const all = [...model.players.values()].sort((a, b) => b.value - a.value || b.rosPoints - a.rosPoints);
  const chart = all.filter((p) => !pos || p.position === pos).slice(0, limit);
  const signalled = all.filter((p) => p.value >= 10).map((p) => ({ p, s: signalFor(p) }));

  return {
    week: model.ctx.currentMatchupPeriod,
    weeksCounted: model.weeks.length ? `${model.weeks[0]}-${model.weeks[model.weeks.length - 1]}` : null,
    playoffWeeks: model.playoffWeeks,
    method:
      'value = rest-of-season projected points above replacement at the position (last league-wide starter, ' +
      'flex included) in this league\'s scoring, scaled so the top player = 100; at/below replacement = 0-5 depth value. ' +
      'BUY/SELL compares rest-of-season positional rank (per game) with season-to-date rank.',
    replacementLevel: Object.fromEntries(Object.entries(model.baselines).map(([k, v]) => [k, round(v, 1)])),
    chart: chart.map((p, i) => ({ rank: i + 1, ...chartRow(model, p), ...(myTeamId && p.onTeamId === myTeamId ? { yours: true } : {}) })),
    buyLow: signalled.filter((x) => x.s.signal === 'BUY').slice(0, 8).map((x) => `${x.p.name} (${x.p.position}, value ${round(x.p.value, 1)}) — ${x.s.why}; ${x.p.onTeamId ? teamName(model.ctx, x.p.onTeamId) : 'free agent'}`),
    sellHigh: signalled.filter((x) => x.s.signal === 'SELL').slice(0, 8).map((x) => `${x.p.name} (${x.p.position}, value ${round(x.p.value, 1)}) — ${x.s.why}; ${x.p.onTeamId ? teamName(model.ctx, x.p.onTeamId) : 'free agent'}`),
  };
}

// ---------------------------------------------------------------------------
// Trade evaluation
// ---------------------------------------------------------------------------

// Best lineup each remaining week: dedicated slots first, then flex slots
// from what's left (greedy is optimal when flex eligibility is a superset).
function lineupPoints(model: ValueModel, roster: ValuedPlayer[]): { total: number; byWeek: Map<number, number> } {
  const byWeek = new Map<number, number>();
  const ordered = [...model.slots].sort((a, b) => SLOT_ELIGIBILITY[a.slotId].length - SLOT_ELIGIBILITY[b.slotId].length);
  for (const week of model.weeks) {
    const pool = roster
      .map((p) => ({ p, pts: p.weekly.get(week) || 0 }))
      .sort((a, b) => b.pts - a.pts);
    const used = new Set<number>();
    let points = 0;
    for (const { slotId, count } of ordered) {
      for (let i = 0; i < count; i++) {
        const pick = pool.find((x) => !used.has(x.p.id) && SLOT_ELIGIBILITY[slotId].includes(x.p.position));
        if (pick) {
          used.add(pick.p.id);
          points += pick.pts;
        }
      }
    }
    byWeek.set(week, points);
  }
  return { total: [...byWeek.values()].reduce((a, b) => a + b, 0), byWeek };
}

async function resolvePlayers(model: ValueModel, leagueId: string, names: string[]) {
  const out: ValuedPlayer[] = [];
  for (const name of names) {
    const found = await espnApi.findPlayerByName(leagueId, name);
    if (!found) throw new Error(`Player "${name}" not found`);
    const vp = model.players.get(Number(found.id));
    if (!vp) throw new Error(`No rest-of-season projection for ${found.fullName}`);
    out.push(vp);
  }
  return out;
}

export async function evaluateTrade(args: { leagueId: string; teamId: string; giving: string[]; receiving: string[] }) {
  const { leagueId, teamId, giving, receiving } = args;
  if (!leagueId || !teamId || !giving?.length || !receiving?.length) {
    throw new Error('League ID, Team ID, and trade players are required');
  }
  const model = await buildValueModel(leagueId);
  const myId = parseInt(teamId, 10);
  const give = await resolvePlayers(model, leagueId, giving);
  const get = await resolvePlayers(model, leagueId, receiving);

  const warnings: string[] = [];
  for (const p of give) if (p.onTeamId !== myId) warnings.push(`${p.name} isn't on your roster`);
  const partnerIds = [...new Set(get.map((p) => p.onTeamId))];
  if (partnerIds.length > 1 || partnerIds[0] === 0) warnings.push('The players you\'d receive aren\'t all on one other team');
  const partnerId = partnerIds.find((id) => id && id !== myId);

  // Chart side: totals with the charts' extra-player discount
  const giveValue = give.reduce((a, p) => a + p.value, 0);
  const getValue = get.reduce((a, p) => a + p.value, 0);
  const extraReceived = get.length - give.length;
  const getAdj = extraReceived > 0 ? getValue * (1 - EXTRA_PLAYER_DISCOUNT * extraReceived) : getValue;
  const giveAdj = extraReceived < 0 ? giveValue * (1 - EXTRA_PLAYER_DISCOUNT * -extraReceived) : giveValue;
  const chartDiff = getAdj - giveAdj;

  // Lineup side: the team receiving more players must drop its lowest
  // rest-of-season bench player; the other can add the best free agent.
  const bestFreeAgents = [...model.players.values()].filter((p) => !p.onTeamId).sort((a, b) => b.rosPoints - a.rosPoints);
  const rosterOf = (id: number) => (model.rosters.get(id) || []).map((pid) => model.players.get(pid)).filter(Boolean) as ValuedPlayer[];
  const afterTrade = (id: number, out: ValuedPlayer[], inc: ValuedPlayer[]) => {
    let roster = rosterOf(id).filter((p) => !out.some((o) => o.id === p.id)).concat(inc);
    const surplus = inc.length - out.length;
    if (surplus > 0) {
      const keep = new Set(inc.map((p) => p.id));
      const droppable = roster.filter((p) => !keep.has(p.id)).sort((a, b) => a.rosPoints - b.rosPoints);
      const drop = new Set(droppable.slice(0, surplus).map((p) => p.id));
      roster = roster.filter((p) => !drop.has(p.id));
    } else if (surplus < 0) {
      roster = roster.concat(bestFreeAgents.slice(0, -surplus));
    }
    return roster;
  };

  const mineBefore = lineupPoints(model, rosterOf(myId));
  const mineAfter = lineupPoints(model, afterTrade(myId, give, get));
  const myGain = mineAfter.total - mineBefore.total;
  const myPlayoffGain = model.playoffWeeks.reduce((a, w) => a + (mineAfter.byWeek.get(w) || 0) - (mineBefore.byWeek.get(w) || 0), 0);
  const thisWeek = model.weeks[0];
  const myWeekGain = thisWeek ? (mineAfter.byWeek.get(thisWeek) || 0) - (mineBefore.byWeek.get(thisWeek) || 0) : 0;

  let partner: any = null;
  if (partnerId) {
    const before = lineupPoints(model, rosterOf(partnerId));
    const after = lineupPoints(model, afterTrade(partnerId, get, give));
    partner = { team: teamName(model.ctx, partnerId), lineupPointsChange: round(after.total - before.total, 1) };
  }

  let recommendation: 'accept' | 'reject' | 'counter';
  let verdict: string;
  if (myGain > 5) {
    recommendation = 'accept';
    verdict = partner && partner.lineupPointsChange > 0 ? 'Helps both lineups (a real win-win)' : 'Improves your starting lineup';
  } else if (myGain < -5) {
    recommendation = 'reject';
    verdict = 'Makes your starting lineup worse';
  } else {
    recommendation = chartDiff >= 0 ? 'accept' : 'counter';
    verdict = chartDiff >= 0 ? 'Lineup-neutral, but you win on trade value' : 'Lineup-neutral and you give up more value; ask for more';
  }
  if (partner && partner.lineupPointsChange < -10 && myGain > 0) {
    verdict += `, but it costs ${partner.team} ${Math.abs(partner.lineupPointsChange)} lineup points, so expect them to say no`;
  }
  const totalChart = Math.max(giveAdj + getAdj, 1);

  return {
    tradeScore: Math.round(myGain),
    recommendation,
    reasoning:
      `${verdict}. Your best lineup changes by ${myGain >= 0 ? '+' : ''}${myGain.toFixed(1)} projected points over weeks ` +
      `${model.weeks[0]}-${model.weeks[model.weeks.length - 1]} (${myPlayoffGain >= 0 ? '+' : ''}${myPlayoffGain.toFixed(1)} in playoff weeks). ` +
      `Trade value: you get ${getAdj.toFixed(1)}, give ${giveAdj.toFixed(1)}.`,
    fairnessRating: Math.round(Math.max(0, Math.min(100, 50 + (50 * chartDiff) / totalChart))),
    impact: {
      immediate: `${myWeekGain >= 0 ? '+' : ''}${myWeekGain.toFixed(1)} projected lineup points this week`,
      restOfSeason: `${myGain >= 0 ? '+' : ''}${myGain.toFixed(1)} rest of season, ${myPlayoffGain >= 0 ? '+' : ''}${myPlayoffGain.toFixed(1)} in the fantasy playoffs`,
    },
    tradeValue: {
      giving: give.map((p) => chartRow(model, p)),
      receiving: get.map((p) => chartRow(model, p)),
      givingTotal: round(giveValue, 1),
      receivingTotal: round(getValue, 1),
      ...(extraReceived !== 0
        ? { extraPlayerDiscount: `${Math.abs(extraReceived)} extra player(s) received by ${extraReceived > 0 ? 'you' : 'them'}: that side's total discounted ${Math.abs(extraReceived) * EXTRA_PLAYER_DISCOUNT * 100}%` }
        : {}),
    },
    lineupImpact: {
      you: { lineupPointsChange: round(myGain, 1), playoffWeeksChange: round(myPlayoffGain, 1) },
      ...(partner ? { partner } : {}),
      note: 'Best possible starting lineup each remaining week from ESPN weekly projections. The side receiving extra players drops its lowest-projected bench player; the other adds the best free agent.',
    },
    ...(warnings.length ? { warnings } : {}),
  };
}
