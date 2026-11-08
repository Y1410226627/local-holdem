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
  /** 策略族：决定这档是“跟注站 / 紧弱 / 紧凶 / 均衡 / 求解器”，而不是同一策略换噪声。 */
  family: 'station' | 'loose-passive' | 'tag' | 'balanced' | 'solver';
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
    family: 'station',
    style: '入门 · 跟注站：入池宽、爱看摊牌、很少主动加注、几乎不诈唬',
    preflop: {
      positionAware: false,
      play: 0.12,
      raise: 0.9,
      threeBet: 0.97,
      openRaiseBB: 2.2,
      threeBetMultiplier: 2.2,
      bluffRaiseRate: 0.01,
      mixRaiseRate: 0.05,
      trapRate: 0.02,
      errorRate: 0.02,
    },
    postflop: {
      mcIterations: 0,
      bluffRate: 0.02,
      semiBluffRate: 0.05,
      valueThreshold: 0.78,
      callMargin: -0.08,
      betSizes: [0.5],
      raiseSizes: [0.5],
      errorRate: 0.04,
      positionAware: false,
      yieldEvery: MC_YIELD_INTERVAL,
    },
  },
  normal: {
    key: 'normal',
    label: DIFFICULTY_LABELS.normal,
    family: 'loose-passive',
    style: '普通 · 松被动：位置感知、半池为主、偶尔诈唬，面对压力偏弃牌',
    preflop: {
      positionAware: true,
      play: 0.42,
      raise: 0.78,
      threeBet: 0.92,
      openRaiseBB: 3,
      threeBetMultiplier: 3,
      bluffRaiseRate: 0.05,
      mixRaiseRate: 0.1,
      trapRate: 0.04,
      errorRate: 0.01,
    },
    postflop: {
      mcIterations: 0,
      bluffRate: 0.08,
      semiBluffRate: 0.15,
      valueThreshold: 0.7,
      callMargin: 0.0,
      betSizes: [0.5, 2 / 3],
      raiseSizes: [0.5, 2 / 3],
      errorRate: 0.015,
      positionAware: true,
      yieldEvery: MC_YIELD_INTERVAL,
    },
  },
  hard: {
    key: 'hard',
    label: DIFFICULTY_LABELS.hard,
    family: 'tag',
    style: '困难 · 紧凶：蒙特卡洛胜率、听牌半诈唬、多尺度下注',
    preflop: {
      positionAware: true,
      play: 0.5,
      raise: 0.7,
      threeBet: 0.88,
      openRaiseBB: 3,
      threeBetMultiplier: 3.2,
      bluffRaiseRate: 0.12,
      mixRaiseRate: 0.2,
      trapRate: 0.06,
      errorRate: 0.005,
    },
    postflop: {
      mcIterations: 8000,
      bluffRate: 0.15,
      semiBluffRate: 0.3,
      valueThreshold: 0.64,
      callMargin: 0.03,
      betSizes: [0.5, 2 / 3, 1],
      raiseSizes: [0.5, 2 / 3, 1],
      errorRate: 0.008,
      positionAware: true,
      yieldEvery: MC_YIELD_INTERVAL,
    },
  },
  expert: {
    key: 'expert',
    label: DIFFICULTY_LABELS.expert,
    family: 'balanced',
    style: '专家 · 均衡：按街范围收窄、SPR 与多街计划、价值/诈唬平衡',
    preflop: {
      positionAware: true,
      play: 0.58,
      raise: 0.66,
      threeBet: 0.85,
      openRaiseBB: 3.2,
      threeBetMultiplier: 3.4,
      bluffRaiseRate: 0.16,
      mixRaiseRate: 0.3,
      trapRate: 0.1,
      errorRate: 0.002,
    },
    postflop: {
      mcIterations: 20000,
      bluffRate: 0.16,
      semiBluffRate: 0.38,
      valueThreshold: 0.6,
      callMargin: 0.05,
      betSizes: [0.5, 2 / 3, 1, 1.3],
      raiseSizes: [0.5, 2 / 3, 1, 1.3],
      errorRate: 0.002,
      positionAware: true,
      yieldEvery: MC_YIELD_INTERVAL,
    },
  },
};

export type AiDifficulty = Difficulty;

/** 四档基础 profile（未经训练参数覆盖，单元测试以此为基准）。 */
export const BASE_DIFFICULTY_PROFILES: Record<Difficulty, DifficultyProfile> = DIFFICULTY_PROFILES;

/** 挑战模式的中文名。 */
export const CHALLENGE_MODE_LABEL = '挑战宗师';

/**
 * 挑战模式（宗师 / Alpha 级）基础 profile：
 * 比专家档更重的范围建模、读下注细节与计时、EV 极化下注与强施压。
 * 不参与四档训练（训练仍只覆盖基础四档），挑战模式在此基础值上叠加宗师原型。
 */
export const CHALLENGE_PROFILE: DifficultyProfile = {
  // 复用 expert 的 key 以兼容现有 DifficultyProfile 类型；挑战模式通过 options.challenge 开启。
  key: 'expert',
  label: CHALLENGE_MODE_LABEL,
  family: 'solver',
  style: '挑战 · 单挑 CFR+ 蓝图/子博弈 + 多人按街范围与谨慎',
  preflop: {
    // 底座与专家档一致：挑战档的增量是「BB 翻前蓝图 + 河牌 CFR 子博弈」，
    // 不是一套更激进但更漏的阈值。旧版挑战启发式单独跑比专家弱（v0.12.2 已证明）。
    positionAware: true,
    play: 0.58,
    raise: 0.66,
    threeBet: 0.85,
    openRaiseBB: 3.2,
    threeBetMultiplier: 3.4,
    bluffRaiseRate: 0.16,
    mixRaiseRate: 0.3,
    trapRate: 0.1,
    errorRate: 0.002,
  },
  postflop: {
    // 蒙特卡洛比专家档多 50%：这一项只会让胜率估计更准，不会让策略更松。
    mcIterations: 30000,
    // 诈唬率 / 跟注余量必须与专家档**完全一致**。
    //
    // 旧值是 0.18 / 0.04（比专家档 0.16 / 0.05 更松），这是对着跟注站调出来的：
    // 对跟注站，诈唬多一点也不亏（他反正不弃）、边缘牌多跟一点也赚。
    // 但对会思考的对手，这两条都是纯漏洞。
    //
    // 实测（挑战 vs 专家，2800 局逐层消融）：
    //   三层增量（翻前蓝图 + 转河求解器 + 剥削层）合计贡献约 +66 BB/100，
    //   但净值只有 +1.8——差额正是被这两个松参数吃掉的。
    //   挑战档的定位应该是「专家档 + 三层增量」，不是「另一套更激进的参数」。
    bluffRate: 0.16,
    semiBluffRate: 0.38,
    valueThreshold: 0.6,
    callMargin: 0.05,
    betSizes: [0.5, 2 / 3, 1, 1.3],
    raiseSizes: [0.5, 2 / 3, 1, 1.3],
    errorRate: 0.002,
    positionAware: true,
    yieldEvery: MC_YIELD_INTERVAL,
  },
};

/** 挑战模式基础档位（训练参数不覆盖；宗师原型在 aiPlayer 中再叠加）。 */
export function getChallengeProfile(): DifficultyProfile {
  return CHALLENGE_PROFILE;
}

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
