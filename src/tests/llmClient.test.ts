import { describe, expect, it, vi } from 'vitest';
import {
  callChatCompletion,
  extractChatContent,
  resolveChatCompletionsUrl,
} from '../ai/llmClient';

describe('LLM 客户端：返回内容提取', () => {
  it('提取标准 OpenAI content 字符串', () => {
    expect(
      extractChatContent({
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      }),
    ).toEqual({ content: 'hello', reasoning: '', finishReason: 'stop' });
  });

  it('提取数组形式 content 的文本片段', () => {
    const result = extractChatContent({
      choices: [
        {
          message: {
            content: [
              { type: 'text', text: 'foo' },
              { type: 'text', text: 'bar' },
            ],
          },
        },
      ],
    });
    expect(result.content).toBe('foobar');
  });

  it('提取 reasoning_content / thinking（思考型模型）', () => {
    const result = extractChatContent({
      choices: [
        {
          message: { content: '', reasoning_content: '让我想想', reasoning: undefined },
          finish_reason: 'length',
        },
      ],
    });
    expect(result.content).toBe('');
    expect(result.reasoning).toBe('让我想想');
    expect(result.finishReason).toBe('length');

    const thinking = extractChatContent({
      choices: [{ message: { content: 'ok', thinking: 'thinking...' } }],
    });
    expect(thinking.reasoning).toBe('thinking...');
  });

  it('兼容 Ollama 原生返回格式（response / message.content）', () => {
    expect(extractChatContent({ response: 'native' }).content).toBe('native');
    expect(extractChatContent({ message: { content: 'chat-native' } }).content).toBe('chat-native');
  });

  it('无法识别时返回空内容', () => {
    expect(extractChatContent({})).toEqual({ content: '', reasoning: '', finishReason: '' });
    expect(extractChatContent({ choices: [] })).toEqual({
      content: '',
      reasoning: '',
      finishReason: '',
    });
  });
});

describe('LLM 客户端：请求构造', () => {
  it('发送 max_tokens / temperature / Authorization，并返回提取后的内容', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"a":"call"}' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await callChatCompletion(
      {
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'm',
        apiKey: ' secret-key ',
        temperature: 0.2,
        maxTokens: 300,
      },
      [{ role: 'user', content: 'hi' }],
      { maxTokens: 1234 },
    );
    expect(result.content).toBe('{"a":"call"}');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      max_tokens: number;
      temperature: number;
      stream: boolean;
    };
    expect(body.max_tokens).toBe(1234);
    expect(body.temperature).toBe(0.2);
    expect(body.stream).toBe(false);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-key');
    vi.unstubAllGlobals();
  });

  it('HTTP 错误抛出可读 LlmError（404 提示 Base URL）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    await expect(
      callChatCompletion({ baseUrl: 'http://x/v1', model: 'm' }, [
        { role: 'user', content: 'hi' },
      ]),
    ).rejects.toThrow(/Base URL/);
    vi.unstubAllGlobals();
  });

  it('URL 规范化：补 /v1、去重复 chat/completions', () => {
    expect(resolveChatCompletionsUrl('http://x')).toBe('http://x/v1/chat/completions');
    expect(resolveChatCompletionsUrl('http://x/v1')).toBe('http://x/v1/chat/completions');
    expect(resolveChatCompletionsUrl('http://x/v1/chat/completions')).toBe(
      'http://x/v1/chat/completions',
    );
    expect(resolveChatCompletionsUrl('')).toBe('');
  });
});
