import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_PROFILE,
  DIFFICULTY_PROFILES,
  getChallengeProfile,
  getDifficultyProfile,
} from '../ai/difficulty';
import { preflopThresholdsForProfile } from '../ai/rangeModel';

describe('难度策略族：不是同一策略换噪声', () => {
  it('五档有明确的族标签', () => {
    expect(DIFFICULTY_PROFILES.beginner.family).toBe('station');
    expect(DIFFICULTY_PROFILES.normal.family).toBe('loose-passive');
    expect(DIFFICULTY_PROFILES.hard.family).toBe('tag');
    expect(DIFFICULTY_PROFILES.expert.family).toBe('balanced');
    expect(CHALLENGE_PROFILE.family).toBe('solver');
  });

  it('翻前入池线从松到紧单调（跟注站 → 松被动 → 紧凶 → 均衡）', () => {
    const late = (difficulty: keyof typeof DIFFICULTY_PROFILES) =>
      preflopThresholdsForProfile(DIFFICULTY_PROFILES[difficulty], 'late').play;
    expect(late('beginner')).toBeLessThan(late('normal'));
    expect(late('normal')).toBeLessThan(late('hard'));
    expect(late('hard')).toBeLessThan(late('expert'));
  });

  it('翻后风格可区分：跟注站少诈唬/宽跟注，均衡档诈唬更多/价值线更薄', () => {
    const beginner = DIFFICULTY_PROFILES.beginner.postflop;
    const expert = DIFFICULTY_PROFILES.expert.postflop;
    expect(beginner.bluffRate).toBeLessThan(expert.bluffRate);
    expect(beginner.semiBluffRate).toBeLessThan(expert.semiBluffRate);
    expect(beginner.valueThreshold).toBeGreaterThan(expert.valueThreshold);
    // 跟注站的 callMargin 为负：愿意用比底池赔率更差的牌跟注。
    expect(beginner.callMargin).toBeLessThan(0);
    expect(expert.callMargin).toBeGreaterThan(0);
  });

  it('挑战档使用求解器族，且不再复用专家档参数对象', () => {
    const challenge = getChallengeProfile();
    expect(challenge.family).toBe('solver');
    expect(challenge).not.toBe(DIFFICULTY_PROFILES.expert);
    expect(challenge.postflop.mcIterations).toBeGreaterThan(
      DIFFICULTY_PROFILES.expert.postflop.mcIterations,
    );
    expect(getDifficultyProfile('expert').family).toBe('balanced');
  });
});
