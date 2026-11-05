/**
 * 本地大模型机器人设置（纯 UI 层）：默认值、持久化、校验与座位配置转换。
 *
 * 规则引擎只认识 `LlmSeatConfig`；本文件负责把设置弹窗里的可编辑字段
 * 变成引擎可用的配置，并在读取 localStorage 时做类型收敛。
 */
import type { LlmSeatConfig } from '../game/types';
import {
  LLM_SETTINGS_KEY,
  readJsonStorage,
  writeJsonStorage,
} from './storage';

export interface LlmSlotSettings {
  slot: 1 | 2;
  enabled: boolean;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 0..2。 */
  temperature: number;
  /** 单次请求超时毫秒数。 */
  timeoutMs: number;
}

export interface LlmSettings {
  /** 固定两个槽位（slot 1 / 2）。 */
  slots: LlmSlotSettings[];
}

export const LLM_SLOT_LABELS: Record<1 | 2, string> = {
  1: '大模型①',
  2: '大模型②',
};

export const LLM_SLOT_DEFAULTS: readonly LlmSlotSettings[] = [
  {
    slot: 1,
    enabled: false,
    name: '大模型①',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    apiKey: '',
    temperature: 0.5,
    timeoutMs: 60_000,
  },
  {
    slot: 2,
    enabled: false,
    name: '大模型②',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    apiKey: '',
    temperature: 0.5,
    timeoutMs: 60_000,
  },
];

export function createDefaultLlmSettings(): LlmSettings {
  return { slots: LLM_SLOT_DEFAULTS.map((slot) => ({ ...slot })) };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function sanitizeString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function sanitizeSlot(raw: unknown, fallback: LlmSlotSettings): LlmSlotSettings {
  if (!raw || typeof raw !== 'object') return { ...fallback };
  const record = raw as Record<string, unknown>;
  return {
    slot: fallback.slot,
    enabled: typeof record.enabled === 'boolean' ? record.enabled : fallback.enabled,
    name: sanitizeString(record.name, fallback.name),
    baseUrl: sanitizeString(record.baseUrl, fallback.baseUrl),
    model: sanitizeString(record.model, fallback.model),
    apiKey: sanitizeString(record.apiKey, fallback.apiKey),
    temperature: clampNumber(record.temperature, 0, 2, fallback.temperature),
    timeoutMs: Math.round(clampNumber(record.timeoutMs, 1000, 300_000, fallback.timeoutMs)),
  };
}

/** 读取持久化设置；缺失 / 损坏 / 旧版本时回退到默认值。 */
export function loadLlmSettings(): LlmSettings {
  const parsed = readJsonStorage(LLM_SETTINGS_KEY);
  if (!parsed || typeof parsed !== 'object') return createDefaultLlmSettings();
  const record = parsed as Record<string, unknown>;
  const rawSlots = Array.isArray(record.slots) ? record.slots : null;
  if (!rawSlots) return createDefaultLlmSettings();

  const bySlot = new Map<number, unknown>();
  for (const rawSlot of rawSlots) {
    if (!rawSlot || typeof rawSlot !== 'object') continue;
    const slot = (rawSlot as Record<string, unknown>).slot;
    if (slot === 1 || slot === 2) bySlot.set(slot, rawSlot);
  }

  return {
    slots: LLM_SLOT_DEFAULTS.map((fallback) => sanitizeSlot(bySlot.get(fallback.slot), fallback)),
  };
}

export function saveLlmSettings(settings: LlmSettings): void {
  writeJsonStorage(LLM_SETTINGS_KEY, settings);
}

export function getLlmSlot(settings: LlmSettings, slot: 1 | 2): LlmSlotSettings {
  const found = settings.slots.find((item) => item.slot === slot);
  if (found) return found;
  const fallback = LLM_SLOT_DEFAULTS.find((item) => item.slot === slot) ?? LLM_SLOT_DEFAULTS[0];
  return { ...fallback };
}

/** 更新单个槽位，返回新对象（不修改入参）。 */
export function updateLlmSlot(
  settings: LlmSettings,
  slot: 1 | 2,
  patch: Partial<Omit<LlmSlotSettings, 'slot'>>,
): LlmSettings {
  return {
    slots: settings.slots.map((item) =>
      item.slot === slot
        ? {
            ...item,
            ...patch,
            slot,
            temperature: clampNumber(patch.temperature ?? item.temperature, 0, 2, item.temperature),
            timeoutMs: Math.round(
              clampNumber(patch.timeoutMs ?? item.timeoutMs, 1000, 300_000, item.timeoutMs),
            ),
          }
        : { ...item },
    ),
  };
}

/** 槽位设置 → 引擎座位配置（保留 enabled 字段，供测试连接 / 查找使用）。 */
export function toLlmSeatConfig(slot: LlmSlotSettings): LlmSeatConfig {
  const fallbackName = LLM_SLOT_LABELS[slot.slot];
  return {
    slot: slot.slot,
    name: slot.name.trim() || fallbackName,
    baseUrl: slot.baseUrl.trim(),
    model: slot.model.trim(),
    apiKey: slot.apiKey.trim() ? slot.apiKey.trim() : undefined,
    temperature: slot.temperature,
    timeoutMs: slot.timeoutMs,
    enabled: slot.enabled,
  };
}

/** 只返回已启用的座位配置，按槽位排序（传给 createTable）。 */
export function enabledLlmSeatConfigs(settings: LlmSettings): LlmSeatConfig[] {
  return settings.slots
    .filter((slot) => slot.enabled)
    .sort((a, b) => a.slot - b.slot)
    .map((slot) => ({ ...toLlmSeatConfig(slot), enabled: true }));
}

export function enabledLlmSlotCount(settings: LlmSettings): number {
  return settings.slots.filter((slot) => slot.enabled).length;
}

/** 找出某个槽位中已启用的配置（AI 驱动每次行动前读取当前设置）。 */
export function findEnabledLlmSlot(
  settings: LlmSettings,
  slot: 1 | 2,
): LlmSlotSettings | undefined {
  return settings.slots.find((item) => item.slot === slot && item.enabled);
}

export function llmSlotSummary(slot: LlmSlotSettings): string {
  const name = slot.name.trim() || LLM_SLOT_LABELS[slot.slot];
  const model = slot.model.trim() || '未填写模型';
  return `${name}（${model}）`;
}
