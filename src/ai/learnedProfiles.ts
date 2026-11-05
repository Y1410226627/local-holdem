/**
 * 训练参数加载（自博弈训练产物）。
 *
 * `scripts/train.ts` 会把四档 AI 的调优结果写入
 * `src/ai/data/learnedProfiles.json`。为了不影响单元测试的确定性，
 * 训练参数默认不启用，需要 UI 设置里的「使用训练后参数」显式开启
 * （`setLearnedProfilesEnabled(true)`）。
 */
import type { Difficulty } from '../game/types';
import type { DifficultyProfile, PostflopProfile, PreflopProfile } from './difficulty';
import learnedData from './data/learnedProfiles.json';

/** 训练脚本写入的难度覆盖参数（允许只覆盖部分字段）。 */
export interface DifficultyProfileOverride {
  key?: Difficulty;
  label?: string;
  style?: string;
  preflop?: Partial<PreflopProfile>;
  postflop?: Partial<PostflopProfile>;
}

export interface LearnedProfilesFile {
  generatedAt?: string | null;
  hands?: number;
  seed?: string | null;
  profiles?: Partial<Record<Difficulty, DifficultyProfileOverride>>;
  metrics?: Record<string, unknown> | null;
}

export const learnedProfilesData = learnedData as LearnedProfilesFile;

let learnedEnabled = false;

export function setLearnedProfilesEnabled(enabled: boolean): void {
  learnedEnabled = enabled;
}

export function isLearnedProfilesEnabled(): boolean {
  return learnedEnabled;
}

/** 是否已经存在可用的训练参数。 */
export function hasLearnedProfiles(): boolean {
  const profiles = learnedProfilesData.profiles;
  if (!profiles) return false;
  return Object.values(profiles).some(
    (profile) => profile !== undefined && Object.keys(profile).length > 0,
  );
}

function mergeSection<T extends object>(base: T, override: Partial<T> | undefined): T {
  const merged: T = { ...base };
  if (!override) return merged;
  for (const key of Object.keys(override) as (keyof T)[]) {
    const value = override[key];
    if (value === undefined) continue;
    const baseValue = base[key];
    if (
      baseValue !== null &&
      typeof baseValue === 'object' &&
      !Array.isArray(baseValue) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      merged[key] = { ...(baseValue as object), ...(value as object) } as T[keyof T];
    } else {
      merged[key] = value as T[keyof T];
    }
  }
  return merged;
}

/** 把训练覆盖参数合并进基础难度档位（返回新对象，不修改入参）。 */
export function mergeProfile(
  base: DifficultyProfile,
  override?: DifficultyProfileOverride,
): DifficultyProfile {
  if (!override) return base;
  return {
    ...base,
    ...override,
    preflop: mergeSection(base.preflop, override.preflop),
    postflop: mergeSection(base.postflop, override.postflop),
  };
}

/** 某个难度是否有训练覆盖参数。 */
export function hasLearnedProfile(difficulty: Difficulty): boolean {
  const override = learnedProfilesData.profiles?.[difficulty];
  return override !== undefined && Object.keys(override).length > 0;
}
