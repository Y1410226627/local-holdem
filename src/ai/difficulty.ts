/**
 * 四档 AI 难度的参数档位。
 *
 * 注意：这里的参数不是“同一套逻辑换数字”，而是为 aiPlayer.ts 中四段独立的
 * 决策分支提供各自需要的常量：
 * - beginner：纯翻牌前查表 + 牌型强度规则，不感知位置；
 * - normal：起手牌范围 + 位置阈值 + 牌力/底池赔率；
 * - hard：蒙特卡洛胜率 + 听牌半诈唬 + 多尺度；
 * - expert：范围收窄 + SPR / 多街计划 + 更平衡的极化下注。
 *
 * 值为 0..1 的强度阈值均以 rangeModel.ts 的 preflopStrength（加权百分位）为准。
 */
import type { Difficulty } from '../game/types';
import { DIFFICULTY_LABELS } from '../game/types';
import { isLearnedProfilesEnabled, learnedProfilesData, mergeProfile } from './learnedProfiles';

export interface PreflopProfile {
  /** 是否根据位置调整阈值；beginner 为 false（入门 AI 不看位置）。 */
  positionAware: boolean;
  /** 入池（跟注 / 过牌）的最低起手牌强度。 */
  play: number;
  /** 主动开池加注的最低强度。 */
  raise: number;
  /** 面对加注时再加注（3-bet）的最低强度。 */
  threeBet: number;
  /** 开池加注尺度：大盲的倍数。 */
  openRaiseBB: number;
  /** 面对加注时 3-bet 的尺度：当前下注的倍数。 */
  threeBetMultiplier: number;
  /** 用弱牌偷加注的频率（翻牌前诈唬）。 */
  bluffRaiseRate: number;
  /** 中等牌混合加注的频率（平衡打法）。 */
  mixRaiseRate: number;
  /** 超强牌偶尔只跟注（慢玩）的频率。 */
  trapRate: number;
  /** 随机失误率。 */
  errorRate: number;
}

export interface PostflopProfile {
  /** 蒙特卡洛迭代次数；0 表示该难度不使用蒙特卡洛。 */
  mcIterations: number;
  /** 无人下注时纯诈唬的频率。 */
  bluffRate: number;
  /** 有听牌时半诈唬的频率。 */
  semiBluffRate: number;
  /** 价值下注所需的最低胜率（hard / expert）。 */
  valueThreshold: number;
  /** 跟注时要求在底池赔率之上多出的安全边际。 */
  callMargin: number;
  /** 下注尺度（底池倍数），按难度从少到多。 */
  betSizes: readonly number[];
  /** 加注尺度（底池倍数）。 */
  raiseSizes: readonly number[];
  /** 随机失误率。 */
  errorRate: number;
  /** 翻牌后是否利用位置信息。 */
  positionAware: boolean;
  /** 蒙特卡洛每多少次迭代让出一次主线程。 */
  yieldEvery: number;
}

export interface DifficultyProfile {
  key: Difficulty;
  /** 中文难度名。 */
  label: string;
  /** 人机风格简述（中文），会写入 AIDebugInfo.profile。 */
  style: string;
  preflop: PreflopProfile;
  postflop: PostflopProfile;
}

/** hard / expert 蒙特卡洛让出主线程的默认间隔。 */
export const MC_YIELD_INTERVAL = 2000;

export const DIFFICULTY_PROFILES: Record<Difficulty, DifficultyProfile> = {
  beginner: {
    key: 'beginner',
    label: DIFFICULTY_LABELS.beginner,
    style: '入门 · 松被动查表：大量跟注、极少加注、几乎不诈唬',
    preflop: {
      positionAware: false,
      play: 0.12,
      raise: 0.95,
      threeBet: 0.99,
      openRaiseBB: 2.2,
      threeBetMultiplier: 2.2,
      bluffRaiseRate: 0.005,
      mixRaiseRate: 0,
      trapRate: 0,
      errorRate: 0.03,
    },
    postflop: {
      mcIterations: 0,
      bluffRate: 0.005,
      semiBluffRate: 0,
      valueThreshold: 0.86,
      callMargin: 0.12,
      betSizes: [0.33],
      raiseSizes: [0.33],
      errorRate: 0.06,
      positionAware: false,
      yieldEvery: MC_YIELD_INTERVAL,
    },
  },
  normal: {
    key: 'normal',
    label: DIFFICULTY_LABELS.normal,
    style: '普通 · 位置感知范围表：半池为主、偶尔诈唬',
    preflop: {
      positionAware: true,
      play: 0.42,
      raise: 0.72,
      threeBet: 0.9,
      openRaiseBB: 3,
      threeBetMultiplier: 3,
      bluffRaiseRate: 0.06,
      mixRaiseRate: 0.1,
      trapRate: 0.04,
      errorRate: 0.02,
    },
    postflop: {
      mcIterations: 0,
      bluffRate: 0.07,
      semiBluffRate: 0.12,
      valueThreshold: 0.72,
      callMargin: 0.02,
      betSizes: [0.5],
      raiseSizes: [0.5],
      errorRate: 0.02,
      positionAware: true,
      yieldEvery: MC_YIELD_INTERVAL,
    },
  },
  hard: {
    key: 'hard',
    label: DIFFICULTY_LABELS.hard,
    style: '困难 · 蒙特卡洛胜率：听牌半诈唬、多尺度下注',
    preflop: {
      positionAware: true,
      play: 0.5,
      raise: 0.68,
      threeBet: 0.87,
      openRaiseBB: 3,
      threeBetMultiplier: 3.2,
      bluffRaiseRate: 0.09,
      mixRaiseRate: 0.18,
      trapRate: 0.06,
      errorRate: 0.01,
    },
    postflop: {
      mcIterations: 8000,
      bluffRate: 0.12,
      semiBluffRate: 0.3,
      valueThreshold: 0.64,
      callMargin: 0.03,
      betSizes: [0.5, 2 / 3, 1],
      raiseSizes: [0.5, 2 / 3, 1],
      errorRate: 0.01,
      positionAware: true,
      yieldEvery: MC_YIELD_INTERVAL,
    },
  },
  expert: {
    key: 'expert',
    label: DIFFICULTY_LABELS.expert,
    style: '专家 · 范围收窄与 SPR：多街计划、价值/诈唬平衡',
    preflop: {
      positionAware: true,
      play: 0.58,
      raise: 0.66,
      threeBet: 0.85,
      openRaiseBB: 3.2,
      threeBetMultiplier: 3.4,
      bluffRaiseRate: 0.14,
      mixRaiseRate: 0.3,
      trapRate: 0.1,
      errorRate: 0.005,
    },
    postflop: {
      mcIterations: 20000,
      bluffRate: 0.16,
      semiBluffRate: 0.38,
      valueThreshold: 0.6,
      callMargin: 0.05,
      betSizes: [0.5, 2 / 3, 1, 1.3],
      raiseSizes: [0.5, 2 / 3, 1, 1.3],
      errorRate: 0.005,
      positionAware: true,
      yieldEvery: MC_YIELD_INTERVAL,
    },
  },
};

export type AiDifficulty = Difficulty;

/** 四档基础 profile（未经训练参数覆盖，单元测试以此为基准）。 */
export const BASE_DIFFICULTY_PROFILES: Record<Difficulty, DifficultyProfile> = DIFFICULTY_PROFILES;

/**
 * 获取某难度的难度档位。
 * @param useLearned 是否叠加训练参数；默认跟随全局开关（UI 设置「使用训练后参数」）。
 */
export function getDifficultyProfile(
  difficulty: Difficulty,
  useLearned: boolean = isLearnedProfilesEnabled(),
): DifficultyProfile {
  const base = DIFFICULTY_PROFILES[difficulty];
  if (!useLearned) return base;
  const override = learnedProfilesData.profiles?.[difficulty];
  if (!override || Object.keys(override).length === 0) return base;
  return mergeProfile(base, override);
}

/** 四档 profile 的稳定签名，便于测试 / 调试确认参数确实不同。 */
export function profileSignature(profile: DifficultyProfile): string {
  return [
    profile.key,
    profile.postflop.mcIterations,
    profile.postflop.bluffRate,
    profile.postflop.betSizes.join(','),
    profile.preflop.play,
    profile.preflop.raise,
  ].join('|');
}
