import type { PlayerView } from '../game/playerView';

/**
 * 底池类型识别（翻牌层的第二个特征）。
 *
 * 为什么要它：`decideExpertPostflop` 的翻牌决策完全不区分「这是个什么底池」。
 * 但 3-bet 底池和单加注底池的打法差异极大——3-bet 底池里进攻方范围极强且集中，
 * 标准打法是高频小尺度持续下注；而跟注方则要大幅收紧。
 *
 * 交接说明书 §4.2 记录的真实漏洞（Q5s 那手 3-bet 后三条街全过牌）正是这个缺失：
 * 翻前知道自己是 3-bet 方，翻后却没有任何一层把这个信息传下去。
 */
export type PotType = 'limped' | 'srp' | '3bet' | '4bet+';

export interface PotContext {
  type: PotType;
  /** 我方是否为翻前最后一个主动加注者（范围优势方）。 */
  isAggressor: boolean;
  /** 翻前加注/全下次数。 */
  raises: number;
}

/** 从公开行动记录里推底池类型；不含任何隐藏信息。 */
export function readPotContext(view: PlayerView): PotContext {
  const preflop = view.actions.filter((a) => a.street === 'preflop');
  const raises = preflop.filter(
    (a) => a.action.type === 'raise' || a.action.type === 'allin' || a.action.type === 'bet',
  ).length;

  let isAggressor = false;
  for (const a of preflop) {
    if (a.action.type === 'raise' || a.action.type === 'allin' || a.action.type === 'bet') {
      isAggressor = a.actorId === view.viewerId;
    }
  }

  const type: PotType = raises === 0 ? 'limped' : raises === 1 ? 'srp' : raises === 2 ? '3bet' : '4bet+';
  return { type, isAggressor, raises };
}

/**
 * 3-bet 底池里「作为进攻方」的持续下注倾向加成。
 * 0 表示不加成；数值直接并入干燥面的范围下注倾向。
 */
export function threeBetCbetBonus(context: PotContext): number {
  if (!context.isAggressor) return 0;
  if (context.type === '3bet') return 0.35;
  if (context.type === '4bet+') return 0.25;
  return 0;
}
