/**
 * 本机本地大模型服务自动探测（纯前端）。
 *
 * 扫描常见本地 LLM 服务端口，读取模型列表：
 * - Ollama：GET /api/tags
 * - LM Studio / vLLM / llama.cpp server 等 OpenAI 兼容服务：GET /v1/models
 *
 * 注意：浏览器直连本地服务仍受 CORS 限制；服务必须允许跨域
 * （Ollama 需 OLLAMA_ORIGINS=*，LM Studio 需开启 CORS），否则探测结果是“未发现”。
 */
import type { LlmSlotSettings } from './llmSettings';

export type LlmServiceKind = 'ollama' | 'openai';

export interface DetectedLlmService {
  kind: LlmServiceKind;
  /** 展示用服务名称，例如 Ollama / LM Studio。 */
  label: string;
  /** 服务根地址，例如 http://127.0.0.1:11434 */
  rootUrl: string;
  /** 可直接填入槽位的 OpenAI 兼容 Base URL，例如 http://127.0.0.1:11434/v1 */
  baseUrl: string;
  port: number;
  models: string[];
}

interface ProbeTarget {
  port: number;
  kind: LlmServiceKind;
  label: string;
}

/** 常见本地模型服务端口（可自行用「自定义 Base URL」连接其它端口）。 */
export const LLM_PROBE_TARGETS: readonly ProbeTarget[] = [
  { port: 11434, kind: 'ollama', label: 'Ollama' },
  { port: 1234, kind: 'openai', label: 'LM Studio' },
  { port: 8000, kind: 'openai', label: 'vLLM / OpenAI 兼容' },
  { port: 8080, kind: 'openai', label: 'llama.cpp server / OpenAI 兼容' },
  { port: 8081, kind: 'openai', label: 'OpenAI 兼容服务' },
  { port: 5000, kind: 'openai', label: 'OpenAI 兼容服务' },
  { port: 7860, kind: 'openai', label: 'OpenAI 兼容服务' },
  { port: 11435, kind: 'ollama', label: 'Ollama（备用端口）' },
  { port: 12345, kind: 'openai', label: 'OpenAI 兼容服务' },
];

export const LLM_PROBE_PORTS_TEXT = LLM_PROBE_TARGETS.map((target) => target.port).join('、');

const PROBE_HOSTS = ['127.0.0.1', 'localhost'] as const;

async function fetchJson(url: string, timeoutMs: number): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(300, timeoutMs));
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function ollamaModelNames(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const models = (payload as Record<string, unknown>).models;
  if (!Array.isArray(models)) return [];
  const names: string[] = [];
  for (const model of models) {
    if (typeof model === 'string') {
      names.push(model);
      continue;
    }
    if (!model || typeof model !== 'object') continue;
    const record = model as Record<string, unknown>;
    const name = record.name ?? record.model;
    if (typeof name === 'string' && name.trim()) names.push(name.trim());
  }
  return names;
}

function openAiModelNames(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  const names: string[] = [];
  for (const model of data) {
    if (typeof model === 'string') {
      names.push(model);
      continue;
    }
    if (!model || typeof model !== 'object') continue;
    const id = (model as Record<string, unknown>).id;
    if (typeof id === 'string' && id.trim()) names.push(id.trim());
  }
  return names;
}

interface ProbeHit {
  service: DetectedLlmService;
  host: string;
}

async function probeOnce(
  host: string,
  target: ProbeTarget,
  timeoutMs: number,
): Promise<ProbeHit | null> {
  const rootUrl = `http://${host}:${target.port}`;
  const [tagsPayload, modelsPayload] = await Promise.all([
    fetchJson(`${rootUrl}/api/tags`, timeoutMs),
    fetchJson(`${rootUrl}/v1/models`, timeoutMs),
  ]);
  const ollamaNames = ollamaModelNames(tagsPayload);
  const openAiNames = openAiModelNames(modelsPayload);
  const names = Array.from(new Set([...ollamaNames, ...openAiNames]));
  if (names.length === 0) return null;
  return {
    host,
    service: {
      kind: ollamaNames.length > 0 ? 'ollama' : target.kind,
      label: target.label,
      rootUrl,
      baseUrl: `${rootUrl}/v1`,
      port: target.port,
      models: names,
    },
  };
}

/**
 * 扫描本机常见端口上的本地大模型服务。
 * @param timeoutMs 单个请求超时，默认 1200ms（所有端口并行探测）。
 * @returns 去重后的服务列表；没有发现时返回 []。
 */
export async function detectLocalLlmServices(timeoutMs = 1200): Promise<DetectedLlmService[]> {
  const tasks: Promise<ProbeHit | null>[] = [];
  for (const target of LLM_PROBE_TARGETS) {
    for (const host of PROBE_HOSTS) {
      tasks.push(probeOnce(host, target, timeoutMs));
    }
  }
  const hits = (await Promise.all(tasks)).filter((hit): hit is ProbeHit => hit !== null);
  const byPort = new Map<number, DetectedLlmService>();
  // 优先保留 127.0.0.1 的结果（随后出现的 localhost 结果只用于合并模型名）。
  hits.sort((a, b) => (a.host === '127.0.0.1' ? -1 : 1) - (b.host === '127.0.0.1' ? -1 : 1));
  for (const hit of hits) {
    const existing = byPort.get(hit.service.port);
    if (!existing) {
      byPort.set(hit.service.port, hit.service);
      continue;
    }
    const merged = new Set([...existing.models, ...hit.service.models]);
    existing.models = Array.from(merged);
  }
  return Array.from(byPort.values()).sort((a, b) => a.port - b.port);
}

/** 把探测到的某个模型转成槽位补丁（一键填入）。 */
export function slotPatchFromDetectedModel(
  service: DetectedLlmService,
  model: string,
): Partial<Omit<LlmSlotSettings, 'slot'>> {
  return {
    baseUrl: service.baseUrl,
    model,
    name: model.length > 18 ? model.slice(0, 18) : model,
  };
}
