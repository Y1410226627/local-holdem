/**
 * 深度受限搜索 + 多人谨慎（借鉴 DeepStack 的 depth-limited search / Pluribus 的多人策略结论）。
 *
 * - 对当前决策点枚举合法动作（过牌 / 跟注 / 弃牌 / 若干下注尺度），用「胜率 + 弃牌率 +
 *   多人谨慎系数」估算一步 EV，返回 EV 最优动作；挑战模式 / 高接近度 AI 会按概率采用；
 * - 多人底池降低诈唬收益（Pluribus：多人局中过度诈唬更容易被惩罚），作为搜索中的惩罚项；
 * - 这不是完整博弈树求解，只是单步期望搜索；所有信息只来自 PlayerView。
 */
import type { LegalActions, PlayerAction } from '../game/types';
import type { PlayerView } from '../game/playerView';
import { estimateFoldProbability, evOfBet } from './humanModel';
import { continuationValue } from './continuation';

/** 多人谨慎系数：人数越多，诈唬的弃牌收益越要打折。 */
export function multiwayCaution(opponentCount: number): number {
  if (opponentCount >= 4) return 0.35;
  if (opponentCount === 3) return 0.5;
  if (opponentCount === 2) return 0.72;
  return 1;
}

function buildAggressive(legal: LegalActions, target: number): PlayerAction | null {
  if (!legal.aggressiveType) return null;
  if (!Number.isFinite(target)) return null;
  const { minRaiseTo, maxRaiseTo, currentBet } = legal;
  if (maxRaiseTo <= currentBet) return null;
  let amount = Math.round(target);
  if (amount > maxRaiseTo) amount = maxRaiseTo;
  if (amount < minRaiseTo) {
    if (maxRaiseTo < minRaiseTo) amount = maxRaiseTo;
    else amount = minRaiseTo;
  }
  if (amount <= currentBet) return null;
  if (amount === maxRaiseTo && legal.canAllIn) return { type: 'allin' };
  return { type: legal.aggressiveType, amount };
}

export interface SearchCandidate {
  action: PlayerAction;
  ev: number;
  label: string;
}

export interface DepthLimitedSearchInput {
  view: PlayerView;
  legal: LegalActions;
  equity: number;
  opponentCount: number;
  foldToBetRate: number | null;
  /** 当前手读到的对手偏弱信号（挑战模式）。 */
  timingWeak?: boolean;
  /** 0..1 均衡接近度，越高越愿意思考更多候选 / 采用搜索结果。 */
  closeness?: number;
}

/**
 * 单步深度受限搜索：枚举候选动作并估算期望收益。
 * 返回按 EV 降序的动作列表（第一个即推荐）。
 */
export function depthLimitedSearch(input: DepthLimitedSearchInput): SearchCandidate[] {
  const { view, legal, equity, opponentCount, foldToBetRate, timingWeak = false } = input;
  const pot = Math.max(1, view.pot);
  const callCost = Math.max(0, legal.callAmount);
  const candidates: SearchCandidate[] = [];
  const futureValue = continuationValue({
    street: (view.street ?? 'turn') as 'preflop' | 'flop' | 'turn' | 'river',
    equity,
    pot,
    effectiveStack: Math.max(1, view.self?.stack ?? 100),
    opponentCount,
  });
  const caution = multiwayCaution(opponentCount);
  const foldBoost = timingWeak ? 1.15 : 1;
  const foldRate = (fraction: number) =>
    Math.min(0.85, estimateFoldProbability(fraction, foldToBetRate, opponentCount) * caution * foldBoost);

  if (legal.canCheck) {
    candidates.push({ action: { type: 'check' }, ev: equity * pot * 0.95 + futureValue, label: '过牌实现胜率' });
  }
  if (legal.canCall) {
    candidates.push({
      action: { type: 'call' },
      ev: equity * (pot + callCost) - callCost + futureValue * 0.4,
      label: '跟注',
    });
  }
  if (legal.canFold) {
    // 相对 EV：弃牌收益记为 0（不再投入），便于与其它动作比较。
    candidates.push({ action: { type: 'fold' }, ev: 0, label: '弃牌' });
  }

  const fractions = [0.5, 0.75, 1.1];
  for (const fraction of fractions) {
    const target = legal.currentBet + (pot + callCost) * fraction;
    const aggressive = buildAggressive(legal, target);
    if (!aggressive) continue;
    const betChips = Math.max(1, Math.round(target) - legal.currentBet);
    const foldProbability = foldRate(fraction);
    const ev = evOfBet(pot, equity, betChips, foldProbability, opponentCount) + futureValue * 0.6;
    candidates.push({ action: aggressive, ev, label: '下注 / 加注 ' + Math.round(fraction * 100) + '% 池' });
  }

  candidates.sort((a, b) => b.ev - a.ev);
  return candidates;
}

/** 估算某个动作的一步 EV（供与搜索结果比较）；无法估算返回 null。 */
export function estimateActionEv(params: {
  action: PlayerAction;
  view: PlayerView;
  legal: LegalActions;
  equity: number;
  opponentCount: number;
  foldToBetRate: number | null;
}): number | null {
  const { action, view, legal, equity, opponentCount, foldToBetRate } = params;
  const pot = Math.max(1, view.pot);
  const callCost = Math.max(0, legal.callAmount);
  // 与 depthLimitedSearch 使用同一口径：未来街 continuation 也要计入，
  // 否则“搜索推荐”与“启发式动作”的 EV 不可比（调查员发现的 bug）。
  const futureValue = continuationValue({
    street: (view.street ?? 'turn') as 'preflop' | 'flop' | 'turn' | 'river',
    equity,
    pot,
    effectiveStack: Math.max(1, view.self?.stack ?? 100),
    opponentCount,
  });
  if (action.type === 'fold') return 0;
  if (action.type === 'check') return equity * pot * 0.95 + futureValue;
  if (action.type === 'call') return equity * (pot + callCost) - callCost + futureValue * 0.4;
  const target =
    action.type === 'allin' ? legal.maxRaiseTo : action.type === 'bet' || action.type === 'raise' ? action.amount : null;
  if (target === null) return null;
  const betChips = Math.max(1, target - legal.currentBet);
  const fraction = betChips / pot;
  const foldProbability = Math.min(
    0.85,
    estimateFoldProbability(fraction, foldToBetRate, opponentCount) * multiwayCaution(opponentCount),
  );
  return evOfBet(pot, equity, betChips, foldProbability, opponentCount) + futureValue * 0.6;
}

