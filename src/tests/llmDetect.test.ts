import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LLM_PROBE_TARGETS,
  detectLocalLlmServices,
  slotPatchFromDetectedModel,
} from '../ui/llmDetect';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetchByUrl(handler: (url: string) => Response | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const response = handler(url);
      if (response) return response;
      throw new TypeError('Failed to fetch');
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('本地大模型服务自动探测', () => {
  it('识别 Ollama /api/tags 并转成 OpenAI 兼容 Base URL', async () => {
    mockFetchByUrl((url) => {
      if (url.includes(':11434/api/tags')) {
        return jsonResponse({
          models: [{ name: 'qwen2.5:7b' }, { name: 'deepseek-r1:7b' }],
        });
      }
      return null;
    });
    const services = await detectLocalLlmServices(300);
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({
      kind: 'ollama',
      port: 11434,
      baseUrl: 'http://127.0.0.1:11434/v1',
    });
    expect(services[0].models).toEqual(['qwen2.5:7b', 'deepseek-r1:7b']);
  });

  it('识别 LM Studio / vLLM 的 /v1/models 接口', async () => {
    mockFetchByUrl((url) => {
      if (url.includes(':1234/v1/models')) {
        return jsonResponse({ object: 'list', data: [{ id: 'lmstudio-community/qwen2.5-7b' }] });
      }
      if (url.includes(':8000/v1/models')) {
        return jsonResponse({ data: [{ id: 'Qwen/Qwen2.5-7B-Instruct' }] });
      }
      return null;
    });
    const services = await detectLocalLlmServices(300);
    expect(services.map((service) => service.port)).toEqual([1234, 8000]);
    expect(services[0].baseUrl).toBe('http://127.0.0.1:1234/v1');
    expect(services[1].kind).toBe('openai');
  });

  it('没有可访问服务时返回空数组且不抛错', async () => {
    mockFetchByUrl(() => null);
    await expect(detectLocalLlmServices(200)).resolves.toEqual([]);
  });

  it('忽略没有模型列表或返回错误的接口', async () => {
    mockFetchByUrl((url) => {
      if (url.includes(':11434')) return jsonResponse({ models: [] });
      if (url.includes(':1234')) return new Response('Not Found', { status: 404 });
      return null;
    });
    const services = await detectLocalLlmServices(200);
    expect(services).toEqual([]);
  });

  it('探测端口清单包含常见本地服务，且去重后按端口排序', () => {
    const ports = LLM_PROBE_TARGETS.map((target) => target.port);
    expect(ports).toContain(11434);
    expect(ports).toContain(1234);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('slotPatchFromDetectedModel 生成可直接填入的设置', () => {
    const patch = slotPatchFromDetectedModel(
      {
        kind: 'ollama',
        label: 'Ollama',
        rootUrl: 'http://127.0.0.1:11434',
        baseUrl: 'http://127.0.0.1:11434/v1',
        port: 11434,
        models: ['qwen2.5:7b'],
      },
      'qwen2.5:7b',
    );
    expect(patch).toEqual({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b',
      name: 'qwen2.5:7b',
    });
  });
});
