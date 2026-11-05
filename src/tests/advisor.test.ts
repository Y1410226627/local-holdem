import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPlayerView } from '../game/playerView';
import { askAdvisor, buildAdvisorMessages, testAdvisorConnection } from '../ai/advisor';
import { CC, makeHand, playToStreet } from './helpers';

const CONFIG = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'advisor-model',
  temperature: 0.4,
  timeoutMs: 5000,
  maxTokens: 800,
};

function mockReply(content: string, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
        { status, headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function flopView() {
  const hand = makeHand({
    holeCards: [CC('Ah Kh'), CC('2c 3c'), CC('4d 5d'), CC('6s 7s')],
    board: CC('Qh 9d 4c 2s 7h'),
  });
  const flop = playToStreet(hand, 'flop');
  const view = buildPlayerView(flop, 0, 'advisor-test');
  return { flop, view };
}

describe('AI 军师：提示词与隐私', () => {
  it('中文系统提示 + 当前局势；包含自己的底牌，不包含对手底牌', () => {
    const { view } = flopView();
    const messages = buildAdvisorMessages(
      { view, difficultyLabel: '普通', recentActions: ['翻牌前 UTG 跟注 20'] },
      [],
      '这手该怎么打？',
    );
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('德州扑克');
    const userText = messages[messages.length - 1].content;
    expect(userText).toContain('A♥');
    expect(userText).toContain('K♥');
    expect(userText).toContain('Q♥');
    expect(userText).toContain('这手该怎么打？');
    // 对手底牌（2♣ 3♣ / 4♦ 5♦ / 6♠ 7♠）不应出现
    expect(userText).not.toContain('2♣');
    expect(userText).not.toContain('6♠');
    expect(userText).not.toContain('5♦');
  });

  it('没有进行中的手牌时也能回答（提示当前没有手牌）', () => {
    const messages = buildAdvisorMessages({ view: null }, [], '随便聊聊');
    expect(messages[messages.length - 1].content).toContain('没有进行中的手牌');
  });

  it('历史对话会包含在 messages 中，且裁剪旧消息', () => {
    const history = Array.from({ length: 10 }, (_item, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `历史消息 ${index}`,
    }));
    const messages = buildAdvisorMessages({ view: null }, history, '继续');
    expect(messages.length).toBeLessThanOrEqual(1 + 6 + 1);
    expect(messages[messages.length - 1].content).toContain('继续');
  });
});

describe('AI 军师：模型调用', () => {
  it('返回中文回答与延迟', async () => {
    mockReply('这手 A♥K♥ 在 Q 高翻牌有个卡顺，建议小额跟注或过牌看转牌。');
    const { view } = flopView();
    const reply = await askAdvisor(CONFIG, { view }, [], '这手该怎么打？');
    expect(reply.text).toContain('建议');
    expect(reply.latencyMs).toBeGreaterThanOrEqual(0);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as {
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.max_tokens).toBeGreaterThanOrEqual(800);
    expect(body.messages[0].content).toContain('中文');
  });

  it('空内容时抛可读错误（提示调大 token / 换模型）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '' }, finish_reason: 'length' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const { view } = flopView();
    await expect(askAdvisor(CONFIG, { view }, [], '分析一下')).rejects.toThrow(/空内容/);
  });

  it('testAdvisorConnection 成功 / 空内容 / HTTP 错误都不抛异常', async () => {
    mockReply('正常');
    expect((await testAdvisorConnection(CONFIG)).ok).toBe(true);

    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const empty = await testAdvisorConnection(CONFIG);
    expect(empty.ok).toBe(false);
    expect(empty.message).toContain('空内容');

    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const failed = await testAdvisorConnection(CONFIG);
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain('HTTP 500');
  });
});
