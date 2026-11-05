import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmSeatConfig } from '../game/types';
import { buildPlayerView } from '../game/playerView';
import { isActionLegal } from '../ai/aiPlayer';
import {
  LlmError,
  buildLlmPrompt,
  decideWithLlm,
  formatLegalActions,
  parseLlmAction,
  resolveChatCompletionsUrl,
  testLlmConnection,
} from '../ai/llmBot';
import {
  appendHandMemory,
  buildHandMemory,
  clearHandMemories,
  loadHandMemories,
  memoryPromptLines,
} from '../ai/llmMemory';
import { C, CC, makeHand, playSequence, playToStreet } from './helpers';

function modelConfig(overrides: Partial<LlmSeatConfig> = {}): LlmSeatConfig {
  return {
    slot: 1,
    name: '测试模型',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'test-model',
    temperature: 0.2,
    enabled: true,
    ...overrides,
  };
}

function actingView(hand: ReturnType<typeof makeHand>) {
  const index = hand.actingIndex!;
  return { hand, index, view: buildPlayerView(hand, hand.players[index].id, 'llm-test') };
}

interface MockReply {
  content?: string;
  reasoning?: string;
  finishReason?: string;
  status?: number;
}

function mockChatResponses(replies: MockReply[]): void {
  let cursor = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const reply = replies[Math.min(cursor, replies.length - 1)];
      cursor += 1;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: reply.content ?? '',
                reasoning_content: reply.reasoning ?? '',
              },
              finish_reason: reply.finishReason ?? 'stop',
            },
          ],
        }),
        { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
}

function mockChatResponse(content: string, status = 200): void {
  mockChatResponses([{ content, status }]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearHandMemories();
});

describe('LLM：URL 与提示词', () => {
  it('自动补齐 /v1 与 chat/completions 端点', () => {
    expect(resolveChatCompletionsUrl('http://127.0.0.1:11434')).toBe(
      'http://127.0.0.1:11434/v1/chat/completions',
    );
    expect(resolveChatCompletionsUrl('http://127.0.0.1:11434/v1/')).toBe(
      'http://127.0.0.1:11434/v1/chat/completions',
    );
    expect(resolveChatCompletionsUrl('http://127.0.0.1:1234/v1/chat/completions')).toBe(
      'http://127.0.0.1:1234/v1/chat/completions',
    );
  });

  it('提示词是精简英文：含自己的底牌、公开信息、合法动作，且不含对手底牌', () => {
    const hand = makeHand({
      holeCards: [CC('2h 3h'), CC('9s 9d'), CC('4c 5c'), CC('6d 7d')],
    });
    const { view } = actingView(hand);
    const { system, user } = buildLlmPrompt(view, 'normal', modelConfig());
    expect(system).toContain('No-Limit');
    expect(system).toContain('EXACTLY ONE compact JSON line');
    expect(user).toContain('LEGAL ');
    expect(user).toContain(formatLegalActions(view.legal!));
    expect(system + user).toContain('测试模型');
    // 自己的底牌应出现
    expect(user).toContain('6♦');
    expect(user).toContain('7♦');
    // 当前局面部分不应包含对手底牌（HINTS 是训练样本，可能含任意牌，单独截断）
    const currentSituation = user.split('HINTS')[0];
    expect(currentSituation).not.toContain('9♠');
    expect(currentSituation).not.toContain('4♣');
    expect(currentSituation).not.toContain('2♥');
  });

  it('翻牌后提示词包含公共牌与底池信息（BOARD / POT）', () => {
    const hand = makeHand({
      holeCards: [CC('Ah Kh'), CC('2c 3c'), CC('4d 5d'), CC('6s 7s')],
      board: CC('Qh 9d 4c 2s 7h'),
    });
    const flop = playToStreet(hand, 'flop');
    const index = flop.actingIndex!;
    const view = buildPlayerView(flop, flop.players[index].id, 'llm-test');
    const { user } = buildLlmPrompt(view, 'hard', modelConfig());
    expect(user).toContain('BOARD Q♥ 9♦ 4♣');
    expect(user).toContain('POT ');
    expect(user).toContain('HAND ');
  });

  it('人物设定写入提示词；未开启神态语句时不要求 say 字段', () => {
    const hand = makeHand();
    const { view } = actingView(hand);
    const { system } = buildLlmPrompt(
      view,
      'normal',
      modelConfig({ persona: '老派赌徒，说话阴阳怪气，喜欢诈唬' }),
    );
    expect(system).toContain('Persona: 老派赌徒');
    expect(system).not.toContain('"say"');
  });

  it('开启神态语句时提示词要求 say 字段，且示例 JSON 本身合法', () => {
    const hand = makeHand();
    const { view } = actingView(hand);
    const { system } = buildLlmPrompt(view, 'normal', modelConfig(), { talk: true });
    expect(system).toContain('"say"');
    // 示例必须是合法 JSON（曾经把 } 放错位置导致格式示例无效）；先替换占位符再解析。
    const specLine = system.split('\n').find((line) => line.includes('EXACTLY ONE compact JSON')) ?? '';
    const example = specLine
      .slice(specLine.indexOf('{'), specLine.lastIndexOf('}') + 1)
      .replace('<int, only bet/raise>', '100')
      .replace('<short English reason>', 'value')
      .replace('<short table talk, <=20 chars, Chinese ok>', 'nice hand');
    const parsed = JSON.parse(example) as Record<string, unknown>;
    expect(parsed).toMatchObject({ a: expect.any(String), w: expect.any(String), say: expect.any(String) });
  });
});

describe('LLM：输出解析与合法性', () => {
  it('解析标准 JSON 动作（长键名）', () => {
    const hand = makeHand();
    const { view } = actingView(hand);
    const parsed = parseLlmAction('{"action":"call","reason":"底池赔率合适"}', view.legal!);
    expect(parsed.action).toEqual({ type: 'call' });
    expect(parsed.reason).toContain('底池赔率');
    expect(parsed.repaired).toBe(false);
    expect(parsed.matched).toBe(true);
  });

  it('解析省 token 的短键 JSON（a / x / w / say）', () => {
    const hand = playSequence(makeHand(), [
      [3, { type: 'call' }],
      [0, { type: 'call' }],
      [1, { type: 'call' }],
      [2, { type: 'check' }],
    ]);
    const index = hand.actingIndex!;
    const view = buildPlayerView(hand, hand.players[index].id, 'llm-test');
    const parsed = parseLlmAction(
      '{"a":"bet","x":120,"w":"take it down","say":"这把我收了"}',
      view.legal!,
    );
    expect(parsed.action.type).toBe('bet');
    expect(parsed.reason).toBe('take it down');
    expect(parsed.talk).toBe('这把我收了');
    expect(isActionLegal(parsed.action, view.legal!)).toBe(true);
  });

  it('容忍 ```json 代码块与中文动作名', () => {
    const hand = makeHand();
    const { view } = actingView(hand);
    const parsed = parseLlmAction('```json\n{"action":"跟注","reason":"试试"}\n```', view.legal!);
    expect(parsed.action).toEqual({ type: 'call' });
    expect(parsed.matched).toBe(true);
  });

  it('加注金额越界会被修正为合法金额', () => {
    const hand = playSequence(makeHand(), [
      [3, { type: 'call' }],
      [0, { type: 'call' }],
      [1, { type: 'call' }],
      [2, { type: 'check' }],
    ]);
    const index = hand.actingIndex!;
    const view = buildPlayerView(hand, hand.players[index].id, 'llm-test');
    const parsed = parseLlmAction('{"action":"bet","amount":1,"reason":"小额下注"}', view.legal!);
    expect(isActionLegal(parsed.action, view.legal!)).toBe(true);
    expect(parsed.repaired).toBe(true);
  });

  it('无法解析时回退到合法安全动作，并标记 repaired / matched=false', () => {
    const hand = makeHand();
    const { view } = actingView(hand);
    const parsed = parseLlmAction('我觉得应该跟注，但我不输出 JSON', view.legal!);
    expect(isActionLegal(parsed.action, view.legal!)).toBe(true);
    expect(parsed.repaired).toBe(true);
    expect(parsed.matched).toBe(false);
  });

  it('动作不合法（如加注权关闭时加注）会回退为安全动作', () => {
    let hand = makeHand({ stacks: [1000, 1000, 35, 1000] });
    hand = playSequence(hand, [
      [3, { type: 'call' }],
      [0, { type: 'call' }],
      [1, { type: 'call' }],
      [2, { type: 'allin' }],
    ]);
    const index = hand.actingIndex!;
    const view = buildPlayerView(hand, hand.players[index].id, 'llm-test');
    expect(view.legal!.canRaise).toBe(false);
    const parsed = parseLlmAction('{"action":"raise","amount":100,"reason":"强行加注"}', view.legal!);
    expect(isActionLegal(parsed.action, view.legal!)).toBe(true);
    expect(parsed.action.type).not.toBe('raise');
    expect(parsed.matched).toBe(false);
  });

  it('神态语句会被清洗并截断', () => {
    const hand = makeHand();
    const { view } = actingView(hand);
    const parsed = parseLlmAction(
      JSON.stringify({ a: 'call', w: 'ok', say: '  这 手\n我 跟  ' + '啊'.repeat(60) }),
      view.legal!,
    );
    expect(parsed.talk).toBeTruthy();
    expect(parsed.talk!.length).toBeLessThanOrEqual(41);
    expect(parsed.talk!).not.toContain('\n');
  });
});

describe('LLM：网络调用、重试与错误处理', () => {
  it('decideWithLlm 返回合法动作与调试信息', async () => {
    mockChatResponse('{"action":"call","reason":"跟注看翻牌"}');
    const hand = makeHand();
    const { view } = actingView(hand);
    const decision = await decideWithLlm(view, 'normal', modelConfig());
    expect(decision.action).toEqual({ type: 'call' });
    expect(decision.debug.source).toBe('llm');
    expect(decision.debug.model).toBe('test-model');
    expect(decision.debug.latencyMs).toBeGreaterThanOrEqual(0);
    expect(decision.debug.reasoning).toContain('跟注');
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as { model: string; messages: unknown[] };
    expect(body.model).toBe('test-model');
    expect(body.messages.length).toBe(2);
  });

  it('思考型模型首次返回空内容（finish_reason=length）→ 自动重试并成功', async () => {
    mockChatResponses([
      { content: '', reasoning: '让我先想一想……', finishReason: 'length' },
      { content: '{"a":"call","w":"retry ok"}' },
    ]);
    const hand = makeHand();
    const { view } = actingView(hand);
    const decision = await decideWithLlm(view, 'normal', modelConfig());
    expect(decision.action).toEqual({ type: 'call' });
    expect(decision.debug.reasoning).toContain('重试');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('正文为空但 reasoning_content 里带 JSON 时可直接解析', async () => {
    mockChatResponses([
      { content: '', reasoning: '思考过程……\n{"a":"call","w":"from reasoning"}' },
    ]);
    const hand = makeHand();
    const { view } = actingView(hand);
    const decision = await decideWithLlm(view, 'normal', modelConfig());
    expect(decision.action).toEqual({ type: 'call' });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('两次都返回空内容时抛出可读 format 错误（含 finish_reason 提示）', async () => {
    mockChatResponses([
      { content: '', reasoning: '', finishReason: 'length' },
      { content: '', reasoning: '', finishReason: 'length' },
    ]);
    const hand = makeHand();
    const { view } = actingView(hand);
    await expect(decideWithLlm(view, 'normal', modelConfig())).rejects.toMatchObject({
      kind: 'format',
    });
    try {
      await decideWithLlm(view, 'normal', modelConfig());
    } catch (error) {
      expect((error as LlmError).message).toContain('空内容');
      expect((error as LlmError).message).toContain('finish_reason=length');
    }
  });

  it('网络失败时抛出中文 LlmError（含跨域提示）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const hand = makeHand();
    const { view } = actingView(hand);
    await expect(decideWithLlm(view, 'normal', modelConfig())).rejects.toMatchObject({
      kind: 'network',
    });
    try {
      await decideWithLlm(view, 'normal', modelConfig());
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError);
      expect((error as LlmError).message).toContain('无法连接');
      expect((error as LlmError).message).toContain('OLLAMA_ORIGINS');
    }
  });

  it('HTTP 404 提示 Base URL 配置问题', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Not Found', { status: 404 })),
    );
    const hand = makeHand();
    const { view } = actingView(hand);
    await expect(decideWithLlm(view, 'normal', modelConfig())).rejects.toThrow(/Base URL/);
  });

  it('testLlmConnection 成功返回延迟与样例', async () => {
    mockChatResponse('OK');
    const result = await testLlmConnection(modelConfig());
    expect(result.ok).toBe(true);
    expect(result.message).toContain('连接成功');
    expect(result.sample).toContain('OK');
  });

  it('testLlmConnection 遇到空内容时给出“思考 token 用尽”的可读提示', async () => {
    mockChatResponses([{ content: '', reasoning: '', finishReason: 'length' }]);
    const result = await testLlmConnection(modelConfig());
    expect(result.ok).toBe(false);
    expect(result.message).toContain('空内容');
  });

  it('testLlmConnection 失败不抛异常，返回可读错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('server error', { status: 500 })),
    );
    const result = await testLlmConnection(modelConfig());
    expect(result.ok).toBe(false);
    expect(result.message).toContain('HTTP 500');
  });

  it('Base URL 或模型名为空时快速失败', async () => {
    const hand = makeHand();
    const { view } = actingView(hand);
    await expect(decideWithLlm(view, 'normal', modelConfig({ baseUrl: '' }))).rejects.toThrow(
      /Base URL/,
    );
    await expect(decideWithLlm(view, 'normal', modelConfig({ model: '' }))).rejects.toThrow(
      /模型名称/,
    );
  });
});

describe('LLM：对局记忆', () => {
  it('写入与读取复盘记忆，并格式化为极简英文经验行', () => {
    appendHandMemory(
      buildHandMemory({
        slot: 1,
        handNo: 3,
        holeCards: CC('As Ah'),
        board: CC('Kd 7c 2s 9h 4d'),
        actions: ['翻牌前加注到 60', '翻牌下注 100'],
        result: 'win',
        net: 180,
        note: 'AA 翻牌前加注，翻牌持续下注拿下底池',
      }),
    );
    const memories = loadHandMemories(1);
    expect(memories).toHaveLength(1);
    expect(memories[0].hole).toContain('A♠');
    const lines = memoryPromptLines(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('A♠');
    expect(lines[0]).toContain('win +180');
    expect(lines[0]).toContain('HIST');
  });

  it('多个模型座位的记忆互不干扰，可单独清空', () => {
    appendHandMemory(
      buildHandMemory({
        slot: 1,
        handNo: 1,
        holeCards: [C('2c'), C('3c')],
        board: [],
        actions: [],
        result: 'lose',
        net: -20,
        note: '测试',
      }),
    );
    appendHandMemory(
      buildHandMemory({
        slot: 3,
        handNo: 1,
        holeCards: [C('4d'), C('5d')],
        board: [],
        actions: [],
        result: 'split',
        net: 0,
        note: '测试',
      }),
    );
    expect(loadHandMemories(1)).toHaveLength(1);
    expect(loadHandMemories(3)).toHaveLength(1);
    clearHandMemories(1);
    expect(loadHandMemories(1)).toHaveLength(0);
    expect(loadHandMemories(3)).toHaveLength(1);
  });
});
