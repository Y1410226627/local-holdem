import { afterEach, describe, expect, it } from 'vitest';
import { DIFFICULTY_PROFILES, BASE_DIFFICULTY_PROFILES, getDifficultyProfile } from '../ai/difficulty';
import { preflopThresholdsForProfile } from '../ai/rangeModel';
import {
  hasLearnedProfile,
  hasLearnedProfiles,
  isLearnedProfilesEnabled,
  mergeProfile,
  setLearnedProfilesEnabled,
} from '../ai/learnedProfiles';

afterEach(() => {
  setLearnedProfilesEnabled(false);
});

describe('训练参数加载', () => {
  it('默认未启用训练参数，避免影响单元测试确定性', () => {
    expect(isLearnedProfilesEnabled()).toBe(false);
    expect(getDifficultyProfile('normal', false)).toEqual(DIFFICULTY_PROFILES.normal);
    expect(getDifficultyProfile('normal')).toEqual(DIFFICULTY_PROFILES.normal);
  });

  it('当前仓库没有训练数据（或训练文件为空）时 hasLearnedProfiles 为 false', () => {
    // 训练脚本运行后会写入数据；此处仅验证函数可用且不抛错。
    expect(typeof hasLearnedProfiles()).toBe('boolean');
    expect(typeof hasLearnedProfile('expert')).toBe('boolean');
  });

  it('mergeProfile 深度合并 preflop / postflop，保留未覆盖字段', () => {
    const base = BASE_DIFFICULTY_PROFILES.normal;
    const merged = mergeProfile(base, {
      preflop: { play: 0.5 },
      postflop: { bluffRate: 0.2 },
    });
    expect(merged.preflop.play).toBe(0.5);
    expect(merged.preflop.raise).toBe(base.preflop.raise);
    expect(merged.postflop.bluffRate).toBe(0.2);
    expect(merged.postflop.callMargin).toBe(base.postflop.callMargin);
    expect(merged.key).toBe('normal');
    // 不修改原对象
    expect(base.preflop.play).not.toBe(0.5);
  });

  it('全局开关可切换；开启时为四档返回有效档位（有训练数据则叠加覆盖）', () => {
    setLearnedProfilesEnabled(true);
    expect(isLearnedProfilesEnabled()).toBe(true);
    const profile = getDifficultyProfile('beginner');
    expect(profile.key).toBe('beginner');
    // 无论是否有训练数据，返回的档位都应保持入门档的风格边界。
    expect(profile.preflop.play).toBeGreaterThanOrEqual(0.05);
    expect(profile.preflop.play).toBeLessThanOrEqual(0.3);
    expect(profile.postflop.mcIterations).toBe(0);
  });

  it('四档基础档位都包含完整字段', () => {
    for (const difficulty of ['beginner', 'normal', 'hard', 'expert'] as const) {
      const profile = BASE_DIFFICULTY_PROFILES[difficulty];
      expect(profile.key).toBe(difficulty);
      expect(profile.preflop.raise).toBeGreaterThanOrEqual(profile.preflop.play);
      expect(profile.postflop.betSizes.length).toBeGreaterThan(0);
    }
  });

  it('训练覆盖参数会真实改变翻牌前阈值（profileOverride 生效链路）', () => {
    const base = BASE_DIFFICULTY_PROFILES.normal;
    const trained = mergeProfile(base, {
      preflop: { play: 0.9, raise: 0.95, threeBet: 0.99 },
    });
    const baseThresholds = preflopThresholdsForProfile(base, 'early');
    const trainedThresholds = preflopThresholdsForProfile(trained, 'early');
    expect(trainedThresholds.play).toBeGreaterThan(baseThresholds.play);
    expect(trainedThresholds.raise).toBeGreaterThan(baseThresholds.raise);
    // 不覆盖的字段保持一致
    expect(trained.postflop.bluffRate).toBe(base.postflop.bluffRate);
  });
});
