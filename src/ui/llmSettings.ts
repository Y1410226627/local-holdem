/**
 * 大模型 / AI 设置（纯 UI 层）：玩家名称、多个大模型玩家、AI 军师、神态语句开关。
 *
 * 规则引擎只认识 `LlmSeatConfig`；本文件负责把设置弹窗里的可编辑字段
 * 变成引擎可用配置，并在读取 localStorage 时做类型收敛与旧版本迁移。
 */
import { MAX_LLM_SEATS, type LlmSeatConfig } from '../game/types';
import { LLM_SETTINGS_KEY, readJsonStorage, writeJsonStorage } from './storage';

export const DEFAULT_HUMAN_NAME = '你';

/** 本地算法机器人默认名称（可被用户覆盖）。 */
export const DEFAULT_LOCAL_BOT_NAMES: readonly string[] = ['阿豪', '小雅', '老陈', '莉莉', '大鹏'];

export const MAX_LOCAL_BOTS = 5;

/** 大模型玩家设置（slot 由数组顺序决定：1..MAX_LLM_SEATS）。 */
export interface LlmSlotSettings {
  slot: number;
  enabled: boolean;
  name: string;
  /** 场上人物设定：性格 / 说话风格 / 打法倾向（可留空）。 */
  persona: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 0..2。 */
  temperature: number;
  /** 单次请求超时毫秒数。 */
  timeoutMs: number;
  /** 单次输出 token 上限。 */
  maxTokens: number;
}

/** AI 军师（辅助人类玩家分析局势 / 闲聊，中文输出）。 */
export interface AdvisorSettings {
  /** 是否显示 / 启用军师面板。 */
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  timeoutMs: number;
  maxTokens: number;
}

export interface LlmSettings {
  seats: LlmSlotSettings[];
  advisor: AdvisorSettings;
  /** 是否允许大模型玩家输出神态 / 语句（额外消耗少量 token，默认关闭）。 */
  tableTalk: boolean;
  humanName: string;
  localBotNames: string[];
}

const SEAT_TEMPLATES: ReadonlyArray<Pick<LlmSlotSettings, 'baseUrl' | 'model'>> = [
  { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  { baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' },
  { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:14b' },
  { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
];

const DEFAULT_ADVISOR: AdvisorSettings = {
  enabled: false,
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen2.5:7b',
  apiKey: '',
  temperature: 0.4,
  timeoutMs: 60_000,
  maxTokens: 800,
};

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];

/** 大模型座位显示名（槽位号 → 大模型①…）。 */
export function seatLabel(slot: number): string {
  return `大模型${CIRCLED[slot - 1] ?? `#${slot}`}`;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function createSeat(slot: number, overrides: Partial<LlmSlotSettings> = {}): LlmSlotSettings {
  const template = SEAT_TEMPLATES[(slot - 1) % SEAT_TEMPLATES.length];
  return {
    slot,
    enabled: false,
    name: seatLabel(slot),
    persona: '',
    baseUrl: template.baseUrl,
    model: template.model,
    apiKey: '',
    temperature: 0.5,
    timeoutMs: 60_000,
    maxTokens: 1200,
    ...overrides,
  };
}

function sanitizeSeat(raw: unknown, slot: number): LlmSlotSettings {
  const fallback = createSeat(slot);
  if (!raw || typeof raw !== 'object') return fallback;
  const record = raw as Record<string, unknown>;
  return {
    slot,
    enabled: asBoolean(record.enabled, fallback.enabled),
    name: asString(record.name, fallback.name),
    persona: asString(record.persona, ''),
    baseUrl: asString(record.baseUrl, fallback.baseUrl),
    model: asString(record.model, fallback.model),
    apiKey: asString(record.apiKey, ''),
    temperature: clampNumber(record.temperature, 0, 2, fallback.temperature),
    timeoutMs: Math.round(clampNumber(record.timeoutMs, 1000, 300_000, fallback.timeoutMs)),
    maxTokens: Math.round(clampNumber(record.maxTokens, 32, 32_000, fallback.maxTokens)),
  };
}

function sanitizeAdvisor(raw: unknown): AdvisorSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_ADVISOR };
  const record = raw as Record<string, unknown>;
  return {
    enabled: asBoolean(record.enabled, DEFAULT_ADVISOR.enabled),
    baseUrl: asString(record.baseUrl, DEFAULT_ADVISOR.baseUrl),
    model: asString(record.model, DEFAULT_ADVISOR.model),
    apiKey: asString(record.apiKey, ''),
    temperature: clampNumber(record.temperature, 0, 2, DEFAULT_ADVISOR.temperature),
    timeoutMs: Math.round(clampNumber(record.timeoutMs, 1000, 300_000, DEFAULT_ADVISOR.timeoutMs)),
    maxTokens: Math.round(clampNumber(record.maxTokens, 32, 32_000, DEFAULT_ADVISOR.maxTokens)),
  };
}

function sanitizeLocalBotNames(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  return Array.from({ length: MAX_LOCAL_BOTS }, (_item, index) => {
    const value = list[index];
    return asString(value, '');
  });
}

export function createDefaultLlmSettings(): LlmSettings {
  return {
    seats: [createSeat(1), createSeat(2)],
    advisor: { ...DEFAULT_ADVISOR },
    tableTalk: false,
    humanName: DEFAULT_HUMAN_NAME,
    localBotNames: [...DEFAULT_LOCAL_BOT_NAMES],
  };
}

/** 读取持久化设置；兼容旧的「两个固定槽位」格式，自动迁移。 */
export function loadLlmSettings(): LlmSettings {
  const parsed = readJsonStorage(LLM_SETTINGS_KEY);
  if (!parsed || typeof parsed !== 'object') return createDefaultLlmSettings();
  const record = parsed as Record<string, unknown>;

  let rawSeats: unknown[] | null = Array.isArray(record.seats) ? record.seats : null;
  if (!rawSeats && Array.isArray(record.slots)) {
    // 旧格式：{ slots: [{ slot: 1|2, ... }] } → 迁移为动态 seats
    rawSeats = (record.slots as unknown[])
      .filter((item) => !!item && typeof item === 'object')
      .sort((a, b) => Number((a as { slot?: unknown }).slot ?? 0) - Number((b as { slot?: unknown }).slot ?? 0));
  }
  const seats = (rawSeats ?? [])
    .slice(0, MAX_LLM_SEATS)
    .map((item, index) => sanitizeSeat(item, index + 1));

  return {
    seats,
    advisor: sanitizeAdvisor(record.advisor),
    tableTalk: asBoolean(record.tableTalk, false),
    humanName: asString(record.humanName, DEFAULT_HUMAN_NAME),
    localBotNames: sanitizeLocalBotNames(record.localBotNames),
  };
}

export function saveLlmSettings(settings: LlmSettings): void {
  writeJsonStorage(LLM_SETTINGS_KEY, settings);
}

/** 添加一个大模型玩家（默认禁用，需手动填写 / 启用）。 */
export function addLlmSeat(settings: LlmSettings): LlmSettings {
  if (settings.seats.length >= MAX_LLM_SEATS) return settings;
  const slot = settings.seats.length + 1;
  return { ...settings, seats: [...settings.seats, createSeat(slot)] };
}

/** 删除指定座位，并重新编号（保持 1..N 连续）。 */
export function removeLlmSeat(settings: LlmSettings, slot: number): LlmSettings {
  const remaining = settings.seats
    .filter((seat) => seat.slot !== slot)
    .map((seat, index) => ({ ...seat, slot: index + 1 }));
  return { ...settings, seats: remaining };
}

/** 更新单个座位，返回新对象（不修改入参）。 */
export function updateLlmSeat(
  settings: LlmSettings,
  slot: number,
  patch: Partial<Omit<LlmSlotSettings, 'slot'>>,
): LlmSettings {
  return {
    ...settings,
    seats: settings.seats.map((seat) =>
      seat.slot === slot
        ? sanitizeSeat(
            {
              ...seat,
              ...patch,
              temperature: patch.temperature ?? seat.temperature,
              timeoutMs: patch.timeoutMs ?? seat.timeoutMs,
              maxTokens: patch.maxTokens ?? seat.maxTokens,
            },
            slot,
          )
        : seat,
    ),
  };
}

export function getLlmSeat(settings: LlmSettings, slot: number): LlmSlotSettings {
  return settings.seats.find((seat) => seat.slot === slot) ?? createSeat(slot);
}

/** 座位设置 → 引擎配置。 */
export function toLlmSeatConfig(seat: LlmSlotSettings): LlmSeatConfig {
  return {
    slot: seat.slot,
    name: seat.name.trim() || seatLabel(seat.slot),
    persona: seat.persona.trim() ? seat.persona.trim() : undefined,
    baseUrl: seat.baseUrl.trim(),
    model: seat.model.trim(),
    apiKey: seat.apiKey.trim() ? seat.apiKey.trim() : undefined,
    temperature: seat.temperature,
    timeoutMs: seat.timeoutMs,
    maxTokens: seat.maxTokens,
    enabled: seat.enabled,
  };
}

/** 只返回已启用的座位配置，按座位号排序（传给 createTable）。 */
export function enabledLlmSeatConfigs(settings: LlmSettings): LlmSeatConfig[] {
  return settings.seats
    .filter((seat) => seat.enabled)
    .sort((a, b) => a.slot - b.slot)
    .map((seat) => ({ ...toLlmSeatConfig(seat), enabled: true }));
}

export function enabledLlmSlotCount(settings: LlmSettings): number {
  return settings.seats.filter((seat) => seat.enabled).length;
}

/** 找出某个座位中已启用的配置（AI 驱动每次行动前读取当前设置）。 */
export function findEnabledLlmSlot(
  settings: LlmSettings,
  slot: number,
): LlmSlotSettings | undefined {
  return settings.seats.find((seat) => seat.slot === slot && seat.enabled);
}

export function llmSeatSummary(seat: LlmSlotSettings): string {
  const name = seat.name.trim() || seatLabel(seat.slot);
  const model = seat.model.trim() || '未填写模型';
  return `${name}（${model}）`;
}

/* ----------------------------- 军师 ----------------------------- */

export function updateAdvisorSettings(
  settings: LlmSettings,
  patch: Partial<AdvisorSettings>,
): LlmSettings {
  return {
    ...settings,
    advisor: sanitizeAdvisor({ ...settings.advisor, ...patch }),
  };
}

/** 军师设置 → LLM 客户端配置。 */
export function toAdvisorConfig(settings: LlmSettings): {
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature: number;
  timeoutMs: number;
  maxTokens: number;
} {
  const advisor = settings.advisor;
  return {
    baseUrl: advisor.baseUrl.trim(),
    model: advisor.model.trim(),
    apiKey: advisor.apiKey.trim() ? advisor.apiKey.trim() : undefined,
    temperature: advisor.temperature,
    timeoutMs: advisor.timeoutMs,
    maxTokens: advisor.maxTokens,
  };
}

export function advisorReady(settings: LlmSettings): boolean {
  const advisor = settings.advisor;
  return advisor.baseUrl.trim().length > 0 && advisor.model.trim().length > 0;
}

/* --------------------------- 玩家名称 --------------------------- */

export function resolvedHumanName(settings: LlmSettings): string {
  return settings.humanName.trim() || DEFAULT_HUMAN_NAME;
}

/** 取实际入座的本地机器人名称（不足时回退默认名）。 */
export function localBotNamesFor(settings: LlmSettings, count: number): string[] {
  return Array.from({ length: Math.max(0, Math.min(count, MAX_LOCAL_BOTS)) }, (_item, index) => {
    const custom = settings.localBotNames[index]?.trim();
    return custom || DEFAULT_LOCAL_BOT_NAMES[index] || `机器人${index + 1}`;
  });
}

export function setLocalBotName(settings: LlmSettings, index: number, name: string): LlmSettings {
  const names = [...settings.localBotNames];
  while (names.length < MAX_LOCAL_BOTS) names.push('');
  names[index] = name;
  return { ...settings, localBotNames: names };
}
