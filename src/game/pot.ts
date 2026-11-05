/**
 * 边池（side pot）计算与底池分配。
 *
 * 规则：
 * - 主池 = 最小全下筹码 × 参与人数；边池依次用“次小投入 − 前一层级”× 对应参与人数计算。
 * - 弃牌玩家的筹码留在底池中，但没有资格赢取任何底池。
 * - 每个玩家只能赢取自己投入达到的层级。
 * - 未被跟注的多余下注退回。
 * - 平分时的奇数筹码按“按钮左边第一个赢家”优先分配。
 */
import type { PotAward, PotPayout } from './types';

export interface PotContribution {
  playerId: number;
  name: string;
  /** 本手牌累计投入。 */
  totalCommitted: number;
  folded: boolean;
}

export interface SidePot {
  index: number;
  label: string;
  amount: number;
  /** 有资格赢取该底池的玩家 id（即投入达到该层级且未弃牌的玩家）。 */
  eligiblePlayerIds: number[];
}

/**
 * 根据每位玩家的累计投入构建主池 + 多层边池。
 * 同一投入层级的玩家共同构成该层级底池。
 */
export function buildSidePots(contributions: readonly PotContribution[]): SidePot[] {
  const positive = contributions.filter((c) => c.totalCommitted > 0);
  if (positive.length === 0) return [];

  const levels = [...new Set(positive.map((c) => c.totalCommitted))].sort((a, b) => a - b);
  const pots: SidePot[] = [];
  let previousLevel = 0;

  for (const level of levels) {
    const involved = positive.filter((c) => c.totalCommitted >= level);
    const amount = (level - previousLevel) * involved.length;
    if (amount > 0) {
      const eligible = involved.filter((c) => !c.folded).map((c) => c.playerId);
      if (eligible.length === 0) {
        // 理论上不可能出现（最高投入者不可能已弃牌）；作为死钱并入已有底池，保证筹码守恒。
        if (pots.length > 0) {
          pots[0].amount += amount;
        } else {
          pots.push({ index: 0, label: '主池', amount, eligiblePlayerIds: [] });
        }
      } else {
        pots.push({
          index: pots.length,
          label: pots.length === 0 ? '主池' : `边池 ${pots.length}`,
          amount,
          eligiblePlayerIds: eligible,
        });
      }
    }
    previousLevel = level;
  }

  return pots;
}

export interface UncalledRefund {
  playerId: number;
  name: string;
  amount: number;
}

/**
 * 计算未被跟注的多余下注：
 * 最高投入者只有一个、且其投入高于第二高投入时，差额退回。
 */
export function calcUncalledRefund(
  contributions: readonly PotContribution[],
): UncalledRefund | null {
  const positive = contributions.filter((c) => c.totalCommitted > 0);
  if (positive.length <= 1) {
    // 只有一个人投入过筹码：全部退回（其他人全部弃牌的情况）。
    const only = positive[0];
    if (only && !only.folded) {
      return { playerId: only.playerId, name: only.name, amount: only.totalCommitted };
    }
    return null;
  }
  const sorted = [...positive].sort((a, b) => b.totalCommitted - a.totalCommitted);
  const top = sorted[0];
  const second = sorted[1];
  if (top.folded) return null;
  const amount = top.totalCommitted - second.totalCommitted;
  if (amount <= 0) return null;
  return { playerId: top.playerId, name: top.name, amount };
}

export interface PotContender {
  playerId: number;
  name: string;
  /** 牌型比较分值，越大越强。 */
  score: number;
}

/**
 * 分配每个底池给对应层级的赢家。
 * @param orderFromButtonLeft 玩家 id 按“按钮左边起顺时针”的顺序，用于奇数筹码分配。
 */
export function awardPots(
  pots: readonly SidePot[],
  contenders: ReadonlyMap<number, PotContender>,
  orderFromButtonLeft: readonly number[],
): PotAward[] {
  const awards: PotAward[] = [];
  for (const pot of pots) {
    const eligible = pot.eligiblePlayerIds
      .map((id) => contenders.get(id))
      .filter((c): c is PotContender => c !== undefined);
    if (eligible.length === 0) continue;

    const bestScore = Math.max(...eligible.map((c) => c.score));
    const winners = eligible.filter((c) => c.score === bestScore);
    const orderIndex = new Map<number, number>();
    orderFromButtonLeft.forEach((id, index) => orderIndex.set(id, index));
    winners.sort((a, b) => (orderIndex.get(a.playerId) ?? 0) - (orderIndex.get(b.playerId) ?? 0));

    const share = Math.floor(pot.amount / winners.length);
    const oddChips = pot.amount - share * winners.length;
    const payouts: PotPayout[] = winners.map((winner, index) => ({
      playerId: winner.playerId,
      name: winner.name,
      amount: share + (index < oddChips ? 1 : 0),
    }));

    awards.push({
      index: pot.index,
      label: pot.label,
      amount: pot.amount,
      winnerIds: winners.map((w) => w.playerId),
      payouts,
      oddChips,
      oddChipTo: oddChips > 0 ? winners[0].playerId : undefined,
    });
  }
  return awards;
}
