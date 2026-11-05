/**
 * 「体验随机」层：给每个机器人座位分配一个风格原型（在难度档允许范围内偏移参数），
 * 并提供本地机器人台词、下注尺度偏好、随机化辅助等纯确定性工具。
 *
 * 设计目标：
 * - 同一难度不再千篇一律：不同座位 / 不同新局会拿到不同风格（松凶、紧弱、跟注站…）；
 * - 强度仍受难度档约束：风格只在基础 profile 的有限邻域内改值，不会让入门档变成专家；
 * - 完全确定性：风格分配与随机化都由 table seed 派生，同种子可复现；AI 永不使用 Math.random。
 */
import { derivedRng } from '../game/cards';
import type { Difficulty } from '../game/types';
import { BASE_DIFFICULTY_PROFILES, type DifficultyProfile } from './difficulty';

export type BotStyleKey = 'tag' | 'lag' | 'nit' | 'station' | 'maniac' | 'balanced';

export interface BotStyle {
  key: BotStyleKey;
  /** 中文名（调试面板 / 说明）。 */
  label: string;
  /** 英文名（写进大模型提示词）。 */
  labelEn: string;
  description: string;
  /** 翻牌前相对难度基础档位的偏移 / 倍数。 */
  preflop: {
    play: number;
    raise: number;
    threeBet: number;
    bluffMul: number;
    mixRaise: number;
    trap: number;
    errorMul: number;
    openRaiseBB: number;
  };
  /** 翻牌后相对难度基础档位的偏移 / 倍数 / 尺度偏好。 */
  postflop: {
    bluffMul: number;
    semiBluffMul: number;
    valueThreshold: number;
    callMargin: number;
    errorMul: number;
    /** 正值偏好大尺度，负值偏好小尺度。 */
    sizeBias: number;
  };
  /** 每次决策附加随机化的概率（0..1）；不影响合法性，只增加变化。 */
  variationRate: number;
}

export const BOT_STYLES: readonly BotStyle[] = [
  {
    key: 'tag',
    label: '紧凶',
    labelEn: 'tight-aggressive',
    description: '少入池、多主动加注，尺度标准',
    preflop: { play: -0.04, raise: 0.03, threeBet: 0.02, bluffMul: 1.1, mixRaise: 0.03, trap: 0, errorMul: 0.9, openRaiseBB: 0 },
    postflop: { bluffMul: 1.1, semiBluffMul: 1.1, valueThreshold: -0.01, callMargin: 0.01, errorMul: 0.9, sizeBias: 0 },
    variationRate: 0.12,
  },
  {
    key: 'lag',
    label: '松凶',
    labelEn: 'loose-aggressive',
    description: '入池宽、频繁施压，爱用大尺度',
    preflop: { play: 0.06, raise: 0.02, threeBet: 0, bluffMul: 1.7, mixRaise: 0.08, trap: -0.02, errorMul: 1.1, openRaiseBB: 0.2 },
    postflop: { bluffMul: 1.7, semiBluffMul: 1.35, valueThreshold: -0.015, callMargin: 0.0, errorMul: 1.1, sizeBias: 0.18 },
    variationRate: 0.22,
  },
  {
    key: 'nit',
    label: '紧弱',
    labelEn: 'tight-passive',
    description: '只玩强牌、很少诈唬，遇到压力容易弃牌',
    preflop: { play: -0.1, raise: -0.04, threeBet: -0.03, bluffMul: 0.4, mixRaise: -0.06, trap: 0.02, errorMul: 0.7, openRaiseBB: -0.2 },
    postflop: { bluffMul: 0.4, semiBluffMul: 0.6, valueThreshold: 0.01, callMargin: 0.03, errorMul: 0.7, sizeBias: -0.12 },
    variationRate: 0.06,
  },
  {
    key: 'station',
    label: '跟注站',
    labelEn: 'calling-station',
    description: '不爱弃牌、爱看摊牌，较少主动加注',
    preflop: { play: 0.12, raise: -0.06, threeBet: -0.05, bluffMul: 0.6, mixRaise: -0.04, trap: 0.01, errorMul: 1.2, openRaiseBB: -0.1 },
    postflop: { bluffMul: 0.6, semiBluffMul: 0.8, valueThreshold: 0.02, callMargin: -0.03, errorMul: 1.2, sizeBias: -0.1 },
    variationRate: 0.1,
  },
  {
    key: 'maniac',
    label: '疯子',
    labelEn: 'maniac',
    description: '高频诈唬、大尺度、偶尔犯错，制造混乱',
    preflop: { play: 0.16, raise: 0.06, threeBet: 0.05, bluffMul: 2.2, mixRaise: 0.12, trap: -0.04, errorMul: 1.4, openRaiseBB: 0.5 },
    postflop: { bluffMul: 2.2, semiBluffMul: 1.7, valueThreshold: -0.02, callMargin: -0.02, errorMul: 1.4, sizeBias: 0.25 },
    variationRate: 0.3,
  },
  {
    key: 'balanced',
    label: '均衡',
    labelEn: 'balanced',
    description: '按基础策略打，变化来自牌局本身',
    preflop: { play: 0, raise: 0, threeBet: 0, bluffMul: 1, mixRaise: 0, trap: 0, errorMul: 1, openRaiseBB: 0 },
    postflop: { bluffMul: 1, semiBluffMul: 1, valueThreshold: 0, callMargin: 0, errorMul: 1, sizeBias: 0 },
    variationRate: 0.1,
  },
];

const STYLE_BY_KEY = new Map<BotStyleKey, BotStyle>(BOT_STYLES.map((style) => [style.key, style]));

/** 风格 id 取模后对应 BOT_STYLES 下标；未分配（undefined）返回 null（不施加风格）。 */
export function styleById(styleId: number | undefined): BotStyle | null {
  if (styleId === undefined || !Number.isFinite(styleId)) return null;
  const index = Math.abs(Math.floor(styleId)) % BOT_STYLES.length;
  return BOT_STYLES[index] ?? null;
}

export function styleLabel(styleId: number | undefined): string | null {
  return styleById(styleId)?.label ?? null;
}

export function styleLabelEn(styleId: number | undefined): string | null {
  return styleById(styleId)?.labelEn ?? null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * 把风格叠加到难度基础 profile 上。
 * 偏移量被限制在基础值附近的有限邻域内，确保难度档之间的强弱关系大体不变。
 */
export function applyStyleVariant(
  profile: DifficultyProfile,
  styleId: number | undefined,
): DifficultyProfile {
  const style = styleById(styleId);
  if (!style) return profile;
  const base = profile;
  const pre = { ...base.preflop };
  const post = { ...base.postflop };

  const play = clamp(
    base.preflop.play + style.preflop.play,
    Math.max(0.03, base.preflop.play - 0.15),
    Math.min(0.85, base.preflop.play + 0.18),
  );
  const raise = clamp(
    base.preflop.raise + style.preflop.raise,
    Math.max(play + 0.02, base.preflop.raise - 0.15),
    Math.min(0.99, base.preflop.raise + 0.12),
  );
  const threeBet = clamp(
    base.preflop.threeBet + style.preflop.threeBet,
    Math.max(raise + 0.01, base.preflop.threeBet - 0.1),
    0.995,
  );
  pre.play = round3(play);
  pre.raise = round3(raise);
  pre.threeBet = round3(threeBet);
  pre.bluffRaiseRate = round3(
    clamp(
      base.preflop.bluffRaiseRate * style.preflop.bluffMul,
      0.001,
      Math.min(0.4, Math.max(0.02, base.preflop.bluffRaiseRate * 3)),
    ),
  );
  pre.mixRaiseRate = round3(
    clamp(base.preflop.mixRaiseRate + style.preflop.mixRaise, 0, 0.6),
  );
  pre.trapRate = round3(clamp(base.preflop.trapRate + style.preflop.trap, 0, 0.3));
  pre.errorRate = round3(clamp(base.preflop.errorRate * style.preflop.errorMul, 0, 0.15));
  pre.openRaiseBB = round3(clamp(base.preflop.openRaiseBB + style.preflop.openRaiseBB, 2, 5));

  post.bluffRate = round3(
    clamp(
      base.postflop.bluffRate * style.postflop.bluffMul,
      0.001,
      Math.min(0.45, Math.max(0.03, base.postflop.bluffRate * 3)),
    ),
  );
  post.semiBluffRate = round3(
    clamp(base.postflop.semiBluffRate * style.postflop.semiBluffMul, 0, 0.6),
  );
  post.valueThreshold = round3(
    clamp(base.postflop.valueThreshold + style.postflop.valueThreshold, 0.5, 0.95),
  );
  post.callMargin = round3(
    clamp(base.postflop.callMargin + style.postflop.callMargin, -0.05, 0.2),
  );
  post.errorRate = round3(clamp(base.postflop.errorRate * style.postflop.errorMul, 0, 0.15));

  return { ...base, preflop: pre, postflop: post };
}

/** 风格化下注尺度选择：sizeBias > 0 偏好大尺度，< 0 偏好小尺度。 */
export function sampleSizeIndex(
  rng: () => number,
  sizes: readonly number[],
  styleId: number | undefined,
): number {
  if (sizes.length <= 1) return 0;
  const style = styleById(styleId);
  const bias = style?.postflop.sizeBias ?? 0;
  const weights = sizes.map((_size, index) => {
    const position = index / (sizes.length - 1);
    return Math.exp(bias * 3 * (position - 0.5));
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = rng() * total;
  for (let index = 0; index < weights.length; index++) {
    roll -= weights[index];
    if (roll <= 0) return index;
  }
  return sizes.length - 1;
}

/** 当前风格的随机化概率（按难度缩放：入门更稳、专家更爱变化）。 */
export function variationRateFor(styleId: number | undefined, difficulty: Difficulty): number {
  const style = styleById(styleId);
  const base = style?.variationRate ?? 0.1;
  const scale = difficulty === 'beginner' ? 0.5 : difficulty === 'expert' ? 0.9 : 1;
  return base * scale;
}

/** 本地机器人台词库（纯表演，不影响规则；开启「神态语句」时偶尔出现）。 */
export const LOCAL_TALK_LINES: Record<BotStyleKey, readonly string[]> = {
  tag: ['这把我来收。', '位置不错，试试。', '别乱跟，我有牌。', '再加一点？', '稳妥点好。'],
  lag: ['别怕，加注！', '你信不信我在诈唬？', '这锅我包了。', '来嘛，跟到底。', '钱不是问题，气势要足。'],
  nit: ['我只看好牌。', '算了，这手不玩。', '别看我，我牌很差。', '这次忍了。', '谨慎第一。'],
  station: ['跟一下看看。', '我还没走呢。', '万一成了呢？', '摊牌再说。', '这点钱值得看。'],
  maniac: ['全下全下！', '哈哈哈，来赌一把！', '我什么牌都敢玩。', '这局很刺激啊。', '跟不跟？不敢吧。'],
  balanced: ['正常打。', '看牌说话。', '这个赔率不错。', '位置好，可以跟。', '先看看。'],
};

/** 生成一句本地机器人台词（确定性）。 */
export function pickLocalTalk(styleId: number | undefined, ...seedParts: ReadonlyArray<string | number>): string {
  const style = styleById(styleId) ?? BOT_STYLES[BOT_STYLES.length - 1];
  const lines = LOCAL_TALK_LINES[style.key];
  const rng = derivedRng('local-talk', style.key, ...seedParts);
  const index = Math.floor(rng() * lines.length) % lines.length;
  return lines[index];
}

/** 本地机器人是否该说话：约 30% 概率（确定性）。 */
export function shouldLocalTalk(styleId: number | undefined, ...seedParts: ReadonlyArray<string | number>): boolean {
  const rng = derivedRng('local-talk-roll', styleId ?? 0, ...seedParts);
  return rng() < 0.3;
}

/** 风格英文名（大模型提示词使用；没有风格时返回 null）。 */
export function stylePromptHint(styleId: number | undefined): string | null {
  const style = styleById(styleId);
  return style ? `${style.labelEn} (${style.description})` : null;
}

export function styleByKey(key: BotStyleKey): BotStyle {
  const style = STYLE_BY_KEY.get(key);
  if (!style) throw new Error(`未知风格：${key}`);
  return style;
}

/** 供测试使用：把风格 id 转成风格 key。 */
export function styleKeyOf(styleId: number | undefined): BotStyleKey | null {
  return styleById(styleId)?.key ?? null;
}

/** 基础难度档的引用（测试辅助）。 */
export function baseProfileOf(difficulty: Difficulty): DifficultyProfile {
  return BASE_DIFFICULTY_PROFILES[difficulty];
}
