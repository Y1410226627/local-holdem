import { describe, expect, it } from 'vitest';
import { BASE_DIFFICULTY_PROFILES } from '../ai/difficulty';
import { mergeProfile, type LearnedProfilesFile } from '../ai/learnedProfiles';
import type { Card, Difficulty, LegalActions } from '../game/types';
import {
  buildExperienceExamples,
  buildLearnedProfilesFile,
  buildSftDataset,
  buildSftSamples,
  MAX_SFT_PREFLOP_EXAMPLES,
  diffProfile,
  evaluateCandidate,
  mutateProfile,
  renderReport,
  renderSftJsonl,
  resolveTrainOptions,
  runExhibition,
  trainDifficulty,
  validateProfileBounds,
  type DifficultyMetric,
  type DifficultyTrainingResult,
  type ExperienceDecisionSample,
} from '../../scripts/train';

const DIFFS: readonly Difficulty[] = ['beginner', 'normal', 'hard', 'expert'];

function card(rank: Card['rank'], suit: Card['suit']): Card {
  return { rank, suit };
}

const CARD_LABEL_PATTERN = /^(10|[2-9TJQKA])[♠♥♦♣]$/;

function legalFixture(overrides: Partial<LegalActions> = {}): LegalActions {
  return {
    playerId: 0,
    currentBet: 40,
    callAmount: 40,
    canFold: true,
    canCheck: false,
    canCall: true,
    canBet: false,
    canRaise: true,
    canAllIn: true,
    minRaiseTo: 80,
    maxRaiseTo: 1000,
    aggressiveType: 'raise',
    raiseRights: true,
    isAllInCall: false,
    ...overrides,
  };
}

const SFT_SAMPLE: ExperienceDecisionSample = {
  street: 'flop',
  position: 'late',
  hole: [card(14, 's'), card(13, 's')],
  board: [card(12, 'h'), card(9, 'd'), card(4, 'c')],
  pot: 120,
  currentBet: 40,
  callAmount: 40,
  facingBet: true,
  action: { type: 'call' },
  equity: 0.62,
  reasoning: '底池赔率合适，跟注。',
  difficulty: 'expert',
};

describe('自博弈训练脚本：纯函数', () => {
  it('同一种子下 evaluateCandidate 结果确定且为有限数字', async () => {
    const options = {
      difficulty: 'hard' as const,
      profile: BASE_DIFFICULTY_PROFILES.hard,
      opponentProfile: BASE_DIFFICULTY_PROFILES.hard,
      hands: 4,
      mcIterations: 20,
      seed: 'trainer-determinism',
    };
    const first = await evaluateCandidate(options);
    const second = await evaluateCandidate(options);

    expect(first.hands).toBe(4);
    expect(second.hands).toBe(4);
    expect(second.netChips).toBe(first.netChips);
    expect(second.bb100).toBe(first.bb100);
    expect(Number.isFinite(first.netChips)).toBe(true);
    expect(Number.isFinite(first.bb100)).toBe(true);
    expect(Number.isFinite(first.actions)).toBe(true);
  }, 15000);

  it('变异结果仍满足边界约束（hands=4、mc=20）', async () => {
    for (let index = 0; index < 24; index++) {
      for (const difficulty of DIFFS) {
        const base = BASE_DIFFICULTY_PROFILES[difficulty];
        const mutated = mutateProfile(base, difficulty, `mut-${difficulty}-${index}`);
        expect(validateProfileBounds(mutated, difficulty)).toEqual([]);
        expect(diffProfile(base, mutated).length).toBeGreaterThan(0);
        expect(mutated.key).toBe(difficulty);
        // 不在变异范围内的字段保持不变。
        expect(mutated.style).toBe(base.style);
        expect(mutated.label).toBe(base.label);
        expect(mutated.preflop.errorRate).toBe(base.preflop.errorRate);
        expect(mutated.preflop.openRaiseBB).toBe(base.preflop.openRaiseBB);
        expect(mutated.preflop.threeBetMultiplier).toBe(base.preflop.threeBetMultiplier);
        expect(mutated.postflop.mcIterations).toBe(base.postflop.mcIterations);
        expect(mutated.postflop.betSizes).toEqual(base.postflop.betSizes);
        expect(mutated.postflop.raiseSizes).toEqual(base.postflop.raiseSizes);
        expect(mutated.postflop.positionAware).toBe(base.postflop.positionAware);
      }
    }

    const mutant = mutateProfile(BASE_DIFFICULTY_PROFILES.hard, 'hard', 'eval-mutant');
    const result = await evaluateCandidate({
      difficulty: 'hard',
      profile: mutant,
      opponentProfile: BASE_DIFFICULTY_PROFILES.hard,
      hands: 4,
      mcIterations: 20,
      seed: 'trainer-bounds',
    });
    expect(result.hands).toBe(4);
    expect(Number.isFinite(result.bb100)).toBe(true);
    expect(validateProfileBounds(mutant, 'hard')).toEqual([]);

    // mutateProfile 支持冻结指定字段；其余字段仍可正常变异。
    const frozen = mutateProfile(
      BASE_DIFFICULTY_PROFILES.beginner,
      'beginner',
      'frozen-beginner',
      { frozenFields: ['preflop.play'] },
    );
    expect(frozen.preflop.play).toBe(
      BASE_DIFFICULTY_PROFILES.beginner.preflop.play,
    );
    expect(diffProfile(BASE_DIFFICULTY_PROFILES.beginner, frozen).length).toBeGreaterThan(0);
    expect(validateProfileBounds(frozen, 'beginner')).toEqual([]);
  }, 10000);

  it('buildExperienceExamples 输出符合 LlmExample、牌面合法且无 undefined', () => {
    const samples: ExperienceDecisionSample[] = [
      {
        street: 'flop',
        position: 'late',
        hole: [card(14, 's'), card(13, 's')],
        board: [card(12, 'h'), card(9, 'd'), card(4, 'c')],
        pot: 120,
        currentBet: 40,
        callAmount: 40,
        facingBet: true,
        action: { type: 'raise', amount: 120 },
        equity: 0.62,
        reasoning: '牌力很强，价值加注。'.repeat(12),
      },
      {
        street: 'preflop',
        position: 'early',
        hole: [card(7, 'h'), card(2, 'c')],
        board: [],
        pot: 30,
        currentBet: 20,
        callAmount: 20,
        facingBet: true,
        action: { type: 'fold' },
        reasoning: '太弱，弃牌',
      },
      {
        street: 'turn',
        position: 'blinds',
        hole: [card(10, 'd'), card(9, 'd')],
        board: [card(8, 'c'), card(5, 's'), card(2, 'h'), card(11, 'h')],
        pot: 200,
        currentBet: 0,
        callAmount: 0,
        facingBet: false,
        action: { type: 'check' },
        reasoning: '过牌控池',
      },
    ];

    const examples = buildExperienceExamples(samples);
    expect(examples).toHaveLength(3);

    for (const example of examples) {
      expect(example.hole.split(' ')).toHaveLength(2);
      for (const label of example.hole.split(' ')) {
        expect(label).toMatch(CARD_LABEL_PATTERN);
      }
      const board = example.board ?? '';
      expect(board === '' || board.split(' ').length >= 3).toBe(true);
      if (board !== '') {
        for (const label of board.split(' ')) {
          expect(label).toMatch(CARD_LABEL_PATTERN);
        }
      }
      expect(example.note?.length ?? 0).toBeLessThanOrEqual(80);
      for (const value of Object.values(example)) {
        expect(value).not.toBeUndefined();
      }
    }

    expect(examples[0].street).toBe('flop');
    expect(examples[0].amount).toBe(120);
    expect(examples[0].equity).toBe(0.62);
    expect(examples[1].board).toBe('');
    expect('amount' in examples[1]).toBe(false);
    expect(examples[2].facingBet).toBe(false);
    expect('amount' in examples[2]).toBe(false);

    // 结构不合法的样本被过滤：底牌数量错误 / 下注金额非法。
    const invalid = buildExperienceExamples([
      { ...samples[0], hole: [card(14, 's')] },
      { ...samples[0], action: { type: 'bet', amount: 0 } },
    ]);
    expect(invalid).toHaveLength(0);

    const limited = buildExperienceExamples(samples, 2);
    expect(limited).toHaveLength(2);
  });

  it('learnedProfiles 写入结构与 LearnedProfilesFile 兼容', () => {
    const metrics: Record<Difficulty, DifficultyMetric> = {
      beginner: { baselineBB100: -1.25, trainedBB100: 1.5, acceptedMutations: 1, rounds: 1, hands: 100 },
      normal: { baselineBB100: 0, trainedBB100: 0.75, acceptedMutations: 1, rounds: 2, hands: 240 },
      hard: { baselineBB100: -2, trainedBB100: 2.25, acceptedMutations: 2, rounds: 2, hands: 240 },
      expert: { baselineBB100: -3, trainedBB100: 3.5, acceptedMutations: 2, rounds: 2, hands: 240 },
    };
    const file = buildLearnedProfilesFile({
      generatedAt: '2026-01-01T00:00:00.000Z',
      hands: 820,
      seed: 'trainer-file',
      profiles: BASE_DIFFICULTY_PROFILES,
      metrics,
    });

    // 编译期类型检查：必须能直接赋给 LearnedProfilesFile。
    const typed: LearnedProfilesFile = file;
    const parsed = JSON.parse(JSON.stringify(typed)) as LearnedProfilesFile;

    expect(parsed.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.hands).toBe(820);
    expect(parsed.seed).toBe('trainer-file');
    expect(parsed.metrics).not.toBeNull();

    for (const difficulty of DIFFS) {
      const override = parsed.profiles?.[difficulty];
      expect(override).toBeDefined();
      expect(override?.preflop).toBeDefined();
      expect(override?.postflop).toBeDefined();
      // 只写可变异字段，key/label/style/betSizes 等仍来自基础档位。
      expect(override?.key).toBeUndefined();
      expect(override?.postflop?.betSizes).toBeUndefined();
      const merged = mergeProfile(BASE_DIFFICULTY_PROFILES[difficulty], override);
      expect(merged.key).toBe(difficulty);
      expect(merged.preflop.play).toBe(BASE_DIFFICULTY_PROFILES[difficulty].preflop.play);
      expect(merged.postflop.betSizes).toEqual(
        BASE_DIFFICULTY_PROFILES[difficulty].postflop.betSizes,
      );
      expect(merged.postflop.mcIterations).toBe(
        BASE_DIFFICULTY_PROFILES[difficulty].postflop.mcIterations,
      );
    }

    const expertMetric = parsed.metrics?.['expert'] as DifficultyMetric | undefined;
    expect(expertMetric?.baselineBB100).toBe(-3);
    expect(expertMetric?.trainedBB100).toBe(3.5);
    expect(expertMetric?.hands).toBe(240);
  });

  it('生成的 SFT JSONL 每行可解析、messages 为 3 条且 assistant 动作合法', async () => {
    const exhibition = await runExhibition({
      hands: 16,
      mcIterations: 20,
      seed: 'trainer-sft-structure',
      hardProfile: BASE_DIFFICULTY_PROFILES.hard,
      expertProfile: BASE_DIFFICULTY_PROFILES.expert,
    });
    const samples = buildSftSamples(exhibition.result.samples);

    expect(samples.length).toBeGreaterThan(0);
    expect(samples.length).toBeLessThanOrEqual(400);

    const jsonl = renderSftJsonl(samples.map((sample) => sample.record));
    const lines = jsonl.trimEnd().split('\n');
    expect(lines).toHaveLength(samples.length);

    for (const line of lines) {
      const parsed = JSON.parse(line) as { messages?: unknown };
      expect(Array.isArray(parsed.messages)).toBe(true);
      const messages = parsed.messages as Array<{ role: string; content: string }>;
      expect(messages).toHaveLength(3);
      expect(messages.map((message) => message.role)).toEqual([
        'system',
        'user',
        'assistant',
      ]);
      expect(messages[0].content).toContain('只输出一行 JSON');
      expect(messages[1].content).toMatch(/翻牌前|翻牌|转牌|河牌/);
      for (const field of [
        '你的底牌',
        '公共牌',
        '底池',
        '当前下注',
        '需跟注',
        '是否面对下注',
        '【合法动作】',
      ]) {
        expect(messages[1].content).toContain(field);
      }

      const action = JSON.parse(messages[2].content) as {
        action?: string;
        amount?: number;
        reason?: string;
      };
      expect(['fold', 'check', 'call', 'bet', 'raise', 'allin']).toContain(action.action);
      expect(typeof action.reason).toBe('string');
      expect((action.reason ?? '').length).toBeGreaterThan(0);
      if (action.action === 'bet' || action.action === 'raise') {
        expect(Number.isInteger(action.amount)).toBe(true);
        expect(action.amount as number).toBeGreaterThan(0);
      } else {
        expect(action.amount).toBeUndefined();
      }
    }
  }, 20000);

  it('SFT 数据集确定：同 seed 两次生成内容完全一致', async () => {
    const options = {
      hands: 10,
      mcIterations: 20,
      seed: 'trainer-sft-determinism',
      hardProfile: BASE_DIFFICULTY_PROFILES.hard,
      expertProfile: BASE_DIFFICULTY_PROFILES.expert,
    };
    const first = await runExhibition(options);
    const second = await runExhibition(options);
    const firstJsonl = renderSftJsonl(buildSftDataset(first.result.samples));
    const secondJsonl = renderSftJsonl(buildSftDataset(second.result.samples));

    expect(firstJsonl.length).toBeGreaterThan(0);
    expect(secondJsonl).toBe(firstJsonl);
    expect(second.result.samples).toHaveLength(first.result.samples.length);
  }, 20000);

  it('SFT 样本过滤合法动作并支持无 legal 时的安全描述', () => {
    // 有真实 legal：user 消息使用真实合法动作，并带加注区间。
    const withLegal = buildSftSamples([
      { ...SFT_SAMPLE, legal: legalFixture() },
    ]);
    expect(withLegal).toHaveLength(1);
    const legalUser = withLegal[0].record.messages[1].content;
    expect(legalUser).toContain('跟注 40');
    expect(legalUser).toContain('加注到 80–1000');
    expect(legalUser).toContain('全下');
    expect(legalUser).not.toContain('样本只记录本次合法动作');

    // 没有 legal：只描述该样本动作，不编造其它选项。
    const withoutLegal = buildSftSamples([SFT_SAMPLE]);
    expect(withoutLegal).toHaveLength(1);
    expect(withoutLegal[0].record.messages[1].content).toContain(
      '跟注 40（样本只记录本次合法动作，其余选项未记录）',
    );

    // 只保留 hard / expert、合法、动作明确的样本。
    expect(buildSftSamples([{ ...SFT_SAMPLE, difficulty: 'beginner' }])).toHaveLength(0);
    expect(
      buildSftSamples([
        {
          ...SFT_SAMPLE,
          legal: legalFixture({ canCall: false }),
          action: { type: 'call' },
        },
      ]),
    ).toHaveLength(0);
    expect(
      buildSftSamples([{ ...SFT_SAMPLE, action: { type: 'raise', amount: 40.5 } }]),
    ).toHaveLength(0);
    // 街道与公共牌数量不一致时过滤，避免伪造牌面。
    expect(
      buildSftSamples([{ ...SFT_SAMPLE, street: 'turn', board: SFT_SAMPLE.board }]),
    ).toHaveLength(0);

    const variants: ExperienceDecisionSample[] = [
      SFT_SAMPLE,
      { ...SFT_SAMPLE, hole: [card(10, 'd'), card(9, 'd')] },
      { ...SFT_SAMPLE, hole: [card(7, 'h'), card(2, 'c')] },
    ];
    expect(buildSftDataset(variants, 2)).toHaveLength(2);
  });

  it('训练报告包含规则引擎与大模型机器人训练数据章节', () => {
    const results: DifficultyTrainingResult[] = DIFFS.map((difficulty) => {
      const base = BASE_DIFFICULTY_PROFILES[difficulty];
      const mutated = mutateProfile(base, difficulty, `report-${difficulty}`);
      const changed = diffProfile(base, mutated).length > 0;
      return {
        difficulty,
        startProfile: base,
        finalProfile: mutated,
        baselineBB100: -1,
        trainedBB100: changed ? 1.5 : -1,
        acceptedMutations: changed ? 1 : 0,
        handsPlayed: 100,
        rounds: [],
      };
    });
    const firstChangedField = diffProfile(
      results[0].startProfile,
      results[0].finalProfile,
    )[0]?.field;

    const report = renderReport({
      options: {
        quick: true,
        seed: 'report-seed',
        hands: 25,
        rounds: 1,
        mutations: 2,
        exhibition: 40,
        mcIterations: 60,
      },
      generatedAt: '2026-01-01T00:00:00.000Z',
      elapsedMs: 2000,
      totalTrainingHands: 400,
      results,
      exhibitionHands: 40,
      examples: buildExperienceExamples([SFT_SAMPLE]),
      sftSamples: buildSftSamples([SFT_SAMPLE]),
      workerCount: 16,
      cpuCount: 16,
    });

    expect(report).toContain('## 2. 规则引擎机器人训练（四档参数进化）');
    expect(report).toContain('## 5. 大模型机器人训练数据');
    expect(report).toContain('并行评估：16 个 worker / 16 核');
    expect(report).toContain('使用训练后参数');
    expect(report).toContain('training/llm-sft-dataset.jsonl');
    expect(report).toContain('本项目不自动微调');
    expect(report).toContain('SFT 数据集行数：1 行');
    if (firstChangedField) expect(report).toContain(firstChangedField);
  });

  it('resolveTrainOptions 接受任意正整数轮数与并行 worker 配置', () => {
    const options = resolveTrainOptions([
      '--rounds=123',
      '--workers=8',
      '--seed=cli-parallel',
    ]);
    expect(options.rounds).toBe(123);
    expect(options.workers).toBe(8);
    expect(options.seed).toBe('cli-parallel');

    expect(resolveTrainOptions(['--rounds=5']).workers).toBeUndefined();
    expect(resolveTrainOptions(['--rounds=5', '--no-parallel']).workers).toBe(0);
    expect(resolveTrainOptions(['--rounds=5', '--workers=0']).workers).toBe(0);
    expect(resolveTrainOptions(['--rounds=10000']).rounds).toBe(10000);
    expect(() => resolveTrainOptions(['--rounds=10001'])).toThrow();
    expect(() => resolveTrainOptions(['--workers=-1'])).toThrow();
  });

  it('trainDifficulty 支持并发 runner，且四档训练结果结构完整', async () => {
    let active = 0;
    let maxActive = 0;
    const runner = async (options: Parameters<typeof evaluateCandidate>[0]) => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        return await evaluateCandidate(options);
      } finally {
        active--;
      }
    };

    const result = await trainDifficulty({
      difficulty: 'normal',
      startProfile: BASE_DIFFICULTY_PROFILES.normal,
      hands: 2,
      rounds: 1,
      mutations: 2,
      mcIterations: 20,
      seed: 'trainer-concurrent-runner',
      runner,
    });

    expect(result.difficulty).toBe('normal');
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].candidates).toHaveLength(2);
    expect(typeof result.rounds[0].bestDeltaBB100).toBe('number');
    expect(result.handsPlayed).toBeGreaterThan(0);
    // 基准 + 2 个候选应同时提交，验证并发 runner 生效。
    expect(maxActive).toBeGreaterThan(1);
    expect(validateProfileBounds(result.finalProfile, 'normal')).toEqual([]);
    expect(Number.isFinite(result.baselineBB100)).toBe(true);
    expect(Number.isFinite(result.trainedBB100)).toBe(true);
  }, 15000);

  it('SFT 翻牌前样本不超过上限，postflop 样本仍保留', () => {
    const preflop: ExperienceDecisionSample = {
      ...SFT_SAMPLE,
      street: 'preflop',
      board: [],
      pot: 30,
      currentBet: 20,
      callAmount: 20,
      facingBet: true,
      action: { type: 'fold' },
      reasoning: '早位太弱，弃牌。',
    };
    const many = Array.from(
      { length: MAX_SFT_PREFLOP_EXAMPLES + 40 },
      () => preflop,
    );
    const rows = buildSftSamples([...many, SFT_SAMPLE]);
    expect(rows.filter((row) => row.street === 'preflop')).toHaveLength(
      MAX_SFT_PREFLOP_EXAMPLES,
    );
    expect(rows.filter((row) => row.street === 'flop')).toHaveLength(1);
  });
});
