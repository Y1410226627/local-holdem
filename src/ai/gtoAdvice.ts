/**
 * GTO 短码建议（B1）：优先查离线生成的 push/fold 策略表（4–20BB 插值），
 * 表外回退在线 CFR 求解。仅使用公开信息（位置、筹码、自己的底牌）。
 */
import type { PlayerView } from '../game/playerView';
import { bucketOfStrength, solvePushFold } from './gto';
import { lookupPushFoldChart } from './gtoTable';
import { preflopStrength } from './rangeModel';

export interface PushFoldAdvice {
  action: 'push' | 'fold' | 'call';
  /** 均衡频率下的对应动作概率。 */
  frequency: number;
  bucket: number;
  note: string;
}

/**
 * 单挑短码（≤12BB）的 GTO 推/弃、跟/弃建议；不满足条件返回 null。
 * 只读取公开信息（位置、筹码、底牌）。
 */
export function gtoPushFoldAdvice(view: PlayerView): PushFoldAdvice | null {
  if (view.street !== 'preflop') return null;
  const opponents = view.players.filter(
    (player) => player.id !== view.viewerId && (player.status === 'active' || player.status === 'allin'),
  );
  if (opponents.length !== 1) return null;
  // 全下后对手 stack 可能为 0，用「身后筹码 + 本轮已投入」估算有效筹码。
  const effectiveStack = Math.min(
    view.self.stack + view.self.totalCommitted,
    opponents[0].stack + opponents[0].totalCommitted,
  );
  if (effectiveStack > 20 * view.bigBlind || effectiveStack < 2 * view.bigBlind) return null;
  const stackBB = effectiveStack / view.bigBlind;
  // B1：4–20BB 优先查离线生成的 CFR 策略表（零求解成本）；表外回退在线求解。
  const chart = lookupPushFoldChart(stackBB);
  const solution = chart ?? solvePushFold({ stackBB });
  const sourceLabel = chart
    ? chart.source === 'exact'
      ? '查表'
      : '插值'
    : '在线求解';
  const bucket = bucketOfStrength(
    preflopStrength(view.self.holeCards),
    solution.boundaries,
  );
  const bucketCount = solution.buckets;
  const selfIndex = view.players.findIndex((player) => player.id === view.viewerId);
  const isSmallBlind = selfIndex === view.buttonIndex;
  if (isSmallBlind) {
    const frequency = solution.sbPushFrequency[bucket];
    return {
      action: frequency >= 0.5 ? 'push' : 'fold',
      frequency: frequency >= 0.5 ? frequency : 1 - frequency,
      bucket,
      note: `GTO 短码（${stackBB.toFixed(1)}BB 单挑，${sourceLabel}）：桶 ${bucket}/${bucketCount - 1} 全下频率 ${(frequency * 100).toFixed(0)}%`,
    };
  }
  const facingAllIn =
    view.legal?.isAllInCall === true ||
    (view.currentBet >= effectiveStack && view.currentBet > view.bigBlind);
  if (!facingAllIn) return null;
  const frequency = solution.bbCallFrequency[bucket];
  return {
    action: frequency >= 0.5 ? 'call' : 'fold',
    frequency: frequency >= 0.5 ? frequency : 1 - frequency,
    bucket,
    note: `GTO 短码（${stackBB.toFixed(1)}BB 单挑，${sourceLabel}）：桶 ${bucket}/${bucketCount - 1} 跟注频率 ${(frequency * 100).toFixed(0)}%`,
  };
}
