/**
 * OpenAI 兼容 chat/completions 客户端（无 UI 依赖）。
 *
 * 只做三件事：
 * - 拼出 /chat/completions 地址并发送请求（支持超时 / 外部 AbortSignal）；
 * - 从各种返回格式里提取正文（content / 数组内容 / reasoning_content / Ollama 原生格式）；
 * - 把网络 / HTTP / 超时错误翻译成中文可操作提示。
 *
 * 是否重试、如何解析业务内容由上层（llmBot / advisor）决定。
 */

export type LlmErrorKind = 'network' | 'http' | 'timeout' | 'format';

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  /** 若 HTTP 成功但内容异常，带上 finish_reason（stop / length / ...）便于定位。 */
  readonly finishReason?: string;

  constructor(kind: LlmErrorKind, message: string, finishReason?: string) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.finishReason = finishReason;
  }
}

export interface LlmEndpointConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** 采样温度 0..2，默认 0.5。 */
  temperature?: number;
  /** 单次请求超时毫秒数，默认 60000。 */
  timeoutMs?: number;
  /** 单次输出 token 上限，默认 800。 */
  maxTokens?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCallResult {
  /** 模型正文（可能为空字符串，例如“思考”内容把 token 用尽）。 */
  content: string;
  /** reasoning_content / thinking 等思考内容（可能为空）。 */
  reasoning: string;
  /** stop / length / content_filter / ... */
  finishReason: string;
  latencyMs: number;
  raw: unknown;
}

export interface ChatCallOptions {
  signal?: AbortSignal;
  /** 覆盖配置里的 maxTokens。 */
  maxTokens?: number;
  /** 覆盖配置里的 temperature。 */
  temperature?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_TOKENS = 800;

/** 把用户填写的 Base URL 规范化为 chat/completions 端点。 */
export function resolveChatCompletionsUrl(baseUrl: string): string {
  let base = (baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/\/chat\/completions$/i.test(base)) return base;
  // Ollama 本地地址常省略 /v1，自动补齐。
  if (!/\/v\d+(?:beta)?$/i.test(base)) base += '/v1';
  return `${base}/chat/completions`;
}

function isAbortError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    ((error as { name?: string }).name === 'AbortError' ||
      (error as { code?: string }).code === 'ABORT_ERR')
  );
}

export function networkErrorMessage(): string {
  return [
    '无法连接大模型服务。请检查：',
    '1) 服务已启动（本地模型先运行 Ollama / LM Studio 等）；',
    '2) Base URL 正确（Ollama 默认 http://127.0.0.1:11434/v1，LM Studio 默认 http://127.0.0.1:1234/v1；',
    '   外部接口一般以 /v1 结尾）；',
    '3) 浏览器跨域：Ollama 需设置 OLLAMA_ORIGINS=*，LM Studio 需开启 CORS；',
    '   外部接口需允许浏览器跨域访问（CORS）。',
  ].join('');
}

export function timeoutErrorMessage(timeoutMs: number): string {
  return `大模型响应超时（${Math.round(timeoutMs / 1000)} 秒）。可以换更小的模型、关闭“思考”模式或调大超时时间。`;
}

function httpErrorMessage(status: number, body: string): string {
  const trimmed = body.trim().slice(0, 200);
  if (status === 401 || status === 403) {
    return `大模型鉴权失败（HTTP ${status}），请检查 API Key 配置。${trimmed ? ` 服务返回：${trimmed}` : ''}`;
  }
  if (status === 404) {
    return `接口路径不存在（HTTP 404）。Base URL 应为 OpenAI 兼容地址，例如 http://127.0.0.1:11434/v1。${trimmed ? ` 服务返回：${trimmed}` : ''}`;
  }
  if (status === 429) {
    return `请求过于频繁或额度不足（HTTP 429）。${trimmed ? ` 服务返回：${trimmed}` : ''}`;
  }
  return `大模型服务返回错误（HTTP ${status}）。${trimmed ? ` 服务返回：${trimmed}` : ''}`;
}

function textFromParts(parts: unknown): string {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => {
      if (typeof part === 'string') return part;
      const record = part as Record<string, unknown> | null;
      if (!record) return '';
      if (typeof record.text === 'string') return record.text;
      if (typeof record.content === 'string') return record.content;
      return '';
    })
    .join('');
}

/** 从 OpenAI 兼容 / Ollama 原生返回中提取正文与思考内容。 */
export function extractChatContent(data: unknown): {
  content: string;
  reasoning: string;
  finishReason: string;
} {
  const record = (data ?? {}) as Record<string, unknown>;
  let content = '';
  let reasoning = '';
  let finishReason = '';

  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = (choices[0] ?? {}) as Record<string, unknown>;
    finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : '';
    const message = (choice.message ?? {}) as Record<string, unknown>;
    content = textFromParts(message.content ?? choice.text);
    reasoning = textFromParts(
      message.reasoning_content ?? message.reasoning ?? message.thinking,
    );
  } else if (typeof record.response === 'string') {
    // 兼容 Ollama 原生 /api/generate 的返回格式
    content = record.response;
  } else if (typeof record.message === 'object' && record.message) {
    // 兼容 Ollama 原生 /api/chat 的返回格式
    const message = record.message as Record<string, unknown>;
    content = textFromParts(message.content);
    reasoning = textFromParts(message.thinking ?? message.reasoning_content);
  }

  return { content, reasoning, finishReason };
}

/** 发送一次 chat/completions 请求（不重试）。失败抛 LlmError。 */
export async function callChatCompletion(
  config: LlmEndpointConfig,
  messages: ChatMessage[],
  options: ChatCallOptions = {},
): Promise<ChatCallResult> {
  const baseUrl = (config.baseUrl ?? '').trim();
  const model = (config.model ?? '').trim();
  if (!baseUrl) throw new LlmError('format', '请先填写大模型的 Base URL');
  if (!model) throw new LlmError('format', '请先填写大模型的模型名称');
  const url = resolveChatCompletionsUrl(baseUrl);

  const timeoutMs =
    typeof config.timeoutMs === 'number' && config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const maxTokens =
    options.maxTokens ??
    (typeof config.maxTokens === 'number' && config.maxTokens > 0
      ? config.maxTokens
      : DEFAULT_MAX_TOKENS);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1000, timeoutMs));
  const onExternalAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey && config.apiKey.trim()) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  }

  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature:
          options.temperature ??
          (typeof config.temperature === 'number' ? config.temperature : 0.5),
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch {
        body = '';
      }
      throw new LlmError('http', httpErrorMessage(response.status, body));
    }
    const data: unknown = await response.json();
    const extracted = extractChatContent(data);
    return { ...extracted, latencyMs, raw: data };
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (isAbortError(error)) {
      if (timedOut) throw new LlmError('timeout', timeoutErrorMessage(timeoutMs));
      throw new LlmError('timeout', '大模型请求已取消。');
    }
    throw new LlmError('network', networkErrorMessage());
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
  }
}
