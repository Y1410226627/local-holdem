import type { Card } from '../game/types';

/**
 * 牌面纹理评估（翻牌层的基础特征）。
 *
 * 为什么要它：`decideExpertPostflop` 的尺度只由胜率决定（`pickExpertBetFraction`），
 * 完全不看牌面结构。而现代打法的核心之一恰恰是「同样的胜率，在不同的牌面上要用不同的
 * 尺度和频率」——干燥面用小尺度高频（范围下注），湿润面用大尺度低频。
 *
 * 这个模块只做纯计算，不产生任何行为变化；是否使用由调用方决定（当前仅挑战档）。
 */
export interface BoardTexture {
  /** 0 = 极干（彩虹、不连、无对子），1 = 极湿（同花面 + 连张 + 高张）。 */
  wetness: number;
  /** 翻牌是否成对。 */
  paired: boolean;
  /** flop 是否三张同花。 */
  monotone: boolean;
  /** flop 是否两张同花。 */
  twoTone: boolean;
  /** flop 是否连张（跨度小）。 */
  connected: boolean;
  /** flop 最大点数（2..14）。 */
  highCard: number;
}

const NEUTRAL: BoardTexture = {
  wetness: 0.5,
  paired: false,
  monotone: false,
  twoTone: false,
  connected: false,
  highCard: 0,
};

/**
 * 只用公共牌（不含自己手牌）评估纹理。
 * 翻牌前 / 牌面不足 3 张时返回中性值，调用方应据此跳过调整。
 */
export function boardTexture(board: readonly Card[]): BoardTexture {
  if (board.length < 3) return NEUTRAL;

  const flop = board.slice(0, 3);
  const suitCount = new Map<string, number>();
  for (const card of flop) {
    suitCount.set(card.suit, (suitCount.get(card.suit) ?? 0) + 1);
  }
  const maxSuit = Math.max(...suitCount.values());
  const monotone = maxSuit === 3;
  const twoTone = maxSuit === 2;

  const ranks = flop.map((c) => c.rank).sort((a, b) => a - b);
  const paired = new Set(ranks).size < 3;
  const span = ranks[2] - ranks[0];
  const gap1 = ranks[1] - ranks[0];
  const gap2 = ranks[2] - ranks[1];
  const connected = span <= 4 || (gap1 <= 2 && gap2 <= 2);

  let wetness = 0;
  if (monotone) wetness += 0.45;
  else if (twoTone) wetness += 0.2;
  if (connected) wetness += 0.3;
  if (span <= 3) wetness += 0.1;
  if (ranks[2] >= 12) wetness += 0.1;
  if (paired) wetness -= 0.15;

  return {
    wetness: Math.max(0, Math.min(1, wetness)),
    paired,
    monotone,
    twoTone,
    connected,
    highCard: ranks[2],
  };
}

/**
 * 尺度修正系数：干燥面缩小、湿润面放大。
 * 返回值直接乘在原有下注比例上，1.0 表示不改变。
 */
export function textureSizeFactor(texture: BoardTexture): number {
  if (texture.wetness < 0.3) return 0.7;
  if (texture.wetness < 0.5) return 0.85;
  if (texture.wetness > 0.75) return 1.2;
  if (texture.wetness > 0.6) return 1.1;
  return 1;
}

/**
 * 干燥面上「范围下注」的倾向：0 = 不额外下注，1 = 强烈倾向。
 * 只在挑战档使用，用来把「该位置本会过牌」的一部分转成小尺度下注。
 */
export function rangeBetTendency(texture: BoardTexture): number {
  if (texture.paired) return 0.15; // 成对面双方范围都收窄，少用范围下注
  if (texture.monotone) return 0;
  if (texture.wetness <= 0.3) return 0.45;
  if (texture.wetness <= 0.5) return 0.25;
  return 0;
}
