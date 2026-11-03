import { espnApi } from '../services/espnApi.js';
import { Player, TradeAnalysis } from '../types/espn.js';
import { evaluateTrade } from './tradeValues.js';

export interface TradeProposal {
  giving: Player[];
  receiving: Player[];
  teamId: string;
  partnerTeamId?: string;
}

// Trades are judged by tools/tradeValues.ts: rest-of-season trade values
// plus each team's best-lineup change. Output keeps the TradeAnalysis fields.
export async function analyzeTradesTool(args: {
  leagueId: string;
  teamId: string;
  giving: string[]; // Player names
  receiving: string[]; // Player names
}): Promise<TradeAnalysis & Record<string, unknown>> {
  try {
    return await evaluateTrade(args);
  } catch (error: any) {
    throw new Error(`Failed to analyze trade: ${error.message}`);
  }
}

export async function findTradeTargetsTool(args: {
  leagueId: string;
  teamId: string;
  targetPosition?: string;
}): Promise<{
  suggestions: Array<{
    targetPlayer: Player;
    suggestedOffer: Player[];
    reasoning: string;
  }>;
}> {
  const { leagueId, teamId, targetPosition } = args;
  
  if (!leagueId || !teamId) {
    throw new Error('League ID and Team ID are required');
  }
  
  try {
    const roster = await espnApi.getTeamRoster(leagueId, teamId);
    const allPlayers = await espnApi.getPlayers(leagueId);
    
    // Identify surplus positions (where we have depth)
    const positionCounts: { [key: string]: number } = {};
    [...roster.starters, ...roster.bench].forEach(player => {
      positionCounts[player.position] = (positionCounts[player.position] || 0) + 1;
    });
    
    const surplusPositions = Object.entries(positionCounts)
      .filter(([pos, count]) => count > 3)
      .map(([pos]) => pos);
    
    // Find trade targets (high-value players we could target), never our own
    const ownIds = new Set([...roster.starters, ...roster.bench, ...(roster.injuredReserve || [])].map(p => p.id));
    let targets = allPlayers.filter(p => {
      if (ownIds.has(p.id)) return false;
      if (targetPosition && p.position !== targetPosition) return false;
      if ((p.percentOwned || 0) < 70) return false; // Focus on rostered players
      if ((p.projectedPoints || 0) < 8) return false; // Minimum value threshold
      return true;
    });
    
    // Create trade suggestions
    const suggestions = targets
      .slice(0, 5)
      .map(targetPlayer => {
        // Find players from surplus positions to offer
        const offerCandidates = [...roster.starters, ...roster.bench]
          .filter(p => surplusPositions.includes(p.position))
          .sort((a, b) => (b.projectedPoints || 0) - (a.projectedPoints || 0));
        
        // Try to match value
        const targetValue = (targetPlayer.projectedPoints || 0) * 2;
        const suggestedOffer: Player[] = [];
        let offerValue = 0;
        
        for (const candidate of offerCandidates) {
          if (offerValue < targetValue * 0.9) {
            suggestedOffer.push(candidate);
            offerValue += (candidate.projectedPoints || 0) * 2;
          }
          if (offerValue >= targetValue * 0.9 && offerValue <= targetValue * 1.2) {
            break;
          }
        }
        
        const reasoning = `Target ${targetPlayer.fullName} (${targetPlayer.position}) ` +
          `by offering surplus at ${suggestedOffer[0]?.position || 'position'}`;
        
        return {
          targetPlayer,
          suggestedOffer,
          reasoning
        };
      })
      .filter(s => s.suggestedOffer.length > 0);
    
    return { suggestions };
  } catch (error: any) {
    throw new Error(`Failed to find trade targets: ${error.message}`);
  }
}