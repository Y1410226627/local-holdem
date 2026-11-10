/**
 * 按街范围信念（ReBeL / Libratus 的「公开信念状态」轻量实现）。
 *
 * 与旧实现的关键区别：
 * - 旧 `buildChallengeRanges` 在所有街都用 `preflopStrengthOf`，等于“河牌还在读翻前起手牌”；
 * - 新实现先由翻前动作/统计构造先验，再在 flop / turn / river 逐街用
 *   「牌面强度 + 听牌 + 动作类型」做贝叶斯更新，并显式做牌张移除。
 *
 * 只使用公开信息：公共牌、行动历史、公开统计、自己的底牌（用于移除冲突组合）。
 */
import type { Card, PlayerAction, Street } from '../../game/types';
import type { RangeWeight } from '../equity';
import { createDeck } from '../../game/cards';
import type { PlayerView } from '../../game/playerView';
import {
  allCombos,
  cardKey,
  comboHasDraw,
  comboKey,
  comboStrength,
  parseComboKey,
  preflopEquityOf,
  showdownSign,
  weightedSample,
  type Combo,
} from './abstraction';

/** comboKey -> 未归一化权重。 */
export type Range = Map<string, number>;

export interface RangeEntry {
  combo: Combo;
  weight: number;
}

const STREET_ORDER: Street[] = ['preflop', 'flop', 'turn', 'river'];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** 公开统计的默认值：样本不足时用稳健的先验。 */
function statsOf(view: PlayerView, playerId: number) {
  const player = view.players.find((entry) => entry.id === playerId);
  const stats = player?.stats;
  return {
    hands: stats?.hands ?? 0,
    vpip: stats?.vpipRate ?? 0.38,
    pfr: stats?.pfrRate ?? 0.16,
    foldToBet: stats?.foldToBetRate ?? 0.45,
  };
}

function actionsOf(view: PlayerView, playerId: number, street: Street): PlayerAction[] {
  return view.actions
    .filter((record) => record.actorId === playerId && record.street === street)
    .map((record) => record.action);
}

/** 用 169 类真实胜率给组合一个先验权重。 */
function equityPrior(combo: Combo, topFraction: number, tailWeight: number): number {
  const equity = preflopEquityOf(combo.first, combo.second);
  // topFraction = 0.2 表示“前 20% 的牌权重 1，其余 tailWeight”。
  // 用平滑阈值而不是硬切，避免范围出现不自然的断层。
  const threshold = 1 - clamp01(topFraction);
  const scale = 0.12;
  const above = sigmoid((equity - threshold) / scale);
  return tailWeight + (1 - tailWeight) * above;
}

/**
 * 翻前先验：根据该玩家在翻前的动作 + 公开 VPIP/PFR 构造范围。
 * - 加注过：偏强范围 + 少量诈唬尾部；
 * - 只跟注：偏中等范围；
 * - 只过牌（大盲）：宽范围。
 */
export function preflopRangeFor(
  view: PlayerView,
  playerId: number,
  includeSelfCards = false,
): Range {
  const player = view.players.find((entry) => entry.id === playerId);
  if (!player) return new Map();
  const dead = new Set<string>([
    ...view.board.map(cardKey),
    ...(includeSelfCards ? [] : view.self.holeCards.map(cardKey)),
  ]);
  const combos = allCombos(dead);
  const actions = actionsOf(view, playerId, 'preflop');
  const aggressive = actions.some(
    (action) => action.type === 'bet' || action.type === 'raise' || action.type === 'allin',
  );
  const called = actions.some((action) => action.type === 'call');
  const stats = statsOf(view, playerId);
  const range: Range = new Map();

  for (const combo of combos) {
    let weight: number;
    if (aggressive) {
      // 加注范围：PFR 越高越宽；再加 5% 的弱牌诈唬尾部。
      const top = clamp01(Math.max(0.06, stats.pfr * (stats.hands >= 8 ? 1 : 1.25)));
      weight = equityPrior(combo, top, 0.04);
    } else if (called) {
      // 跟注范围：VPIP 越宽；中等强度权重更高。
      const top = clamp01(Math.max(0.12, stats.vpip * (stats.hands >= 8 ? 1 : 1.2)));
      const equity = preflopEquityOf(combo.first, combo.second);
      const middle = Math.exp(-Math.pow((equity - 0.5) / 0.22, 2));
      weight = 0.08 + 0.72 * equityPrior(combo, top, 0.1) + 0.2 * middle;
    } else {
      // 大盲过牌 / 无人入池：宽范围，但保留强弱梯度。
      const equity = preflopEquityOf(combo.first, combo.second);
      weight = 0.25 + 0.75 * equity;
    }
    range.set(combo.key, weight);
  }
  return normalizeRange(range);
}

/**
 * 单街贝叶斯更新：对每个组合计算「在该牌面下做出这些动作」的似然。
 * 这不是精确的博弈论似然，而是可解释的信念近似：
 * - 下注/加注：强牌 + 听牌 + 少量诈唬；
 * - 跟注：中等强度 + 听牌 + 抓诈；
 * - 过牌：中等/边缘为主，强牌有慢玩权重。
 */
export function updateRangeOnStreet(
  range: Range,
  view: PlayerView,
  playerId: number,
  street: Street,
  board: readonly Card[] = view.board,
): Range {
  if (street === 'preflop') return range;
  const actions = actionsOf(view, playerId, street);
  if (actions.length === 0) return range;
  // 这里必须是「该街当时的公共牌」，不能用最终的 5 张看翻牌动作，否则是前视偏差。
  if (board.length < 3) return range;
  const texture = boardWetness(board);
  const next: Range = new Map();
  for (const [key, weight] of range) {
    const [first, second] = parseComboKey(key);
    const strength = comboStrength([first, second], board);
    const draw = comboHasDraw([first, second], board);
    let likelihood = 1;
    for (const action of actions) {
      if (action.type === 'bet' || action.type === 'raise' || action.type === 'allin') {
        // 强牌下注；听牌半诈唬；弱牌纯诈唬尾部。湿牌面提高半诈唬权重。
        const value = sigmoid((strength - 0.58) / 0.14);
        const semi = draw ? 0.18 + 0.12 * texture : 0;
        const bluff = 0.05 + 0.05 * texture;
        likelihood *= clamp01(0.03 + 0.9 * value + semi + bluff);
      } else if (action.type === 'call') {
        // 跟注：中等强度 + 听牌 + 抓诈；极强牌也可能慢玩。
        const middle = Math.exp(-Math.pow((strength - 0.52) / 0.2, 2));
        const slow = strength > 0.86 ? 0.35 : 0;
        const drawCall = draw ? 0.2 : 0;
        likelihood *= clamp01(0.08 + 0.65 * middle + drawCall + slow);
      } else if (action.type === 'check') {
        // 过牌：强牌慢玩 / 中等牌控池 / 弱牌放弃。
        const trap = strength > 0.82 ? 0.55 : 0;
        const giveUp = strength < 0.3 ? 0.65 : 0;
        likelihood *= clamp01(0.25 + trap + giveUp + 0.35 * (1 - Math.abs(strength - 0.5) * 2));
      }
    }
    next.set(key, weight * likelihood);
  }
  return normalizeRange(next);
}

function boardWetness(board: readonly Card[]): number {
  const suits = new Map<string, number>();
  const ranks = new Set<number>();
  for (const card of board) {
    suits.set(card.suit, (suits.get(card.suit) ?? 0) + 1);
    ranks.add(card.rank);
  }
  const maxSuit = Math.max(0, ...suits.values());
  const sorted = [...ranks].sort((a, b) => a - b);
  const span = sorted.length > 0 ? sorted[sorted.length - 1] - sorted[0] : 0;
  return clamp01((maxSuit >= 3 ? 0.5 : maxSuit === 2 ? 0.2 : 0) + (span <= 4 ? 0.35 : 0));
}

export function normalizeRange(range: Range): Range {
  let total = 0;
  for (const weight of range.values()) total += weight;
  if (total <= 1e-12) return range;
  const out: Range = new Map();
  for (const [key, weight] of range) out.set(key, weight / total);
  return out;
}

/**
 * 构造任意玩家（含自己）的按街范围。
 * 自己的范围必须包含自己的底牌，所以 includeSelfCards=true 时不做自我牌张移除。
 */
export function buildRangeForPlayer(
  view: PlayerView,
  playerId: number,
  includeSelfCards = false,
): Range {
  let range = preflopRangeFor(view, playerId, includeSelfCards);
  const currentIndex = STREET_ORDER.indexOf(view.street);
  for (let index = 1; index <= currentIndex; index++) {
    // 第 index 街的公共牌数量：flop=3 / turn=4 / river=5。
    const boardAtStreet = view.board.slice(0, 2 + index);
    range = updateRangeOnStreet(range, view, playerId, STREET_ORDER[index], boardAtStreet);
  }
  return range;
}

const rangeCache = new Map<string, Map<number, Range>>();

/**
 * 构造当前视图下所有活跃对手的按街范围（带缓存）。
 *
 * 缓存键必须包含**动作内容**，不能只用动作数量：
 * 两条不同的行动线可以有相同的长度（例如「加注-跟注」与「加注-弃牌」），
 * 用数量做键会让后一条线命中前一条线的范围——这是真 bug，
 * 在「同 seed 两条臂并行」的审计里会互相污染。
 */
export function buildStreetRanges(view: PlayerView): Map<number, Range> {
  const actionDigest = view.actions
    .map((record) => `${record.street[0]}${record.action.type[0]}${record.toAmount ?? 0}`)
    .join(',');
  const cacheKey = `${view.seed}|${view.street}|${view.board.map(cardKey).join(',')}|${actionDigest}`;
  const cached = rangeCache.get(cacheKey);
  if (cached) return cached;
  const out = new Map<number, Range>();
  for (const player of view.players) {
    if (player.id === view.viewerId) continue;
    if (player.status !== 'active' && player.status !== 'allin') continue;
    out.set(player.id, buildRangeForPlayer(view, player.id, false));
  }
  if (rangeCache.size >= 16) {
    const oldest = rangeCache.keys().next().value;
    if (oldest !== undefined) rangeCache.delete(oldest);
  }
  rangeCache.set(cacheKey, out);
  return out;
}

/** 把范围转成 estimateEquity 需要的 (c1,c2)->weight 函数。 */
export function rangeWeightFn(range: Range): (first: Card, second: Card) => number {
  return (first, second) => range.get(comboKey(first, second)) ?? 0.02;
}

/** 取权重最高的 n 个组合（用于子博弈求解，避免 1326 组合爆炸）。 */
export function topCombos(range: Range, count: number): RangeEntry[] {
  const entries: RangeEntry[] = [];
  for (const [key, weight] of range) {
    const [first, second] = parseComboKey(key);
    entries.push({ combo: { first, second, key }, weight });
  }
  entries.sort((a, b) => b.weight - a.weight);
  return entries.slice(0, Math.max(1, count));
}

/** 按权重抽样 n 个组合（保留真实底牌，不在范围里也强制加入）。 */
export function sampleRange(
  range: Range,
  count: number,
  rng: () => number,
  mustInclude?: readonly [Card, Card],
): RangeEntry[] {
  const entries: RangeEntry[] = [];
  const keys: string[] = [];
  const weights: number[] = [];
  for (const [key, weight] of range) {
    const [first, second] = parseComboKey(key);
    entries.push({ combo: { first, second, key }, weight });
    keys.push(key);
    weights.push(weight);
  }
  if (entries.length === 0) return [];
  const picked = weightedSample(entries, weights, count, rng);
  if (mustInclude) {
    const key = comboKey(mustInclude[0], mustInclude[1]);
    if (!picked.some((entry) => entry.combo.key === key)) {
      // 强制加入的那手牌必须用它在范围里的**真实权重**，不能用 1：
      // 采样后我们会按 weight 归一化成 reach，权重 1 会让这一手吃掉整个范围
      // （范围里 100 手牌各 0.01 时，权重 1 的手牌占 ~70%）。
      picked.push({
        combo: { first: mustInclude[0], second: mustInclude[1], key },
        weight: Math.max(1e-6, range.get(key) ?? 0),
      });
    }
  }
  return picked;
}

/** 单手牌对范围的蒙特卡洛胜率（0..1）。 */
export function equityVsRange(
  hero: readonly [Card, Card],
  range: readonly RangeEntry[],
  board: readonly Card[],
  samples: number,
  rng: () => number,
): number {
  if (range.length === 0) return 0.5;
  if (board.length < 5) return 0.5;
  let score = 0;
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const entry = range[Math.floor(rng() * range.length)] ?? range[0];
    const sign = showdownSign(hero, [entry.combo.first, entry.combo.second], board);
    score += sign > 0 ? 1 : sign === 0 ? 0.5 : 0;
    total += entry.weight;
  }
  return total > 0 ? score / samples : 0.5;
}

/**
 * 把 `RangeWeight`（启发式层用的 `(first, second) => weight` 闭包）
 * 展开成求解器要的 `Range`（comboKey → 权重）。
 *
 * 目的：让**求解器与启发式用同一套范围**。之前求解器内部另建了一套按街范围，
 * 与启发式不一致，导致「转牌按均衡打、河牌按启发式打」的割裂。
 */
export function rangeFromWeight(
  view: PlayerView,
  weight: RangeWeight,
  playerId: number,
  includeSelfCards = false,
): Range {
  const blocked = new Set<string>(view.board.map(cardKey));
  if (!includeSelfCards) for (const card of view.self.holeCards) blocked.add(cardKey(card));
  void playerId;
  const deck = createDeck().filter((card) => !blocked.has(cardKey(card)));
  const out: Range = new Map();
  for (let i = 0; i < deck.length; i++) {
    for (let j = i + 1; j < deck.length; j++) {
      const first = deck[i];
      const second = deck[j];
      const value = weight(first, second);
      if (!Number.isFinite(value) || value <= 0) continue;
      out.set(comboKey(first, second), value);
    }
  }
  return out;
}
