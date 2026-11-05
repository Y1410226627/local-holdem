/**
 * 自博弈训练脚本（纯本地、确定性、零网络）。
 *
 * 功能：
 * 1. 4 人桌自博弈：全部本地 AI，盲注 10/20、起始筹码 1000；每手按钮顺时针轮转，
 *    hero 座位逐手轮转以平均位置影响。每手最多 500 个动作，筹码低于大盲时自动
 *    re-buy 到 1000（在报告中说明）。
 * 2. 参数进化：四档难度分别做 hill climbing。每轮先评估当前基准，再生成若干变异
 *    候选；候选与基准使用同一 seed 序列做配对评估，接受拟合提升 > 0.5 BB/100 且验证集不回落的最优
 *    候选。训练参数始终通过 `decide(..., { profileOverride })` 显式传入，不依赖
 *    全局 learned 开关。
 *    多核机器上（轮数 >= 2）自动启用 worker_threads 并行池：4 档同时进化，
 *    每轮的基准 + 候选、验证对、最终对照都并发提交；每个评估仍有独立固定 seed，
 *    并行结果与单线程完全一致。`--workers=N` 可指定并发数，`--workers=0` /
 *    `--no-parallel` 可强制单线程。
 * 3. 大模型机器人训练数据：训练结束后跑一段 exhibition 自博弈，收集 hard / expert
 *    座位的合法决策，生成两类产物：
 *    - `src/ai/data/llm-experience.json`：few-shot 经验库（LlmExperienceFile 接口不变）；
 *    - `training/llm-sft-dataset.jsonl`：OpenAI messages 格式的 SFT 数据集，供本地
 *      微调工具（llama.cpp / LlamaFactory 等）可选使用，本项目不自动微调。
 * 4. 写入 `src/ai/data/learnedProfiles.json`、`src/ai/data/llm-experience.json`、
 *    `training/llm-sft-dataset.jsonl` 与 `training/REPORT.md`。
 *
 * 运行：
 *   npm run train:quick   # 25 手 / 1 轮 / 2 变异 / 40 手展示 / MC 60（单线程）
 *   npm run train         # 60 手 / 2 轮 / 3 变异 / 120 手展示 / MC 120（自动并行）
 *   npm run train -- --rounds=20                  # 想跑多少轮就输入多少轮
 *   npm run train -- --rounds=20 --workers=16     # 指定 worker 数
 *   npm run train -- --rounds=20 --workers=0      # 强制单线程
 *   npx tsx scripts/train.ts --seed=my-seed --hands=40 ...
 *
 * 说明：
 * - 洗牌与 AI 随机源全部来自 seed，不使用 Math.random；并行 worker 只会改变
 *   任务调度顺序，不会改变每个评估的随机序列，因此同一 seed 可复现。
 * - 本文件被单元测试 import 时不会自动开始训练（见文件底部守卫）；同一个文件
 *   在 HOLDEM_TRAIN_WORKER=1 时作为 worker 入口，只处理评估任务。
 * - 脚本位于 `scripts/`，Node 内置模块通过动态 import 加载；项目 tsconfig
 *   include 仅包含 src，但测试会 import 本文件，因此这里不依赖 @types/node。
 */
import type {
  Card,
  Difficulty,
  HandState,
  LegalActions,
  PlayerAction,
  Street,
} from '../src/game/types';
import { DIFFICULTY_LABELS, DIFFICULTY_ORDER } from '../src/game/types';
import { cardLabel, hashString, mulberry32 } from '../src/game/cards';
import { createHand, getLegalActions, playAction } from '../src/game/gameEngine';
import { buildPlayerView, type PlayerView } from '../src/game/playerView';
import { decide, fallbackAction, isActionLegal, type AIDecision } from '../src/ai/aiPlayer';
import {
  BASE_DIFFICULTY_PROFILES,
  getDifficultyProfile,
  type DifficultyProfile,
} from '../src/ai/difficulty';
import {
  hasLearnedProfiles,
  type DifficultyProfileOverride,
  type LearnedProfilesFile,
} from '../src/ai/learnedProfiles';
import { POSITION_LABELS, positionOf, type Position } from '../src/ai/rangeModel';
import type { LlmExample, LlmExperienceFile } from '../src/ai/llmBot';

/* ------------------------------------------------------------------ */
/* Node 运行时最小声明（避免依赖 @types/node）                          */
/* ------------------------------------------------------------------ */

declare const process: {
  argv: string[];
  /** tsx / Node 的启动参数；worker 线程需要继承 TypeScript loader。 */
  execArgv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
};

interface NodeFsModule {
  writeFileSync(path: string, data: string, encoding: string): void;
  mkdirSync(path: string, options: { recursive: boolean }): void;
}

/** 通过变量说明符动态加载 node:fs，避免 TypeScript 解析 Node 类型。 */
async function loadFs(): Promise<NodeFsModule> {
  const moduleName = 'node:fs';
  const imported = (await import(/* @vite-ignore */ moduleName)) as unknown;
  return imported as NodeFsModule;
}

/* ------------------------------------------------------------------ */
/* 常量与类型                                                          */
/* ------------------------------------------------------------------ */

export const TRAIN_PLAYER_COUNT = 4;
export const TRAIN_STARTING_STACK = 1000;
export const TRAIN_SMALL_BLIND = 10;
export const TRAIN_BIG_BLIND = 20;
export const MAX_ACTIONS_PER_HAND = 500;
/** 单次训练轮数上限：本机 16 核约 30 分钟；更大规模请分多次训练（参数会继续累积）。 */
export const MAX_TRAIN_ROUNDS = 10000;
export const MAX_EXPERIENCE_EXAMPLES = 160;
/** SFT 数据集最多行数；样本不足时按实际数量输出。 */
export const MAX_SFT_EXAMPLES = 400;
/** SFT 中翻牌前样本上限：避免大量弃牌样本占满数据集，同时减小文件体积。 */
export const MAX_SFT_PREFLOP_EXAMPLES = 60;
export const DEFAULT_TRAIN_SEED = 'local-selfplay-v1';

const EPSILON = 1e-9;
const POSTFLOP_STREETS: readonly Street[] = ['flop', 'turn', 'river'];

const MUTABLE_FIELDS: readonly MutableField[] = [
  'preflop.play',
  'preflop.raise',
  'preflop.threeBet',
  'preflop.bluffRaiseRate',
  'preflop.mixRaiseRate',
  'preflop.trapRate',
  'postflop.bluffRate',
  'postflop.semiBluffRate',
  'postflop.valueThreshold',
  'postflop.callMargin',
];

/** 可变异字段（只包含需求允许调整的数值字段）。 */
export type MutableField =  | 'preflop.play'
  | 'preflop.raise'
  | 'preflop.threeBet'
  | 'preflop.bluffRaiseRate'
  | 'preflop.mixRaiseRate'
  | 'preflop.trapRate'
  | 'postflop.bluffRate'
  | 'postflop.semiBluffRate'
  | 'postflop.valueThreshold'
  | 'postflop.callMargin';

/** 入门档入池线边界：保持“松被动”的风格，不允许训练成紧手。 */
const PLAY_BOUNDS: Record<Difficulty, readonly [number, number]> = {
  beginner: [0.05, 0.30],
  normal: [0.25, 0.65],
  hard: [0.35, 0.72],
  expert: [0.42, 0.78],
};

const BLUFF_RATE_BOUNDS: Record<Difficulty, readonly [number, number]> = {
  beginner: [0, 0.03],
  normal: [0, 0.20],
  hard: [0.02, 0.35],
  expert: [0.05, 0.40],
};

const SEMI_BLUFF_BOUNDS: Record<Difficulty, readonly [number, number]> = {
  beginner: [0, 0.05],
  normal: [0.05, 0.30],
  hard: [0.15, 0.60],
  expert: [0.20, 0.70],
};

/**
 * raise 的实际上限取 0.975 而非 0.98：threeBet 需要 >= raise + 0.02 且 <= 0.995，
 * 0.975 + 0.02 = 0.995 恰好可达。
 */
const EFFECTIVE_RAISE_MAX = 0.975;

export interface TrainOptions {
  quick: boolean;
  seed: string;
  hands: number;
  rounds: number;
  mutations: number;
  exhibition: number;
  mcIterations: number;
  /**
   * 并行评估 worker 数：undefined = 自动（多核时启用），0 = 强制单线程，
   * 正整数 = 指定 worker 数。最大实际使用数受 CPU 核数与 16 的上限限制。
   */
  workers?: number;
}

const FULL_DEFAULTS = {
  seed: DEFAULT_TRAIN_SEED,
  hands: 60,
  rounds: 2,
  mutations: 3,
  exhibition: 120,
  mcIterations: 120,
} as const;

const QUICK_DEFAULTS = {
  seed: DEFAULT_TRAIN_SEED,
  hands: 25,
  rounds: 1,
  mutations: 2,
  exhibition: 40,
  mcIterations: 60,
} as const;

export interface SelfPlaySeat {
  difficulty: Difficulty;
  profile: DifficultyProfile;
}

export interface SelfPlayOptions {
  hands: number;
  mcIterations: number;
  seed: string;
  /** 每手返回 4 个座位（难度 + 参数）。 */
  seatsForHand: (handIndex: number, handNo: number) => readonly SelfPlaySeat[];
  /** 每手 hero 座位；undefined 表示不做 hero 收益统计。 */
  heroSeatForHand?: (handIndex: number, handNo: number) => number | null;
  /** 每手需要收集经验样本的座位下标。 */
  sampleSeatsForHand?: (handIndex: number, handNo: number) => readonly number[];
  /** 每手最多收集多少条样本（1-2 条）。 */
  maxSamplesPerHand?: number;
  /** 整批最多收集多少条样本；默认 MAX_EXPERIENCE_EXAMPLES，SFT 可放宽到 400。 */
  maxSamplesTotal?: number;
  startingStack?: number;
  smallBlind?: number;
  bigBlind?: number;
}

export interface SelfPlayResult {
  hands: number;
  /** hero 净筹码收益（不含 re-buy 注入的筹码）。 */
  netChips: number;
  /** hero 每 100 手净收益（BB/100）。 */
  bb100: number;
  actions: number;
  fallbackActions: number;
  rebuys: number;
  abortedHands: number;
  samples: ExperienceDecisionSample[];
}

export interface EvaluateCandidateOptions {
  difficulty: Difficulty;
  /** 被评估的参数（hero 使用）。 */
  profile: DifficultyProfile;
  /** 对手参数；默认使用该难度的基础档位。 */
  opponentProfile?: DifficultyProfile;
  hands?: number;
  mcIterations?: number;
  seed?: string;
  heroSeat?: number;
  startingStack?: number;
  smallBlind?: number;
  bigBlind?: number;
}

/** 评估执行器：默认在进程内跑；训练主流程可注入 worker 池实现并行。 */
export type EvaluationRunner = (
  options: EvaluateCandidateOptions,
) => Promise<SelfPlayResult>;

export interface ProfileDiff {
  field: string;
  before: number;
  after: number;
}

export interface CandidateLog {
  index: number;
  bb100: number;
  deltaBB100: number;
  diff: ProfileDiff[];
  accepted: boolean;
}

export interface RoundLog {
  round: number;
  evalSeed: string;
  baseBB100: number;
  candidates: CandidateLog[];
  accepted: boolean;
  acceptedIndex: number | null;
  /** 拟合集最优候选的 Δ（BB/100）；用于精简报告统计。 */
  bestDeltaBB100?: number;
  /** 验证集 Δ；未运行验证为 null。 */
  validationDeltaBB100?: number | null;
  /** 拟合达标但验证集回落（被拦截）。 */
  validationRejected?: boolean;
}

export interface DifficultyTrainingResult {
  difficulty: Difficulty;
  startProfile: DifficultyProfile;
  finalProfile: DifficultyProfile;
  /** 最终对照评估：起始参数 vs 基础档位对手。 */
  baselineBB100: number;
  /** 最终对照评估：训练后参数 vs 基础档位对手。 */
  trainedBB100: number;
  acceptedMutations: number;
  handsPlayed: number;
  rounds: RoundLog[];
}

export interface DifficultyMetric {
  baselineBB100: number;
  trainedBB100: number;
  acceptedMutations: number;
  rounds: number;
  hands: number;
}

/** 一条待转换的决策样本（只含公开信息 + 自己的底牌）。 */
export interface ExperienceDecisionSample {
  street: Street;
  position: Position;
  hole: readonly Card[];
  board: readonly Card[];
  pot: number;
  currentBet: number;
  callAmount: number;
  facingBet: boolean;
  action: PlayerAction;
  equity?: number;
  reasoning: string;
  /** 决策时的合法动作集合（自博弈时记录，供 SFT 用户消息使用真实合法动作）。 */
  legal?: LegalActions;
  /** 座位难度（自博弈时记录；SFT 只保留 hard / expert 决策）。 */
  difficulty?: Difficulty;
  /** 自己的剩余筹码（可选，仅用于 SFT 用户消息）。 */
  stack?: number;
  /** 桌上人数（可选，仅用于 SFT 用户消息）。 */
  playerCount?: number;
}

/* ------------------------------------------------------------------ */
/* 通用辅助                                                            */
/* ------------------------------------------------------------------ */

function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function round3(value: number): number {
  return roundTo(value, 3);
}

function formatBB100(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  const normalized = Math.abs(value) < 0.005 ? 0 : value;
  return `${normalized >= 0 ? '+' : ''}${normalized.toFixed(2)}`;
}

function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return 'n/a';
  const normalized = Math.abs(value) < 0.005 ? 0 : value;
  return normalized.toFixed(digits);
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)} 秒`;
}

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const result = items.slice();
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(rng() * (index + 1));
    const temp = result[index];
    result[index] = result[swapIndex];
    result[swapIndex] = temp;
  }
  return result;
}

export function cloneProfile(profile: DifficultyProfile): DifficultyProfile {
  return {
    ...profile,
    preflop: { ...profile.preflop },
    postflop: {
      ...profile.postflop,
      betSizes: profile.postflop.betSizes.slice(),
      raiseSizes: profile.postflop.raiseSizes.slice(),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 参数边界、变异与 diff                                                */
/* ------------------------------------------------------------------ */

function readMutableField(profile: DifficultyProfile, field: MutableField): number {
  switch (field) {
    case 'preflop.play':
      return profile.preflop.play;
    case 'preflop.raise':
      return profile.preflop.raise;
    case 'preflop.threeBet':
      return profile.preflop.threeBet;
    case 'preflop.bluffRaiseRate':
      return profile.preflop.bluffRaiseRate;
    case 'preflop.mixRaiseRate':
      return profile.preflop.mixRaiseRate;
    case 'preflop.trapRate':
      return profile.preflop.trapRate;
    case 'postflop.bluffRate':
      return profile.postflop.bluffRate;
    case 'postflop.semiBluffRate':
      return profile.postflop.semiBluffRate;
    case 'postflop.valueThreshold':
      return profile.postflop.valueThreshold;
    case 'postflop.callMargin':
      return profile.postflop.callMargin;
    default:
      return 0;
  }
}

function writeMutableField(profile: DifficultyProfile, field: MutableField, value: number): void {
  switch (field) {
    case 'preflop.play':
      profile.preflop.play = value;
      break;
    case 'preflop.raise':
      profile.preflop.raise = value;
      break;
    case 'preflop.threeBet':
      profile.preflop.threeBet = value;
      break;
    case 'preflop.bluffRaiseRate':
      profile.preflop.bluffRaiseRate = value;
      break;
    case 'preflop.mixRaiseRate':
      profile.preflop.mixRaiseRate = value;
      break;
    case 'preflop.trapRate':
      profile.preflop.trapRate = value;
      break;
    case 'postflop.bluffRate':
      profile.postflop.bluffRate = value;
      break;
    case 'postflop.semiBluffRate':
      profile.postflop.semiBluffRate = value;
      break;
    case 'postflop.valueThreshold':
      profile.postflop.valueThreshold = value;
      break;
    case 'postflop.callMargin':
      profile.postflop.callMargin = value;
      break;
    default:
      break;
  }
}

function boundsForField(
  profile: DifficultyProfile,
  difficulty: Difficulty,
  field: MutableField,
): { min: number; max: number; stepMin: number; stepMax: number } {
  switch (field) {
    case 'preflop.play': {
      const [min, max] = PLAY_BOUNDS[difficulty];
      return { min, max, stepMin: 0.04, stepMax: 0.08 };
    }
    case 'preflop.raise':
      return {
        min: profile.preflop.play + 0.05,
        max: EFFECTIVE_RAISE_MAX,
        stepMin: 0.03,
        stepMax: 0.07,
      };
    case 'preflop.threeBet':
      return {
        min: profile.preflop.raise + 0.02,
        max: 0.995,
        stepMin: 0.01,
        stepMax: 0.04,
      };
    case 'preflop.bluffRaiseRate':
      return { min: 0, max: 0.30, stepMin: 0.01, stepMax: 0.04 };
    case 'preflop.mixRaiseRate':
      return { min: 0, max: 0.5, stepMin: 0.02, stepMax: 0.06 };
    case 'preflop.trapRate':
      return { min: 0, max: 0.25, stepMin: 0.01, stepMax: 0.04 };
    case 'postflop.bluffRate': {
      const [min, max] = BLUFF_RATE_BOUNDS[difficulty];
      return { min, max, stepMin: 0.01, stepMax: 0.03 };
    }
    case 'postflop.semiBluffRate': {
      const [min, max] = SEMI_BLUFF_BOUNDS[difficulty];
      return { min, max, stepMin: 0.02, stepMax: 0.05 };
    }
    case 'postflop.valueThreshold':
      return { min: 0.50, max: 0.92, stepMin: 0.02, stepMax: 0.05 };
    case 'postflop.callMargin':
      return { min: 0, max: 0.12, stepMin: 0.01, stepMax: 0.03 };
    default:
      return { min: 0, max: 0, stepMin: 0.01, stepMax: 0.02 };
  }
}

/** 把 profile 的数值字段夹到合法范围，并修复 play <= raise <= threeBet 的层级关系。 */
function clampProfileBounds(profile: DifficultyProfile, difficulty: Difficulty): void {
  const playBounds = PLAY_BOUNDS[difficulty];
  profile.preflop.play = round3(
    clampValue(profile.preflop.play, playBounds[0], playBounds[1]),
  );
  profile.preflop.raise = round3(
    clampValue(profile.preflop.raise, profile.preflop.play + 0.05, EFFECTIVE_RAISE_MAX),
  );
  profile.preflop.threeBet = round3(
    clampValue(profile.preflop.threeBet, profile.preflop.raise + 0.02, 0.995),
  );
  profile.preflop.bluffRaiseRate = round3(
    clampValue(profile.preflop.bluffRaiseRate, 0, 0.30),
  );
  profile.preflop.mixRaiseRate = round3(clampValue(profile.preflop.mixRaiseRate, 0, 0.5));
  profile.preflop.trapRate = round3(clampValue(profile.preflop.trapRate, 0, 0.25));
  profile.postflop.bluffRate = round3(
    clampValue(profile.postflop.bluffRate, ...BLUFF_RATE_BOUNDS[difficulty]),
  );
  profile.postflop.semiBluffRate = round3(
    clampValue(profile.postflop.semiBluffRate, ...SEMI_BLUFF_BOUNDS[difficulty]),
  );
  profile.postflop.valueThreshold = round3(
    clampValue(profile.postflop.valueThreshold, 0.5, 0.92),
  );
  profile.postflop.callMargin = round3(clampValue(profile.postflop.callMargin, 0, 0.12));
}

export interface MutateProfileOptions {
  /** 不参与变异的字段（仍会被夹回合法边界）。 */
  frozenFields?: readonly MutableField[];
}

/**
 * 生成一个变异候选：随机挑选 1-3 个可变异字段，各按随机步长做 ± 调整，
 * 最后夹回合法边界。mcIterations / betSizes / raiseSizes / errorRate /
 * positionAware / style / label 等字段保持不变。
 *
 * @param seed 字符串或现成 rng；同一种子结果完全一致。
 * @param options 可冻结部分字段（例如入门档的入池线）。
 */
export function mutateProfile(
  base: DifficultyProfile,
  difficulty: Difficulty,
  seed: string | (() => number) = 'mutation',
  options: MutateProfileOptions = {},
): DifficultyProfile {
  const rng = typeof seed === 'function' ? seed : mulberry32(hashString(seed));
  const frozen = new Set<MutableField>(options.frozenFields ?? []);
  const profile = cloneProfile(base);
  clampProfileBounds(profile, difficulty);
  const original = cloneProfile(profile);

  const fields = shuffled(
    MUTABLE_FIELDS.filter((field) => !frozen.has(field)),
    rng,
  );
  const targetCount = 1 + Math.floor(rng() * 3);
  let changed = 0;

  for (const field of fields) {
    if (changed >= targetCount) break;
    const before = readMutableField(profile, field);
    const { min, max, stepMin, stepMax } = boundsForField(profile, difficulty, field);
    if (max + EPSILON < min) continue;

    const step = stepMin + rng() * (stepMax - stepMin);
    let direction = rng() < 0.5 ? -1 : 1;
    let next = clampValue(round3(before + direction * step), min, max);
    if (Math.abs(next - before) < EPSILON) {
      direction = -direction;
      next = clampValue(round3(before + direction * step), min, max);
    }
    if (Math.abs(next - before) < EPSILON) {
      // 正好卡在边界：取区间另一端（宽度为 0 的字段会被上面的判断跳过）。
      next = clampValue(round3(before <= (min + max) / 2 ? max : min), min, max);
    }
    if (Math.abs(next - before) < EPSILON) continue;

    writeMutableField(profile, field, next);
    clampProfileBounds(profile, difficulty);
    if (Math.abs(readMutableField(profile, field) - before) > EPSILON) changed++;
  }

  // 极端情况下（字段范围退化）至少保证与原参数有一个字段不同。
  if (diffProfile(original, profile).length === 0) {
    for (const field of MUTABLE_FIELDS) {
      if (frozen.has(field)) continue;
      const before = readMutableField(profile, field);
      const { min, max } = boundsForField(profile, difficulty, field);
      if (max + EPSILON < min) continue;
      const step = Math.min(0.04, Math.max(0.01, (max - min) / 2));
      const direction = before <= (min + max) / 2 ? 1 : -1;
      const next = clampValue(round3(before + direction * step), min, max);
      if (Math.abs(next - before) < EPSILON) continue;
      writeMutableField(profile, field, next);
      clampProfileBounds(profile, difficulty);
      break;
    }
  }

  return profile;
}

/** 返回两个 profile 在可变异字段上的差异（按字段固定顺序）。 */
export function diffProfile(
  before: DifficultyProfile,
  after: DifficultyProfile,
): ProfileDiff[] {
  const diffs: ProfileDiff[] = [];
  for (const field of MUTABLE_FIELDS) {
    const previous = readMutableField(before, field);
    const current = readMutableField(after, field);
    if (Math.abs(previous - current) > EPSILON) {
      diffs.push({ field, before: previous, after: current });
    }
  }
  return diffs;
}

/** 校验 profile 是否满足训练允许的全部边界；返回人类可读的问题列表。 */
export function validateProfileBounds(
  profile: DifficultyProfile,
  difficulty: Difficulty,
): string[] {
  const issues: string[] = [];
  const play = profile.preflop.play;
  const raise = profile.preflop.raise;
  const threeBet = profile.preflop.threeBet;
  const [playMin, playMax] = PLAY_BOUNDS[difficulty];
  const [bluffMin, bluffMax] = BLUFF_RATE_BOUNDS[difficulty];
  const [semiMin, semiMax] = SEMI_BLUFF_BOUNDS[difficulty];

  if (play < playMin - EPSILON || play > playMax + EPSILON) {
    issues.push(`preflop.play=${play} 超出 [${playMin}, ${playMax}]`);
  }
  if (raise < play + 0.05 - EPSILON) {
    issues.push(`preflop.raise=${raise} 小于 play+0.05`);
  }
  if (raise > 0.98 + EPSILON) {
    issues.push(`preflop.raise=${raise} 大于 0.98`);
  }
  if (threeBet < raise + 0.02 - EPSILON) {
    issues.push(`preflop.threeBet=${threeBet} 小于 raise+0.02`);
  }
  if (threeBet > 0.995 + EPSILON) {
    issues.push(`preflop.threeBet=${threeBet} 大于 0.995`);
  }
  if (
    profile.preflop.bluffRaiseRate < -EPSILON ||
    profile.preflop.bluffRaiseRate > 0.30 + EPSILON
  ) {
    issues.push(`preflop.bluffRaiseRate=${profile.preflop.bluffRaiseRate} 超出 [0, 0.30]`);
  }
  if (
    profile.preflop.mixRaiseRate < -EPSILON ||
    profile.preflop.mixRaiseRate > 0.5 + EPSILON
  ) {
    issues.push(`preflop.mixRaiseRate=${profile.preflop.mixRaiseRate} 超出 [0, 0.5]`);
  }
  if (profile.preflop.trapRate < -EPSILON || profile.preflop.trapRate > 0.25 + EPSILON) {
    issues.push(`preflop.trapRate=${profile.preflop.trapRate} 超出 [0, 0.25]`);
  }
  if (
    profile.postflop.bluffRate < bluffMin - EPSILON ||
    profile.postflop.bluffRate > bluffMax + EPSILON
  ) {
    issues.push(
      `postflop.bluffRate=${profile.postflop.bluffRate} 超出 [${bluffMin}, ${bluffMax}]`,
    );
  }
  if (
    profile.postflop.semiBluffRate < semiMin - EPSILON ||
    profile.postflop.semiBluffRate > semiMax + EPSILON
  ) {
    issues.push(
      `postflop.semiBluffRate=${profile.postflop.semiBluffRate} 超出 [${semiMin}, ${semiMax}]`,
    );
  }
  if (
    profile.postflop.valueThreshold < 0.5 - EPSILON ||
    profile.postflop.valueThreshold > 0.92 + EPSILON
  ) {
    issues.push(
      `postflop.valueThreshold=${profile.postflop.valueThreshold} 超出 [0.5, 0.92]`,
    );
  }
  if (
    profile.postflop.callMargin < -EPSILON ||
    profile.postflop.callMargin > 0.12 + EPSILON
  ) {
    issues.push(`postflop.callMargin=${profile.postflop.callMargin} 超出 [0, 0.12]`);
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* LLM 经验样本                                                        */
/* ------------------------------------------------------------------ */

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function toLlmExample(sample: ExperienceDecisionSample): LlmExample | null {
  if (!sample || typeof sample !== 'object') return null;
  if (!POSTFLOP_STREETS.includes(sample.street) && sample.street !== 'preflop') return null;
  if (!(sample.position in POSITION_LABELS)) return null;
  if (!Array.isArray(sample.hole) || sample.hole.length !== 2) return null;
  if (!Array.isArray(sample.board)) return null;
  if (![0, 3, 4, 5].includes(sample.board.length)) return null;
  if (!isFiniteNonNegative(sample.pot)) return null;
  if (!isFiniteNonNegative(sample.currentBet)) return null;
  if (!isFiniteNonNegative(sample.callAmount)) return null;

  const action = sample.action;
  if (!action || typeof action !== 'object') return null;
  if (!['fold', 'check', 'call', 'bet', 'raise', 'allin'].includes(action.type)) {
    return null;
  }

  let amount: number | undefined;
  if (action.type === 'bet' || action.type === 'raise') {
    if (!Number.isInteger(action.amount) || action.amount <= 0) return null;
    amount = action.amount;
  }

  const boardText =
    sample.board.length === 0 ? '' : sample.board.map((card) => cardLabel(card)).join(' ');
  const reasoning =
    typeof sample.reasoning === 'string' ? sample.reasoning : '';
  const example: LlmExample = {
    street: sample.street,
    position: POSITION_LABELS[sample.position],
    hole: sample.hole.map((card) => cardLabel(card)).join(' '),
    board: boardText,
    pot: sample.pot,
    currentBet: sample.currentBet,
    callAmount: sample.callAmount,
    facingBet: sample.facingBet === true,
    action: action.type,
    note: reasoning.slice(0, 80),
  };
  if (amount !== undefined) example.amount = amount;
  if (
    typeof sample.equity === 'number' &&
    Number.isFinite(sample.equity) &&
    sample.equity >= 0 &&
    sample.equity <= 1
  ) {
    example.equity = roundTo(sample.equity, 4);
  }
  return example;
}

/**
 * 把决策样本转换成 LlmExample：
 * - 过滤结构不合法 / 牌面数量异常 / 金额非法的样本；
 * - bet / raise 才写 amount；equity 可选；note 截断 80 字；
 * - 最多返回 maxExamples 条。
 */
export function buildExperienceExamples(
  samples: readonly ExperienceDecisionSample[],
  maxExamples = MAX_EXPERIENCE_EXAMPLES,
): LlmExample[] {
  const examples: LlmExample[] = [];
  const limit = Math.max(0, Math.floor(maxExamples));
  for (const sample of samples) {
    if (examples.length >= limit) break;
    const example = toLlmExample(sample);
    if (example) examples.push(example);
  }
  return examples;
}

/** 每手最多保留 1-2 条：优先一条翻牌前 + 一条轮换街道的翻牌后样本。 */
function pickHandSamples(
  samples: readonly ExperienceDecisionSample[],
  handIndex: number,
  maxSamples: number,
): ExperienceDecisionSample[] {
  const limit = Math.max(0, Math.min(2, maxSamples));
  if (limit === 0 || samples.length === 0) return [];
  const picked: ExperienceDecisionSample[] = [];
  const preflop = samples.find((sample) => sample.street === 'preflop');
  if (preflop) picked.push(preflop);

  const targetStreet = POSTFLOP_STREETS[handIndex % POSTFLOP_STREETS.length];
  const postflop =
    samples.find((sample) => sample.street === targetStreet) ??
    samples.find((sample) => sample.street !== 'preflop');
  if (postflop && picked.length < limit) picked.push(postflop);

  // 若这手牌只有翻牌前决策，只保留 1 条，避免经验库被大量翻牌前弃牌淹没。
  if (picked.length === 0) {
    for (const sample of samples) {
      picked.push(sample);
      if (picked.length >= limit) break;
    }
  }
  return picked.slice(0, limit);
}

function toExperienceSample(
  view: PlayerView,
  legal: LegalActions,
  action: PlayerAction,
  decision: AIDecision,
  difficulty: Difficulty,
): ExperienceDecisionSample {
  return {
    street: view.street,
    position: positionOf(view),
    hole: view.self.holeCards.map((card) => ({ ...card })),
    board: view.board.map((card) => ({ ...card })),
    pot: view.pot,
    currentBet: view.currentBet,
    callAmount: legal.callAmount,
    facingBet: view.currentBet > view.self.committedThisStreet,
    action,
    equity: decision.debug.equity,
    reasoning: decision.debug.reasoning,
    legal: { ...legal },
    difficulty,
    stack: view.self.stack,
    playerCount: view.players.length,
  };
}

/* ------------------------------------------------------------------ */
/* 大模型机器人 SFT 数据集                                             */
/* ------------------------------------------------------------------ */

/** SFT 数据集使用的 system 提示词（与 llmBot 的精简英文提示词风格保持一致）。 */
export const SFT_SYSTEM_PROMPT = [
  "You are a No-Limit Hold'em bot.",
  'Reply with EXACTLY ONE compact JSON line, no markdown, no thinking:',
  '{"a":"fold|check|call|bet|raise|allin","x":int-only-for-bet-raise,"w":"short English reason"}',
  'Amount x is the TOTAL chips for this street (raise-to). Follow LEGAL exactly; allin = shove.',
].join(' ');

export type SftRole = 'system' | 'user' | 'assistant';

export interface SftChatMessage {
  role: SftRole;
  content: string;
}

export interface SftRecord {
  messages: [SftChatMessage, SftChatMessage, SftChatMessage];
}

/** 一行 SFT 训练样本及其统计元数据（元数据不写入 JSONL）。 */
export interface SftTrainingSample {
  street: Street;
  action: PlayerAction['type'];
  record: SftRecord;
}

const STREET_LABELS: Record<Street, string> = {
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
};

const STREET_BOARD_COUNTS: Record<Street, number> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
};

/** SFT user 消息使用的短代码（与 llmBot 提示词一致，省 token）。 */
const SFT_STREET_CODES: Record<Street, string> = {
  preflop: 'PRE',
  flop: 'FLOP',
  turn: 'TURN',
  river: 'RIVER',
};

const SFT_POSITION_CODES: Record<string, string> = {
  早位: 'EP',
  中位: 'MP',
  晚位: 'LP',
  盲注位: 'BLIND',
};

function simpleActionForType(type: 'fold' | 'check' | 'call' | 'allin'): PlayerAction {
  switch (type) {
    case 'fold':
      return { type: 'fold' };
    case 'check':
      return { type: 'check' };
    case 'call':
      return { type: 'call' };
    case 'allin':
      return { type: 'allin' };
  }
}

/** 校验样本动作结构，并在有 legal 时再次校验合法性；非法 / 不明确返回 null。 */
function normalizeSftAction(sample: ExperienceDecisionSample): PlayerAction | null {
  const action = sample.action;
  if (!action || typeof action !== 'object') return null;

  let candidate: PlayerAction;
  if (
    action.type === 'fold' ||
    action.type === 'check' ||
    action.type === 'call' ||
    action.type === 'allin'
  ) {
    candidate = simpleActionForType(action.type);
  } else if (action.type === 'bet' || action.type === 'raise') {
    if (!Number.isInteger(action.amount) || action.amount <= 0) return null;
    candidate = { type: action.type, amount: action.amount };
  } else {
    return null;
  }

  if (sample.legal && !isActionLegal(candidate, sample.legal)) return null;
  return candidate;
}

/** 生成 user 消息里的合法动作短 JSON：有真实 legal 就用真实数据，否则只声明样本动作合法。 */
function legalActionsHint(sample: ExperienceDecisionSample): string {
  const legal = sample.legal;
  if (legal) {
    return JSON.stringify({
      f: legal.canFold ? 1 : 0,
      ck: legal.canCheck ? 1 : 0,
      ca: legal.canCall ? 1 : 0,
      caAmt: legal.callAmount,
      b: legal.canBet ? 1 : 0,
      r: legal.canRaise ? 1 : 0,
      min: legal.minRaiseTo,
      max: legal.maxRaiseTo,
      ai: legal.canAllIn ? 1 : 0,
      cur: legal.currentBet,
    });
  }

  // 没有记录 legal 时不要编造其它选项：只声明该样本动作本身是合法的。
  const action = sample.action;
  switch (action.type) {
    case 'fold':
      return '{"f":1}';
    case 'check':
      return '{"ck":1}';
    case 'call':
      return `{"ca":1,"caAmt":${sample.callAmount}}`;
    case 'bet':
      return `{"b":1,"x":${action.amount}}`;
    case 'raise':
      return `{"r":1,"x":${action.amount}}`;
    case 'allin':
      return '{"ai":1}';
  }
}

function buildSftUserMessage(sample: ExperienceDecisionSample): string {
  const street = SFT_STREET_CODES[sample.street];
  const position = SFT_POSITION_CODES[POSITION_LABELS[sample.position]] ?? 'MP';
  const hole = sample.hole.map((card) => cardLabel(card)).join(' ');
  const board = sample.board.length === 0 ? '-' : sample.board.map((card) => cardLabel(card)).join(' ');
  const context = [`HAND ${street} | POS ${position}`];
  if (typeof sample.stack === 'number' && Number.isFinite(sample.stack)) {
    context.push(`STACK ${sample.stack}`);
  }
  if (typeof sample.playerCount === 'number' && Number.isFinite(sample.playerCount)) {
    context.push(`PLAYERS ${sample.playerCount}`);
  }
  return [
    context.join(' | '),
    `HOLE ${hole} | BOARD ${board}`,
    `POT ${sample.pot} | CURBET ${sample.currentBet} | TO-CALL ${sample.callAmount}`,
    `LEGAL ${legalActionsHint(sample)}`,
  ].join('\n');
}

/** assistant 的简短英文理由（不再输出中文复盘，避免训练数据浪费 token）。 */
function buildSftReason(action: PlayerAction): string {
  switch (action.type) {
    case 'fold':
      return 'hand too weak';
    case 'check':
      return 'check for free';
    case 'call':
      return 'call with pot odds';
    case 'bet':
      return 'bet for value';
    case 'raise':
      return 'raise for value';
    case 'allin':
      return 'shove for value';
  }
}

function buildSftAssistantContent(
  sample: ExperienceDecisionSample,
  action: PlayerAction,
): string {
  const payload: Record<string, string | number> = { a: action.type };
  if ((action.type === 'bet' || action.type === 'raise') && Number.isInteger(action.amount)) {
    payload.x = action.amount;
  }
  payload.w = buildSftReason(action);
  return JSON.stringify(payload);
}

function toSftTrainingSample(
  sample: ExperienceDecisionSample,
): SftTrainingSample | null {
  if (!sample || typeof sample !== 'object') return null;
  // 只保留 hard / expert 决策；未记录难度时视为自博弈内部样本（exhibition 只收集这两档）。
  if (
    sample.difficulty !== undefined &&
    sample.difficulty !== 'hard' &&
    sample.difficulty !== 'expert'
  ) {
    return null;
  }
  if (!(sample.street in STREET_LABELS)) return null;
  if (!(sample.position in POSITION_LABELS)) return null;
  if (!Array.isArray(sample.hole) || sample.hole.length !== 2) return null;
  if (!Array.isArray(sample.board)) return null;
  if (sample.board.length !== STREET_BOARD_COUNTS[sample.street]) return null;
  if (!isFiniteNonNegative(sample.pot)) return null;
  if (!isFiniteNonNegative(sample.currentBet)) return null;
  if (!isFiniteNonNegative(sample.callAmount)) return null;

  const action = normalizeSftAction(sample);
  if (!action) return null;

  const record: SftRecord = {
    messages: [
      { role: 'system', content: SFT_SYSTEM_PROMPT },
      { role: 'user', content: buildSftUserMessage(sample) },
      { role: 'assistant', content: buildSftAssistantContent(sample, action) },
    ],
  };
  return { street: sample.street, action: action.type, record };
}

/**
 * 把自博弈决策样本转换成 SFT 训练行：
 * - 只保留 hard / expert、合法、未回退、动作明确的样本；
 * - 最多 maxRows 行，不足时按实际数量返回。
 */
export function buildSftSamples(
  samples: readonly ExperienceDecisionSample[],
  maxRows = MAX_SFT_EXAMPLES,
): SftTrainingSample[] {
  const limit = Math.max(0, Math.floor(maxRows));
  const rows: SftTrainingSample[] = [];
  let preflopRows = 0;
  for (const sample of samples) {
    if (rows.length >= limit) break;
    const row = toSftTrainingSample(sample);
    if (!row) continue;
    if (row.street === 'preflop') {
      if (preflopRows >= MAX_SFT_PREFLOP_EXAMPLES) continue;
      preflopRows++;
    }
    rows.push(row);
  }
  return rows;
}

/** 只返回 SFT 对话记录（即 JSONL 每行的内容）。 */
export function buildSftDataset(
  samples: readonly ExperienceDecisionSample[],
  maxRows = MAX_SFT_EXAMPLES,
): SftRecord[] {
  return buildSftSamples(samples, maxRows).map((row) => row.record);
}

/** 渲染 JSONL：每行一个 JSON，末尾带换行；空数据返回空字符串。 */
export function renderSftJsonl(records: readonly SftRecord[]): string {
  if (records.length === 0) return '';
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* 自博弈对局                                                          */
/* ------------------------------------------------------------------ */

function seatName(index: number): string {
  return `训练AI-${index + 1}`;
}

/**
 * 运行一批自博弈牌局。
 *
 * - 每手 `createHand({ handNo, players, buttonIndex, smallBlind, bigBlind,
 *   seed: `${seed}-h${handNo}` })`；
 * - 按钮每手顺时针轮转；hero 座位由调用方逐手指定；
 * - 每个行动者都显式传入 `profileOverride` 与 `maxIterations`；
 * - decide 抛错 / 动作非法 / 引擎拒绝时回退到 check/call/fold；
 * - 每手最多 500 个动作；玩家筹码 < 大盲时 re-buy 到起始筹码。
 */
export async function runSelfPlayBatch(options: SelfPlayOptions): Promise<SelfPlayResult> {
  const handsCount = Math.max(0, Math.floor(options.hands));
  const startingStack = options.startingStack ?? TRAIN_STARTING_STACK;
  const smallBlind = options.smallBlind ?? TRAIN_SMALL_BLIND;
  const bigBlind = options.bigBlind ?? TRAIN_BIG_BLIND;
  const maxSamplesPerHand = Math.max(0, Math.min(2, options.maxSamplesPerHand ?? 2));
  const maxSamplesTotal = Math.max(
    0,
    Math.floor(options.maxSamplesTotal ?? MAX_EXPERIENCE_EXAMPLES),
  );
  const stacks = new Array<number>(TRAIN_PLAYER_COUNT).fill(startingStack);
  const samples: ExperienceDecisionSample[] = [];

  let netChips = 0;
  let actions = 0;
  let fallbackActions = 0;
  let rebuys = 0;
  let abortedHands = 0;
  let handsPlayed = 0;

  for (let handIndex = 0; handIndex < handsCount; handIndex++) {
    const handNo = handIndex + 1;

    // re-buy：筹码低于一个大盲时补到起始筹码，保证训练不中断。
    for (let seat = 0; seat < TRAIN_PLAYER_COUNT; seat++) {
      if (stacks[seat] < bigBlind) {
        stacks[seat] = startingStack;
        rebuys++;
      }
    }

    const seats = options.seatsForHand(handIndex, handNo);
    if (seats.length !== TRAIN_PLAYER_COUNT) {
      throw new Error(`训练桌固定 ${TRAIN_PLAYER_COUNT} 人，实际 ${seats.length} 人`);
    }
    const heroSeat = options.heroSeatForHand?.(handIndex, handNo) ?? null;
    const beforeStacks = stacks.slice();

    let hand: HandState;
    try {
      hand = createHand({
        handNo,
        players: seats.map((seat, index) => ({
          id: index,
          name: seatName(index),
          isHuman: false,
          stack: stacks[index],
          difficulty: seat.difficulty,
          kind: 'local',
        })),
        buttonIndex: handIndex % TRAIN_PLAYER_COUNT,
        smallBlind,
        bigBlind,
        seed: `${options.seed}-h${handNo}`,
      });
    } catch {
      abortedHands++;
      continue;
    }

    const sampleSeats = new Set<number>(
      options.sampleSeatsForHand?.(handIndex, handNo) ?? [],
    );
    const handSamples: ExperienceDecisionSample[] = [];
    let aborted = false;

    for (let step = 0; step < MAX_ACTIONS_PER_HAND; step++) {
      if (hand.phase !== 'playing') break;
      const actingIndex = hand.actingIndex;
      if (actingIndex === null) break;
      const actor = hand.players[actingIndex];
      const seat = seats[actingIndex];

      let legal: LegalActions;
      try {
        legal = getLegalActions(hand, actingIndex);
      } catch {
        aborted = true;
        break;
      }

      let view: PlayerView;
      try {
        view = buildPlayerView(hand, actor.id, options.seed);
      } catch {
        aborted = true;
        break;
      }

      let decision: AIDecision | null = null;
      let action: PlayerAction = fallbackAction(legal);
      let usedFallback = false;
      try {
        decision = await decide(view, seat.difficulty, {
          maxIterations: options.mcIterations,
          // 训练时显式传入参数，不受全局 learned 开关影响。
          profileOverride: seat.profile,
        });
        action = decision.action;
      } catch {
        decision = null;
        usedFallback = true;
      }
      if (!usedFallback && !isActionLegal(action, legal)) {
        usedFallback = true;
      }
      if (usedFallback) {
        action = fallbackAction(legal);
        fallbackActions++;
      }

      const sampleCandidate =
        !usedFallback &&
        decision !== null &&
        sampleSeats.has(actingIndex) &&
        (seat.difficulty === 'hard' || seat.difficulty === 'expert')
          ? toExperienceSample(view, legal, action, decision, seat.difficulty)
          : null;

      try {
        hand = playAction(hand, actingIndex, action);
        actions++;
        if (sampleCandidate) handSamples.push(sampleCandidate);
      } catch {
        fallbackActions++;
        try {
          const safeAction = fallbackAction(getLegalActions(hand, actingIndex));
          hand = playAction(hand, actingIndex, safeAction);
          actions++;
        } catch {
          aborted = true;
          break;
        }
      }
    }

    for (let seat = 0; seat < TRAIN_PLAYER_COUNT; seat++) {
      stacks[seat] = hand.players[seat].stack;
    }
    if (heroSeat !== null && heroSeat >= 0 && heroSeat < TRAIN_PLAYER_COUNT) {
      netChips += hand.players[heroSeat].stack - beforeStacks[heroSeat];
    }
    if (aborted) abortedHands++;
    handsPlayed++;

    const pickedSamples = pickHandSamples(handSamples, handIndex, maxSamplesPerHand);
    for (const sample of pickedSamples) {
      if (samples.length >= maxSamplesTotal) break;
      samples.push(sample);
    }
  }

  const bb100 =
    handsPlayed > 0 ? (netChips / bigBlind / handsPlayed) * 100 : 0;
  return {
    hands: handsPlayed,
    netChips,
    bb100,
    actions,
    fallbackActions,
    rebuys,
    abortedHands,
    samples,
  };
}

/**
 * 评估一个参数候选：hero 使用 `profile`，其余三人使用 `opponentProfile`；
 * hero 座位逐手轮转。base 与候选使用相同 seed 时，牌局与公共信息完全配对。
 */
export async function evaluateCandidate(
  options: EvaluateCandidateOptions,
): Promise<SelfPlayResult> {
  const difficulty = options.difficulty;
  const heroProfile = options.profile;
  const opponentProfile = options.opponentProfile ?? BASE_DIFFICULTY_PROFILES[difficulty];
  const hands = Math.max(1, Math.floor(options.hands ?? 10));
  const mcIterations = Math.max(1, Math.floor(options.mcIterations ?? 20));
  const seed = options.seed ?? 'trainer-eval';
  const heroSeatBase = options.heroSeat ?? 0;

  return runSelfPlayBatch({
    hands,
    mcIterations,
    seed,
    startingStack: options.startingStack,
    smallBlind: options.smallBlind,
    bigBlind: options.bigBlind,
    seatsForHand: (handIndex) => {
      const heroSeat = (heroSeatBase + handIndex) % TRAIN_PLAYER_COUNT;
      return Array.from({ length: TRAIN_PLAYER_COUNT }, (_, seatIndex) => ({
        difficulty,
        profile: seatIndex === heroSeat ? heroProfile : opponentProfile,
      }));
    },
    heroSeatForHand: (handIndex) =>
      (heroSeatBase + handIndex) % TRAIN_PLAYER_COUNT,
  });
}

/* ------------------------------------------------------------------ */
/* 参数进化                                                            */
/* ------------------------------------------------------------------ */

export interface TrainDifficultyOptions {
  difficulty: Difficulty;
  startProfile: DifficultyProfile;
  hands: number;
  rounds: number;
  mutations: number;
  mcIterations: number;
  seed: string;
  /** 评估执行器；传入后每轮基准 / 候选会并发提交，worker 池可并行计算。 */
  runner?: EvaluationRunner;
  onProgress?: (message: string) => void;
}

function describeDiff(diff: readonly ProfileDiff[]): string {
  if (diff.length === 0) return '无字段变化';
  return diff
    .map((entry) => `${entry.field} ${entry.before.toFixed(3)}→${entry.after.toFixed(3)}`)
    .join('、');
}

/** 顺序或并发执行一批独立评估；顺序模式保持原有行为，runner 模式用于多核并行。 */
async function evaluateBatch(
  evaluations: readonly EvaluateCandidateOptions[],
  runner: EvaluationRunner | undefined,
): Promise<SelfPlayResult[]> {
  if (!runner) {
    const results: SelfPlayResult[] = [];
    for (const evaluation of evaluations) {
      results.push(await evaluateCandidate(evaluation));
    }
    return results;
  }
  return Promise.all(evaluations.map((evaluation) => runner(evaluation)));
}

/**
 * 对单一难度做 hill climbing：
 * - 每轮以当前参数为基准（hero 与对手都用当前参数做镜像评估）；
 * - 候选候选：hero 使用候选、其余座位使用当前参数，与基准共用同一 seed 序列；
 * - 接受拟合提升 > 0.5 BB/100 且验证集不回落的最优候选。
 *
 * 四档都从各自当前参数出发；入门档的 play 受 [0.05, 0.30] 边界保护，
 * 避免把“松被动”的入门 AI 训练成紧手。
 *
 * 传入 runner 后，每轮的“基准 + 全部候选”、验证对与最终对照都会并发提交；
 * 每个评估仍有独立固定 seed，因此并行与单线程结果完全一致。
 */
export async function trainDifficulty(
  options: TrainDifficultyOptions,
): Promise<DifficultyTrainingResult> {
  const { difficulty, hands, mcIterations, seed, runner } = options;
  const rounds = Math.max(0, Math.floor(options.rounds));
  const mutations = Math.max(0, Math.floor(options.mutations));
  const startProfile = cloneProfile(options.startProfile);
  let current = cloneProfile(options.startProfile);
  let handsPlayed = 0;
  let acceptedMutations = 0;
  const roundLogs: RoundLog[] = [];
  const log = (message: string): void => options.onProgress?.(message);
  const parallelTag = runner ? '，并行提交' : '';

  for (let round = 1; round <= rounds; round++) {
    const evalSeed = `${seed}-${difficulty}-r${round}`;
    const mutants = Array.from({ length: mutations }, (_, index) =>
      mutateProfile(
        current,
        difficulty,
        `${seed}-${difficulty}-r${round}-m${index + 1}`,
      ),
    );
    log(
      `[${difficulty}] 第 ${round}/${rounds} 轮：评估基准${
        mutations > 0 ? ` + ${mutations} 个候选` : ''
      }（${hands} 手，seed=${evalSeed}${parallelTag}）`,
    );

    const evaluations: EvaluateCandidateOptions[] = [
      {
        difficulty,
        profile: current,
        opponentProfile: current,
        hands,
        mcIterations,
        seed: evalSeed,
      },
      ...mutants.map((profile) => ({
        difficulty,
        profile,
        opponentProfile: current,
        hands,
        mcIterations,
        seed: evalSeed,
      })),
    ];
    const batch = await evaluateBatch(evaluations, runner);
    const baseResult = batch[0];
    handsPlayed += batch.reduce((sum, result) => sum + result.hands, 0);

    interface CandidateEvaluation {
      index: number;
      profile: DifficultyProfile;
      bb100: number;
      diff: ProfileDiff[];
    }
    const evaluated: CandidateEvaluation[] = mutants.map((profile, index) => ({
      index: index + 1,
      profile,
      bb100: batch[index + 1].bb100,
      diff: diffProfile(current, profile),
    }));

    for (const candidate of evaluated) {
      log(
        `[${difficulty}]   - 候选 #${candidate.index}：${formatBB100(
          candidate.bb100,
        )} BB/100（Δ ${formatBB100(candidate.bb100 - baseResult.bb100)}）；${describeDiff(
          candidate.diff,
        )}`,
      );
    }

    let best: CandidateEvaluation | null = null;
    for (const candidate of evaluated) {
      if (!best || candidate.bb100 > best.bb100) best = candidate;
    }
    const bestDelta = best ? best.bb100 - baseResult.bb100 : 0;
    let accepted = best !== null && bestDelta > 0.5;
    let validationDelta: number | null = null;
    let validationRejected = false;

    // 交叉验证：拟合集提升的候选必须在独立验证 seed 上也不回落，降低小样本过拟合。
    if (accepted && best) {
      const validationSeed = `${seed}-${difficulty}-r${round}-validation`;
      const validationBatch = await evaluateBatch(
        [
          {
            difficulty,
            profile: current,
            opponentProfile: current,
            hands,
            mcIterations,
            seed: validationSeed,
          },
          {
            difficulty,
            profile: best.profile,
            opponentProfile: current,
            hands,
            mcIterations,
            seed: validationSeed,
          },
        ],
        runner,
      );
      const validationBase = validationBatch[0];
      const validationCandidate = validationBatch[1];
      handsPlayed += validationBase.hands + validationCandidate.hands;
      validationDelta = roundTo(validationCandidate.bb100 - validationBase.bb100, 3);
      if (validationDelta > 0) {
        log(`[${difficulty}]   - 验证集 Δ ${formatBB100(validationDelta)}，通过`);
      } else {
        accepted = false;
        validationRejected = true;
        log(
          `[${difficulty}]   - 验证集 Δ ${formatBB100(validationDelta)}，放弃候选 #${best.index}（防止过拟合）`,
        );
      }
    }

    const candidateLogs: CandidateLog[] = evaluated.map((candidate) => ({
      index: candidate.index,
      bb100: roundTo(candidate.bb100, 3),
      deltaBB100: roundTo(candidate.bb100 - baseResult.bb100, 3),
      diff: candidate.diff,
      accepted: accepted && best !== null && candidate.index === best.index,
    }));

    if (accepted && best) {
      current = cloneProfile(best.profile);
      acceptedMutations++;
      log(
        `[${difficulty}]   → 接受候选 #${best.index}（拟合 Δ ${formatBB100(bestDelta)}，验证 Δ ${formatBB100(validationDelta ?? 0)}）`,
      );
    } else {
      log(
        `[${difficulty}]   → 未接受（拟合最优 Δ ${formatBB100(bestDelta)} 未达阈值或验证集未通过）`,
      );
    }

    roundLogs.push({
      round,
      evalSeed,
      baseBB100: roundTo(baseResult.bb100, 3),
      candidates: candidateLogs,
      accepted,
      acceptedIndex: accepted && best ? best.index : null,
      bestDeltaBB100: roundTo(bestDelta, 3),
      validationDeltaBB100:
        validationDelta === null ? null : roundTo(validationDelta, 3),
      validationRejected,
    });
  }

  // 最终对照评估：内置基础档位 vs 当前训练档位分别作为 hero，对手固定为基础档位；
  // 两者共用同一 seed 序列。这里使用 4×hands 手，降低小样本带来的巨大方差。
  const finalHands = hands * 4;
  const finalSeed = `${seed}-${difficulty}-final`;
  log(`[${difficulty}] 最终对照评估（${finalHands} 手，seed=${finalSeed}${parallelTag}）`);
  const finalBatch = await evaluateBatch(
    [
      {
        difficulty,
        profile: BASE_DIFFICULTY_PROFILES[difficulty],
        opponentProfile: BASE_DIFFICULTY_PROFILES[difficulty],
        hands: finalHands,
        mcIterations,
        seed: finalSeed,
      },
      {
        difficulty,
        profile: current,
        opponentProfile: BASE_DIFFICULTY_PROFILES[difficulty],
        hands: finalHands,
        mcIterations,
        seed: finalSeed,
      },
    ],
    runner,
  );
  const baseline = finalBatch[0];
  const trained = finalBatch[1];
  handsPlayed += baseline.hands + trained.hands;

  return {
    difficulty,
    startProfile,
    finalProfile: cloneProfile(current),
    baselineBB100: roundTo(baseline.bb100, 3),
    trainedBB100: roundTo(trained.bb100, 3),
    acceptedMutations,
    handsPlayed,
    rounds: roundLogs,
  };
}

/* ------------------------------------------------------------------ */
/* 经验库 exhibition                                                   */
/* ------------------------------------------------------------------ */

export interface ExhibitionOptions {
  hands: number;
  mcIterations: number;
  seed: string;
  hardProfile: DifficultyProfile;
  expertProfile: DifficultyProfile;
  startingStack?: number;
  smallBlind?: number;
  bigBlind?: number;
}

/** 训练后跑一段 hard/expert 自博弈，收集决策样本。 */
export async function runExhibition(
  options: ExhibitionOptions,
): Promise<{ result: SelfPlayResult; examples: LlmExample[] }> {
  const hardSeat: SelfPlaySeat = { difficulty: 'hard', profile: options.hardProfile };
  const expertSeat: SelfPlaySeat = {
    difficulty: 'expert',
    profile: options.expertProfile,
  };
  const result = await runSelfPlayBatch({
    hands: options.hands,
    mcIterations: options.mcIterations,
    seed: options.seed,
    startingStack: options.startingStack,
    smallBlind: options.smallBlind,
    bigBlind: options.bigBlind,
    seatsForHand: (handIndex) =>
      handIndex % 2 === 0
        ? [hardSeat, expertSeat, hardSeat, expertSeat]
        : [expertSeat, hardSeat, expertSeat, hardSeat],
    sampleSeatsForHand: () => [0, 1, 2, 3],
    maxSamplesPerHand: 2,
    // SFT 数据集最多 400 行：exhibition 手数足够时收集到 400 条，再分别裁剪经验库。
    maxSamplesTotal: MAX_SFT_EXAMPLES,
  });
  return {
    result,
    examples: buildExperienceExamples(result.samples, MAX_EXPERIENCE_EXAMPLES),
  };
}

/* ------------------------------------------------------------------ */
/* 产物构建                                                            */
/* ------------------------------------------------------------------ */

export interface BuildLearnedProfilesInput {
  generatedAt: string;
  hands: number;
  seed: string;
  profiles: Record<Difficulty, DifficultyProfile>;
  metrics: Record<Difficulty, DifficultyMetric>;
}

/**
 * 构建 learnedProfiles.json 的内容。
 *
 * 每个难度只写 10 个可变异字段，作为 `DifficultyProfileOverride` 的部分覆盖；
 * mcIterations / betSizes / raiseSizes / errorRate / positionAware / style / label
 * 等字段不写入，合并时继续使用基础档位，避免训练产物冻结这些“保持不变”的字段。
 */
export function buildLearnedProfilesFile(
  input: BuildLearnedProfilesInput,
): LearnedProfilesFile {
  const profiles: Partial<Record<Difficulty, DifficultyProfileOverride>> = {};
  for (const difficulty of DIFFICULTY_ORDER) {
    const profile = input.profiles[difficulty];
    profiles[difficulty] = {
      preflop: {
        play: profile.preflop.play,
        raise: profile.preflop.raise,
        threeBet: profile.preflop.threeBet,
        bluffRaiseRate: profile.preflop.bluffRaiseRate,
        mixRaiseRate: profile.preflop.mixRaiseRate,
        trapRate: profile.preflop.trapRate,
      },
      postflop: {
        bluffRate: profile.postflop.bluffRate,
        semiBluffRate: profile.postflop.semiBluffRate,
        valueThreshold: profile.postflop.valueThreshold,
        callMargin: profile.postflop.callMargin,
      },
    };
  }
  const metrics: Record<string, unknown> = {};
  for (const difficulty of DIFFICULTY_ORDER) {
    const metric = input.metrics[difficulty];
    metrics[difficulty] = {
      baselineBB100: roundTo(metric.baselineBB100, 3),
      trainedBB100: roundTo(metric.trainedBB100, 3),
      acceptedMutations: metric.acceptedMutations,
      rounds: metric.rounds,
      hands: metric.hands,
    };
  }
  return {
    generatedAt: input.generatedAt,
    hands: input.hands,
    seed: input.seed,
    profiles,
    metrics,
  };
}

/* ------------------------------------------------------------------ */
/* 报告                                                                */
/* ------------------------------------------------------------------ */

export interface ReportInput {
  options: TrainOptions;
  generatedAt: string;
  elapsedMs: number;
  totalTrainingHands: number;
  results: DifficultyTrainingResult[];
  exhibitionHands: number;
  examples: LlmExample[];
  sftSamples: readonly SftTrainingSample[];
  /** 并行评估使用的 worker 数；0 / 未传表示单线程。 */
  workerCount?: number;
  /** 本机 CPU 核数。 */
  cpuCount?: number;
}

const KEY_PARAMS: readonly {
  label: string;
  read: (profile: DifficultyProfile) => number;
}[] = [
  { label: 'preflop.play', read: (profile) => profile.preflop.play },
  { label: 'preflop.raise', read: (profile) => profile.preflop.raise },
  { label: 'preflop.threeBet', read: (profile) => profile.preflop.threeBet },
  { label: 'preflop.bluffRaiseRate', read: (profile) => profile.preflop.bluffRaiseRate },
  { label: 'preflop.mixRaiseRate', read: (profile) => profile.preflop.mixRaiseRate },
  { label: 'preflop.trapRate', read: (profile) => profile.preflop.trapRate },
  { label: 'postflop.bluffRate', read: (profile) => profile.postflop.bluffRate },
  { label: 'postflop.semiBluffRate', read: (profile) => profile.postflop.semiBluffRate },
  { label: 'postflop.valueThreshold', read: (profile) => profile.postflop.valueThreshold },
  { label: 'postflop.callMargin', read: (profile) => profile.postflop.callMargin },
];

function countBy(values: readonly string[], order: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const key of order) {
    const count = counts.get(key);
    if (count) parts.push(`${key} ${count}`);
  }
  return parts.length > 0 ? parts.join('、') : '无';
}

const STREET_ORDER: readonly string[] = ['preflop', 'flop', 'turn', 'river'];
const ACTION_ORDER: readonly string[] = ['fold', 'check', 'call', 'bet', 'raise', 'allin'];

/** 生成中文训练报告 Markdown。 */
export function renderReport(input: ReportInput): string {
  const lines: string[] = [];
  const mode = input.options.quick ? '快速模式（--quick）' : '默认全量模式';
  const workerCount = input.workerCount ?? 0;
  const parallelText =
    workerCount > 1
      ? `${workerCount} 个 worker / ${input.cpuCount ?? 1} 核（4 档同时进化，基准与候选并行评估）`
      : '单线程';
  lines.push('# 自博弈训练报告');
  lines.push('');
  lines.push(`- 生成时间：${input.generatedAt}`);
  lines.push(`- 运行模式：${mode}`);
  lines.push(`- 运行参数：seed = \`${input.options.seed}\`，hands = ${input.options.hands}，` +
    `rounds = ${input.options.rounds}，mutations = ${input.options.mutations}，` +
    `exhibition = ${input.options.exhibition}，mcIterations = ${input.options.mcIterations}`);
  lines.push(`- 并行评估：${parallelText}`);
  lines.push(`- 本次耗时：${formatDuration(input.elapsedMs)}`);
  lines.push(`- 训练对局总手数：${input.totalTrainingHands} 手（含基准评估、候选评估与最终对照评估）`);
  lines.push(`- 经验库展示手数：${input.exhibitionHands} 手`);
  lines.push('- 训练对象：① 规则引擎机器人（四档参数进化）② 大模型机器人（few-shot 经验库 + SFT 数据集）');
  lines.push('');

  lines.push('## 1. 评估方法');
  lines.push('');
  lines.push('- 4 人桌，盲注 10/20，起始筹码 1000；全部为本地 AI，无人类、无大模型、无网络。');
  if (workerCount > 1) {
    lines.push('- 并行加速：多核机器上 4 档难度同时进化，每轮的基准 + 变异候选、验证对与最终对照都并发提交；每个评估仍有独立固定 seed，并行与单线程结果一致。');
  }
  lines.push('- 每手通过 `createHand({ seed: `${seed}-h${handNo}` })` 发牌；按钮每手顺时针轮转。');
  lines.push('- hero 座位每手轮转，最终收益按 `netChips / bigBlind / hands * 100` 换算为 BB/100，以平均位置影响。');
  lines.push('- 每轮先评估当前基准，再评估 N 个变异候选；候选与基准使用完全相同的 seed 序列（配对评估）。');
  lines.push('- 评估口径：hero 使用被评估参数，其余三个座位使用该档当前的基准参数；最终 baseline 固定使用内置基础档位，便于观察累计训练收益。');
  lines.push('- 方差控制：每轮基准 / 候选评估使用 `hands` 手；最终 baseline/trained 对照评估使用 4×hands 手（快速 100 手、默认 240 手），并共用同一 seed 序列。');
  lines.push('- 接受条件：最优候选的提升 > 0.5 BB/100。');
  lines.push('- 交叉验证：拟合集提升的候选还会在独立验证 seed 上复评；验证集回落则放弃，降低小样本过拟合。');
  lines.push('- 四档边界：beginner 的 play 限制在 [0.05, 0.30]，normal/hard/expert 各有独立的 play/bluff/semiBluff 边界；play 单步 ±0.04~0.08，raise / threeBet 保持层级约束。');
  lines.push('- 翻牌前阈值：`decide` 通过 `preflopThresholdsForProfile(profile, position)` 读取传入的 profileOverride，因此 normal/hard/expert 的 `play` / `raise` / `threeBet` 变异会真实影响决策；beginner 分支仍主要使用 `preflop.play`。');
  lines.push('- 异常防御：AI 决策抛错或动作被引擎拒绝时，回退到 `getLegalActions` 的 check/call/fold；每手最多 500 个动作。');
  lines.push('- re-buy：任意玩家筹码低于大盲（20）时，下一手开始前统一重置为 1000，保证对局继续；hero 的净收益不计入 re-buy 注入的筹码。');
  lines.push('- MC 迭代：训练时统一使用 `maxIterations` 上限（本次 ' + input.options.mcIterations + '），beginner/normal 本身不使用蒙特卡洛。');
  lines.push('');

  const changedTiers = input.results.filter(
    (result) => diffProfile(result.startProfile, result.finalProfile).length > 0,
  ).length;
  const totalAccepted = input.results.reduce(
    (sum, result) => sum + result.acceptedMutations,
    0,
  );

  lines.push('## 2. 规则引擎机器人训练（四档参数进化）');
  lines.push('');
  lines.push('| 难度 | baseline BB/100 | trained BB/100 | Δ BB/100 | 接受变异数 | 实际改动字段列表 |');
  lines.push('| --- | ---: | ---: | ---: | ---: | --- |');
  for (const difficulty of DIFFICULTY_ORDER) {
    const result = input.results.find((entry) => entry.difficulty === difficulty);
    if (!result) continue;
    lines.push(
      `| ${DIFFICULTY_LABELS[difficulty]}（${difficulty}） | ${formatNumber(
        result.baselineBB100,
      )} | ${formatNumber(result.trainedBB100)} | ${formatBB100(
        result.trainedBB100 - result.baselineBB100,
      )} | ${result.acceptedMutations} | ${describeDiff(
        diffProfile(result.startProfile, result.finalProfile),
      )} |`,
    );
  }
  lines.push('');
  lines.push(`- 本次训练有 ${changedTiers}/4 档参数发生变化，共接受 ${totalAccepted} 个变异。`);
  lines.push('- 训练参数已写入 `src/ai/data/learnedProfiles.json`（每档只写入 10 个可变异字段，其余字段继续使用内置基础档位）。');
  lines.push('- 生效方式：在页面设置中打开「使用训练后参数」开关后生效（对应 `setLearnedProfilesEnabled(true)`）；默认关闭时普通对局仍使用内置基础档位。');
  lines.push('');
  lines.push('> 提示：BB/100 的单位是“每 100 手净赢的大盲数”。每轮评估仅 25-60 手，最终对照为 100-240 手，方差仍然较大，表中数值应结合训练报告中的接受过程一起看。');
  lines.push('> 最终 baseline/trained 使用独立 seed 的配对评估；若某个被接受的变异在这批对照牌局中没有触发（例如翻牌前混合频率未遇到对应强度区间），两列可能完全相同。');
  lines.push('> 被接受的变异不保证在最终对照中仍然提升；在当前样本量下，单轮提升可能来自噪声或对特定对手的过拟合，重复训练 / 换 seed 再观察更可靠。');
  lines.push('');

  lines.push('## 3. 参数进化过程（精简）');
  lines.push('');
  lines.push('> 为避免长轮数报告膨胀，逐轮候选 Δ / seed / 验证明细不再写入，只保留每档接受统计；完整明细以控制台日志为准。');
  lines.push('');
  for (const difficulty of DIFFICULTY_ORDER) {
    const result = input.results.find((entry) => entry.difficulty === difficulty);
    if (!result) continue;
    lines.push(`### ${DIFFICULTY_LABELS[difficulty]}（${difficulty}）`);
    lines.push('');
    const rounds = result.rounds;
    const totalRounds = rounds.length;
    if (totalRounds === 0) {
      lines.push('- 未运行参数进化轮次。');
      lines.push('');
      continue;
    }
    const acceptedRounds = rounds.filter((round) => round.accepted);
    const validationRejected = rounds.filter(
      (round) => round.validationRejected === true,
    ).length;
    const belowThreshold = Math.max(
      0,
      totalRounds - acceptedRounds.length - validationRejected,
    );
    const deltas = acceptedRounds.map((round) => {
      if (typeof round.bestDeltaBB100 === 'number') return round.bestDeltaBB100;
      if (round.candidates.length === 0) return 0;
      return Math.max(...round.candidates.map((candidate) => candidate.deltaBB100));
    });
    const acceptedList = acceptedRounds
      .slice(0, 20)
      .map((round) => `第 ${round.round} 轮 #${round.acceptedIndex ?? '?'}`)
      .join('、');
    const moreText =
      acceptedRounds.length > 20 ? ` 等 ${acceptedRounds.length} 次` : '';
    lines.push(
      `- 接受 ${acceptedRounds.length}/${totalRounds} 轮（${(
        (acceptedRounds.length / totalRounds) *
        100
      ).toFixed(1)}%）；验证集拦截 ${validationRejected} 次；未达阈值 ${belowThreshold} 轮；训练对局 ${result.handsPlayed} 手。`,
    );
    if (deltas.length === 0) {
      lines.push('- 接受时拟合 Δ：无。');
    } else {
      const minDelta = Math.min(...deltas);
      const maxDelta = Math.max(...deltas);
      const avgDelta = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
      lines.push(
        `- 接受时拟合 Δ：最小 ${formatBB100(minDelta)} / 平均 ${formatBB100(
          avgDelta,
        )} / 最大 ${formatBB100(maxDelta)} BB/100。`,
      );
    }
    lines.push(`- 接受轮次：${acceptedList || '无'}${moreText}。`);
    lines.push('');
  }

  lines.push('## 4. 最终关键参数');
  lines.push('');
  lines.push('| 参数 | 入门 | 普通 | 困难 | 专家 |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  const finalProfiles = new Map<Difficulty, DifficultyProfile>();
  for (const result of input.results) finalProfiles.set(result.difficulty, result.finalProfile);
  for (const param of KEY_PARAMS) {
    const values = DIFFICULTY_ORDER.map((difficulty) => {
      const profile = finalProfiles.get(difficulty);
      return profile ? param.read(profile).toFixed(3) : '—';
    });
    lines.push(`| \`${param.label}\` | ${values.join(' | ')} |`);
  }
  lines.push('');
  lines.push('> `mcIterations`、`betSizes`、`raiseSizes`、`errorRate`、`positionAware`、`style`、`label` 不在变异范围内，四档保持基础档位设定。');
  lines.push('');

  lines.push('## 5. 大模型机器人训练数据');
  lines.push('');
  lines.push(`- few-shot 经验条数：${input.examples.length} 条（上限 ${MAX_EXPERIENCE_EXAMPLES}）`);
  lines.push(`- SFT 数据集行数：${input.sftSamples.length} 行（上限 ${MAX_SFT_EXAMPLES}）`);
  lines.push(`- 经验库按街道：${countBy(input.examples.map((example) => example.street), STREET_ORDER)}`);
  lines.push(`- 经验库按动作：${countBy(input.examples.map((example) => example.action), ACTION_ORDER)}`);
  lines.push(`- SFT 按街道：${countBy(input.sftSamples.map((sample) => sample.street), STREET_ORDER)}`);
  lines.push(`- SFT 按动作：${countBy(input.sftSamples.map((sample) => sample.action), ACTION_ORDER)}`);
  lines.push('- 文件路径：`src/ai/data/llm-experience.json`（few-shot 经验库）、`training/llm-sft-dataset.jsonl`（SFT 数据集）。');
  lines.push('- 来源：训练后 hard / expert 座位的 exhibition 自博弈；每手最多 1-2 条，只保留合法、未走回退逻辑、动作明确的决策。');
  lines.push(`- 体积控制：SFT 最多 ${MAX_SFT_EXAMPLES} 行，其中翻牌前最多 ${MAX_SFT_PREFLOP_EXAMPLES} 条；few-shot 经验最多 ${MAX_EXPERIENCE_EXAMPLES} 条；报告只保留汇总统计，不再逐轮展开。`);
  lines.push('- few-shot 经验库：`LlmExperienceFile`（`generatedAt` / `hands` / `examples`）接口保持不变；本地大模型机器人会在提示词中把匹配街道 / 是否面对下注的样本作为 few-shot 参考。');
  lines.push('- SFT 数据集：JSONL，每行一条 `{"messages":[{"role":"system",...},{"role":"user",...},{"role":"assistant",...}]}`；system/user 为精简英文（HAND/POS/HOLE/BOARD/POT/LEGAL 短格式）；assistant 只含短键 JSON `{"a":...,"x":...,"w":...}`。');
  lines.push('- 用途：应用内大模型机器人会直接使用 `llm-experience.json` 做 few-shot；`llm-sft-dataset.jsonl` 可交给本地微调工具（llama.cpp / LlamaFactory 等）做可选微调，本项目不自动微调。');
  lines.push('');

  lines.push('## 6. 如何启用训练参数');
  lines.push('');
  lines.push('- 训练产物：`src/ai/data/learnedProfiles.json`（规则引擎四档参数）、`src/ai/data/llm-experience.json`（大模型 few-shot 经验）、`training/llm-sft-dataset.jsonl`（SFT 数据集，应用不会自动加载）。');
  lines.push('- 训练参数默认**不启用**：`getDifficultyProfile(difficulty)` 只在 `setLearnedProfilesEnabled(true)` 后合并 `src/ai/data/learnedProfiles.json`。');
  lines.push('- 启用方式：UI 设置项「使用训练后参数」对应 localStorage key `holdem-learned-profiles-v1`（`src/ui/storage.ts` 的 `loadLearnedProfilesEnabled` / `saveLearnedProfilesEnabled`），最终通过 `setLearnedProfilesEnabled(true)` 让 `getDifficultyProfile` 合并训练参数；若当前设置栏未显示该开关，可在应用入口显式调用 `setLearnedProfilesEnabled(true)`。');
  lines.push('- 训练脚本本身不依赖该全局开关：每次决策都通过 `profileOverride` 显式传入参数，因此训练 / 评估结果不受 UI 开关影响。');
  lines.push('- 重新训练：`npm run train:quick`（快速）或 `npm run train`（全量）；Windows 可双击 `训练机器人.bat`。');
  lines.push('- 训练完成后需要刷新页面 / 重建前端（`npm run build`）才能让最新的 JSON 进入打包产物。');
  lines.push('');

  lines.push('## 7. 注意事项与已知限制');
  lines.push('');
  lines.push('- 样本量有限：快速模式每轮每档只评估 25 手、最终对照 100 手；默认模式每轮 60 手、最终对照 240 手。BB/100 的置信区间较宽，0.5 BB/100 的接受阈值仍可能放进噪声。');
  lines.push('- 参数可能过拟合：同一 seed 的配对评估只能降低牌局噪声，不能消除策略对特定对手（同档基础参数）的过拟合。');
  lines.push('- 可重复训练：`learnedProfiles.json` 已存在时，下一次训练会从该文件继续；建议先用 `--seed=...` 换种子多次训练，再观察参数是否稳定。');
  lines.push('- 四档风格：入门档的入池线、诈唬频率、半诈唬频率都设了比高难度更窄 / 更保守的边界，避免训练把 beginner 变紧、expert 变松。');
  lines.push('- 入门档边界：beginner 的 `preflop.play` 限制在 [0.05, 0.30]，避免训练把入门 AI 变紧；由于 beginner 决策分支只实际读取 `preflop.play` 与不可变异的 `errorRate`，入门档其余可变异字段（加注/诈唬/翻牌后阈值）通常没有行为差异，因此入门档的有效训练维度主要是 play。');
  lines.push('- 训练全程本地完成：不联网、不调用大模型、不调用任何付费服务；LLM 经验库与 SFT 数据集都只是静态文件，供本地模型做 few-shot / 可选微调。');
  lines.push('- SFT 数据集受 exhibition 手数限制：默认 120 手最多约 240 条有效样本，SFT 上限为 400 行；需要更多数据时可提高 `--exhibition` 手数。');
  lines.push('- 本报告每次训练自动覆盖；训练数据写入 `src/ai/data/` 与 `training/`，其中 `src/ai/data/` 下的 JSON 会被 Vite 打包进前端。');
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 文件写入与主流程                                                    */
/* ------------------------------------------------------------------ */

function decodeFileUrl(url: string): string {
  let path = url.replace(/^file:\/\//i, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    // 保留原字符串。
  }
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return path.replace(/\\/g, '/');
}

function normalizeForCompare(path: string): string {
  let normalized = path.replace(/\\/g, '/');
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // 忽略非法转义。
  }
  if (/^\/[A-Za-z]:/.test(normalized)) normalized = normalized.slice(1);
  return normalized.replace(/\/+$/, '').toLowerCase();
}

/** 判断当前模块是否是 Node 的直接入口（被 import 时不执行训练）。 */
export function isDirectRun(entryPath: string | undefined, moduleUrl: string): boolean {
  if (!entryPath) return false;
  return normalizeForCompare(entryPath) === normalizeForCompare(decodeFileUrl(moduleUrl));
}

const SCRIPT_DIR = (() => {
  const path = decodeFileUrl(import.meta.url);
  return path.slice(0, path.lastIndexOf('/'));
})();
const PROJECT_ROOT = `${SCRIPT_DIR}/..`;
const LEARNED_PROFILES_PATH = `${PROJECT_ROOT}/src/ai/data/learnedProfiles.json`;
const LLM_EXPERIENCE_PATH = `${PROJECT_ROOT}/src/ai/data/llm-experience.json`;
const SFT_DATASET_PATH = `${PROJECT_ROOT}/training/llm-sft-dataset.jsonl`;
const REPORT_PATH = `${PROJECT_ROOT}/training/REPORT.md`;

function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

async function writeTextFile(path: string, text: string): Promise<void> {
  const fs = await loadFs();
  fs.mkdirSync(directoryOf(path), { recursive: true });
  fs.writeFileSync(path, text, 'utf8');
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parsePositiveInteger(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`参数 --${name} 需要正整数，收到：${raw || '(空)'}`);
  }
  return value;
}

function parseNonNegativeInteger(raw: string, name: string): number {
  const value = Number(raw);
  if (!raw.trim() || !Number.isInteger(value) || value < 0) {
    throw new Error(`参数 --${name} 需要非负整数（0 表示关闭并行），收到：${raw || '(空)'}`);
  }
  return value;
}

/** 解析命令行参数。 */
export function resolveTrainOptions(argv: readonly string[]): TrainOptions {
  const quick = argv.includes('--quick');
  const defaults = quick ? QUICK_DEFAULTS : FULL_DEFAULTS;
  const options: TrainOptions = { quick, ...defaults };

  for (const argument of argv) {
    if (!argument.startsWith('--')) continue;
    if (argument === '--no-parallel') {
      options.workers = 0;
      continue;
    }
    const equalIndex = argument.indexOf('=');
    const name = equalIndex >= 0 ? argument.slice(2, equalIndex) : argument.slice(2);
    const value = equalIndex >= 0 ? argument.slice(equalIndex + 1) : '';
    switch (name) {
      case 'quick':
        break;
      case 'seed':
        if (!value.trim()) throw new Error('参数 --seed 不能为空');
        options.seed = value.trim();
        break;
      case 'hands':
        options.hands = parsePositiveInteger(value, 'hands');
        break;
      case 'rounds':
        options.rounds = parsePositiveInteger(value, 'rounds');
        if (options.rounds > MAX_TRAIN_ROUNDS) {
          throw new Error(
            `参数 --rounds 单次上限 ${MAX_TRAIN_ROUNDS}（更大规模请分多次训练，训练参数会继续累积）`,
          );
        }
        break;
      case 'mutations':
        options.mutations = parsePositiveInteger(value, 'mutations');
        break;
      case 'exhibition':
        options.exhibition = parsePositiveInteger(value, 'exhibition');
        break;
      case 'mc':
        options.mcIterations = parsePositiveInteger(value, 'mc');
        break;
      case 'workers':
        options.workers = parseNonNegativeInteger(value, 'workers');
        break;
      default:
        throw new Error(`未知参数：--${name}`);
    }
  }
  return options;
}

/* ------------------------------------------------------------------ */
/* 多核并行评估（worker_threads，单文件 worker 入口）                  */
/* ------------------------------------------------------------------ */

interface EvaluationParentPort {
  on(event: 'message', listener: (message: unknown) => void): void;
  postMessage(value: unknown): void;
}

interface EvaluationWorkerPort {
  on(event: 'message', listener: (message: unknown) => void): void;
  on(event: 'error', listener: (error: unknown) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  postMessage(value: unknown): void;
  terminate(): Promise<number>;
}

interface WorkerThreadsModule {
  Worker: new (
    filename: URL,
    options?: {
      execArgv?: string[];
      env?: Record<string, string | undefined>;
    },
  ) => EvaluationWorkerPort;
  parentPort: EvaluationParentPort | null;
}

interface OsModule {
  availableParallelism?: () => number;
  cpus?: () => unknown[];
}

interface EvaluationPoolJob {
  id: number;
  options: EvaluateCandidateOptions;
  resolve: (result: SelfPlayResult) => void;
  reject: (error: unknown) => void;
}

interface EvaluationPoolSlot {
  worker: EvaluationWorkerPort;
  busy: boolean;
  failed: boolean;
  job: EvaluationPoolJob | null;
}

/** 最多使用 16 个 worker：默认 60 手/轮时 4 档 × (基准 + 3 候选) 正好填满。 */
const MAX_EVALUATION_WORKERS = 16;

async function loadWorkerThreads(): Promise<WorkerThreadsModule> {
  const moduleName = 'node:worker_threads';
  const imported = (await import(/* @vite-ignore */ moduleName)) as unknown;
  return imported as WorkerThreadsModule;
}

async function detectCpuCount(): Promise<number> {
  try {
    const moduleName = 'node:os';
    const imported = (await import(/* @vite-ignore */ moduleName)) as unknown as OsModule;
    if (typeof imported.availableParallelism === 'function') {
      const count = imported.availableParallelism();
      if (Number.isFinite(count) && count > 0) return Math.floor(count);
    }
    if (typeof imported.cpus === 'function') {
      const count = imported.cpus().length;
      if (Number.isFinite(count) && count > 0) return Math.floor(count);
    }
  } catch {
    // 无法读取 CPU 信息时退化为单线程。
  }
  return 1;
}

/** 继承 tsx 的 loader，但去掉 --eval，避免 worker 把主进程的 -e 代码当成入口。 */
function workerExecArgv(): string[] {
  const result: string[] = [];
  let skipNext = false;
  for (const argument of process.execArgv) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (argument === '--eval' || argument === '-e') {
      skipNext = true;
      continue;
    }
    if (argument.startsWith('--eval=')) continue;
    result.push(argument);
  }
  return result;
}

/** worker 线程入口：监听主线程发来的评估任务。 */
async function runEvaluationWorker(): Promise<void> {
  const threads = await loadWorkerThreads();
  const port = threads.parentPort;
  if (!port) return;
  port.on('message', (message) => {
    void handleEvaluationWorkerJob(port, message);
  });
}

async function handleEvaluationWorkerJob(
  port: EvaluationParentPort,
  raw: unknown,
): Promise<void> {
  const job = raw as { id?: unknown; options?: unknown } | null;
  if (!job || typeof job.id !== 'number') return;
  try {
    const result = await evaluateCandidate(job.options as EvaluateCandidateOptions);
    port.postMessage({ id: job.id, ok: true, result });
  } catch (error) {
    port.postMessage({
      id: job.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 固定大小的评估 worker 池。
 * - 任务按空闲 worker 分发，单个 worker 可连续处理多个任务；
 * - worker 启动 / 运行失败时拒绝该任务，由上层回退到进程内评估；
 * - 不依赖 ready 握手：主线程消息会排在 MessagePort 中等待 worker 监听。
 */
class EvaluationPool {
  private readonly slots: EvaluationPoolSlot[] = [];
  private readonly queue: EvaluationPoolJob[] = [];
  private nextId = 1;
  private closed = false;

  private constructor() {}

  static async create(size: number): Promise<EvaluationPool | null> {
    if (size <= 0) return null;
    const threads = await loadWorkerThreads().catch(() => null);
    if (!threads) return null;
    const pool = new EvaluationPool();
    const execArgv = workerExecArgv();
    for (let index = 0; index < size; index++) {
      try {
        const worker = new threads.Worker(new URL(import.meta.url), {
          execArgv,
          env: { ...process.env, HOLDEM_TRAIN_WORKER: '1' },
        });
        const slot: EvaluationPoolSlot = {
          worker,
          busy: false,
          failed: false,
          job: null,
        };
        pool.slots.push(slot);
        pool.attach(slot);
      } catch {
        // 单个 worker 创建失败：继续使用其余 worker。
      }
    }
    return pool.slots.length > 0 ? pool : null;
  }

  get size(): number {
    return this.slots.length;
  }

  run(options: EvaluateCandidateOptions): Promise<SelfPlayResult> {
    if (this.closed || this.slots.length === 0) {
      return Promise.reject(new Error('并行评估池不可用'));
    }
    return new Promise<SelfPlayResult>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, options, resolve, reject });
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending = this.queue.splice(0);
    for (const job of pending) job.reject(new Error('并行评估池已关闭'));
    const slots = this.slots.splice(0);
    await Promise.all(
      slots.map(async (slot) => {
        if (slot.job) {
          slot.job.reject(new Error('并行评估池已关闭'));
          slot.job = null;
        }
        try {
          await slot.worker.terminate();
        } catch {
          // 忽略终止错误。
        }
      }),
    );
  }

  private attach(slot: EvaluationPoolSlot): void {
    slot.worker.on('message', (message) => this.handleMessage(slot, message));
    slot.worker.on('error', (error) => this.handleFailure(slot, error));
    slot.worker.on('exit', (code) => {
      if (!this.closed) {
        this.handleFailure(slot, new Error(`并行评估 worker 退出（${code}）`));
      }
    });
  }

  private handleMessage(slot: EvaluationPoolSlot, raw: unknown): void {
    const message = raw as {
      id?: unknown;
      ok?: unknown;
      result?: unknown;
      error?: unknown;
    } | null;
    if (
      !message ||
      !slot.job ||
      typeof message.id !== 'number' ||
      message.id !== slot.job.id
    ) {
      return;
    }
    const job = slot.job;
    slot.job = null;
    slot.busy = false;
    if (message.ok === true) {
      job.resolve(message.result as SelfPlayResult);
    } else {
      job.reject(
        new Error(typeof message.error === 'string' ? message.error : '并行评估失败'),
      );
    }
    this.dispatch();
  }

  private handleFailure(slot: EvaluationPoolSlot, error: unknown): void {
    if (slot.failed) return;
    slot.failed = true;
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    if (slot.job) {
      const job = slot.job;
      slot.job = null;
      job.reject(error);
    }
    slot.busy = false;
    try {
      void slot.worker.terminate();
    } catch {
      // 忽略：worker 可能已退出。
    }
    if (this.slots.length === 0) {
      const pending = this.queue.splice(0);
      for (const job of pending) job.reject(error);
    } else {
      this.dispatch();
    }
  }

  private dispatch(): void {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (this.queue.length === 0) break;
      if (slot.busy || slot.failed) continue;
      const job = this.queue.shift();
      if (!job) break;
      slot.busy = true;
      slot.job = job;
      try {
        slot.worker.postMessage({ id: job.id, options: job.options });
      } catch (error) {
        slot.busy = false;
        slot.job = null;
        job.reject(error);
        this.handleFailure(slot, error);
        return;
      }
    }
  }
}

export interface EvaluationAccelerator {
  runner: EvaluationRunner;
  /** 实际 worker 数。 */
  size: number;
  /** 本机 CPU 核数。 */
  cpuCount: number;
  /** worker 失败后回退进程内评估的次数。 */
  fallbacks: () => number;
  close: () => Promise<void>;
}

/**
 * 根据 CPU 核数与轮数决定是否启用并行：
 * - workers = 0：强制单线程；
 * - workers > 0：显式指定（仍受 CPU 核数与 16 上限约束）；
 * - 未指定：轮数 >= 2 且多核时自动启用，1 轮保持单线程以省去 worker 启动开销。
 */
async function createEvaluationAccelerator(
  options: TrainOptions,
): Promise<EvaluationAccelerator | null> {
  if (options.workers === 0) return null;
  const explicit = options.workers !== undefined;
  if (!explicit && options.rounds < 2) return null;
  const cpuCount = await detectCpuCount();
  if (!explicit && cpuCount < 2) return null;
  const requested = options.workers ?? cpuCount;
  const size = Math.max(
    0,
    Math.min(MAX_EVALUATION_WORKERS, cpuCount, Math.floor(requested)),
  );
  if (size <= 1) return null;
  const pool = await EvaluationPool.create(size);
  if (!pool) return null;
  let fallbacks = 0;
  const runner: EvaluationRunner = async (evaluation) => {
    try {
      return await pool.run(evaluation);
    } catch {
      fallbacks++;
      return evaluateCandidate(evaluation);
    }
  };
  return {
    runner,
    size: pool.size,
    cpuCount,
    fallbacks: () => fallbacks,
    close: () => pool.close(),
  };
}

async function main(): Promise<void> {
  const options = resolveTrainOptions(process.argv.slice(2));
  const generatedAt = new Date().toISOString();
  const startTime = Date.now();
  const modeText = options.quick ? '快速模式' : '默认全量模式';

  console.log('====================================================');
  console.log(' 本地德州扑克 · 自博弈训练');
  console.log('====================================================');
  console.log(
    `[训练] ${modeText} | seed=${options.seed} | hands=${options.hands} | rounds=${options.rounds} | ` +
      `mutations=${options.mutations} | exhibition=${options.exhibition} | mc=${options.mcIterations}`,
  );
  console.log('[训练] 覆盖对象：规则引擎机器人（四档参数进化）+ 大模型机器人（few-shot 经验库 + SFT 数据集）');

  const useLearned = hasLearnedProfiles();
  console.log(
    `[训练] ${useLearned ? '检测到已有训练参数，从 learnedProfiles.json 继续' : '未检测到训练参数，从基础档位开始'}`,
  );

  const accelerator = await createEvaluationAccelerator(options);
  if (accelerator) {
    console.log(
      `[加速] 检测到 ${accelerator.cpuCount} 个 CPU 核心，启用 ${accelerator.size} 个 worker 并行评估（4 档同时进化）`,
    );
  } else {
    console.log(
      '[加速] 本次使用单线程评估（轮数 < 2 或 worker 不可用；可用 --workers=N 指定、--no-parallel 关闭）',
    );
  }

  const runDifficulty = async (
    difficulty: Difficulty,
  ): Promise<DifficultyTrainingResult> => {
    const startProfile = useLearned
      ? getDifficultyProfile(difficulty, true)
      : BASE_DIFFICULTY_PROFILES[difficulty];
    console.log('');
    console.log(
      `[训练] ${DIFFICULTY_LABELS[difficulty]}（${difficulty}）开始，起始 play=${startProfile.preflop.play}、` +
        `raise=${startProfile.preflop.raise}、bluffRate=${startProfile.postflop.bluffRate}`,
    );
    const result = await trainDifficulty({
      difficulty,
      startProfile,
      hands: options.hands,
      rounds: options.rounds,
      mutations: options.mutations,
      mcIterations: options.mcIterations,
      seed: options.seed,
      runner: accelerator?.runner,
      onProgress: (message) => console.log(message),
    });
    console.log(
      `[训练] ${DIFFICULTY_LABELS[difficulty]} 完成：baseline ${formatBB100(
        result.baselineBB100,
      )} → trained ${formatBB100(result.trainedBB100)} BB/100，` +
        `接受 ${result.acceptedMutations} 个变异，共 ${result.handsPlayed} 手`,
    );
    return result;
  };

  let results: DifficultyTrainingResult[] = [];
  try {
    if (accelerator) {
      results = await Promise.all(
        DIFFICULTY_ORDER.map((difficulty) => runDifficulty(difficulty)),
      );
    } else {
      for (const difficulty of DIFFICULTY_ORDER) {
        results.push(await runDifficulty(difficulty));
      }
    }
  } finally {
    if (accelerator) {
      await accelerator.close();
      if (accelerator.fallbacks() > 0) {
        console.log(`[加速] worker 异常回退单进程评估 ${accelerator.fallbacks()} 次`);
      }
    }
  }
  const totalTrainingHands = results.reduce(
    (sum, result) => sum + result.handsPlayed,
    0,
  );

  const finalProfiles: Record<Difficulty, DifficultyProfile> = {
    beginner: BASE_DIFFICULTY_PROFILES.beginner,
    normal: BASE_DIFFICULTY_PROFILES.normal,
    hard: BASE_DIFFICULTY_PROFILES.hard,
    expert: BASE_DIFFICULTY_PROFILES.expert,
  };
  for (const result of results) finalProfiles[result.difficulty] = result.finalProfile;

  console.log('');
  console.log(
    `[经验] 开始 exhibition 自博弈（${options.exhibition} 手，收集 hard/expert 决策样本）...`,
  );
  const exhibition = await runExhibition({
    hands: options.exhibition,
    mcIterations: options.mcIterations,
    seed: `${options.seed}-exhibition`,
    hardProfile: finalProfiles.hard,
    expertProfile: finalProfiles.expert,
    startingStack: TRAIN_STARTING_STACK,
    smallBlind: TRAIN_SMALL_BLIND,
    bigBlind: TRAIN_BIG_BLIND,
  });
  const examples = exhibition.examples;
  console.log(
    `[经验] 完成：${exhibition.result.hands} 手，生成 ${examples.length} 条样本，` +
      `回退动作 ${exhibition.result.fallbackActions} 次`,
  );

  const sftSamples = buildSftSamples(exhibition.result.samples, MAX_SFT_EXAMPLES);
  console.log(
    `[SFT] 生成 ${sftSamples.length} 行大模型训练数据（hard/expert、合法且未回退；上限 ${MAX_SFT_EXAMPLES}）`,
  );

  const metrics: Record<Difficulty, DifficultyMetric> = {
    beginner: { baselineBB100: 0, trainedBB100: 0, acceptedMutations: 0, rounds: 0, hands: 0 },
    normal: { baselineBB100: 0, trainedBB100: 0, acceptedMutations: 0, rounds: 0, hands: 0 },
    hard: { baselineBB100: 0, trainedBB100: 0, acceptedMutations: 0, rounds: 0, hands: 0 },
    expert: { baselineBB100: 0, trainedBB100: 0, acceptedMutations: 0, rounds: 0, hands: 0 },
  };
  for (const result of results) {
    metrics[result.difficulty] = {
      baselineBB100: result.baselineBB100,
      trainedBB100: result.trainedBB100,
      acceptedMutations: result.acceptedMutations,
      rounds: result.rounds.length,
      hands: result.handsPlayed,
    };
  }

  const learnedFile = buildLearnedProfilesFile({
    generatedAt,
    hands: totalTrainingHands,
    seed: options.seed,
    profiles: finalProfiles,
    metrics,
  });
  const experienceFile: LlmExperienceFile = {
    generatedAt,
    hands: exhibition.result.hands,
    examples,
  };

  const elapsedMs = Date.now() - startTime;
  const report = renderReport({
    options,
    generatedAt,
    elapsedMs,
    totalTrainingHands,
    results,
    exhibitionHands: exhibition.result.hands,
    examples,
    sftSamples,
    workerCount: accelerator?.size ?? 0,
    cpuCount: accelerator?.cpuCount ?? 1,
  });

  await writeJsonFile(LEARNED_PROFILES_PATH, learnedFile);
  await writeJsonFile(LLM_EXPERIENCE_PATH, experienceFile);
  await writeTextFile(SFT_DATASET_PATH, renderSftJsonl(sftSamples.map((sample) => sample.record)));
  await writeTextFile(REPORT_PATH, report);

  const changedTiers = results.filter(
    (result) => diffProfile(result.startProfile, result.finalProfile).length > 0,
  ).length;
  const totalAccepted = results.reduce(
    (sum, result) => sum + result.acceptedMutations,
    0,
  );

  console.log('');
  console.log('====================================================');
  console.log(`[完成] 耗时 ${formatDuration(elapsedMs)}`);
  console.log(`[完成] 规则引擎参数：src/ai/data/learnedProfiles.json（${totalTrainingHands} 手）`);
  console.log(`[完成] LLM few-shot 经验库：src/ai/data/llm-experience.json（${examples.length} 条）`);
  console.log(`[完成] LLM SFT 数据集：training/llm-sft-dataset.jsonl（${sftSamples.length} 行）`);
  console.log('[完成] 训练报告：training/REPORT.md');
  console.log(
    `[摘要] 规则机器人 4 档参数${changedTiers > 0 ? '已更新' : '未变化'}（${changedTiers}/4 档有改动，共接受 ${totalAccepted} 个变异）`,
  );
  console.log('====================================================');
}

if (process.env.HOLDEM_TRAIN_WORKER === '1') {
  // 同一个文件既是主入口也是 worker 入口：只注册评估消息监听，不启动训练主流程。
  void runEvaluationWorker().catch(() => {
    process.exitCode = 1;
  });
} else if (isDirectRun(process.argv[1], import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`[训练] 失败：${message}`);
    process.exitCode = 1;
  });
}
