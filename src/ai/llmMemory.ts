/**
 * 大模型玩家的「对局记忆」：把每手牌结束后的复盘存入浏览器 localStorage，
 * 下次决策时作为极简英文经验注入提示词（HIST 行），让大模型跨局积累经验。
 *
 * 注意：仅存公开信息 + 该模型自己的底牌与行动，不涉及其他玩家底牌（摊牌公开的除外）。
 * 槽位类型为 number（支持 1..5 个甚至更多大模型玩家）。
 */
import type { Card } from '../game/types';
import { cardLabel, cardsLabel } from '../game/cards';

export type LlmHandOutcome = 'win' | 'lose' | 'split';

export interface LlmHandMemory {
  slot: number;
  handNo: number;
  hole: string;
  board: string;
  actions: string[];
  result: LlmHandOutcome;
  /** 本手净收益（筹码）。 */
  net: number;
  note: string;
  at: number;
}

const STORAGE_KEY = 'holdem-llm-memory-v1';
const MAX_TOTAL = 500;
const MAX_PER_SLOT = 80;

let fallbackMemories: LlmHandMemory[] = [];

function localStorageAvailable(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function isSlot(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 99;
}

function readAll(): LlmHandMemory[] {
  if (!localStorageAvailable()) return fallbackMemories.slice();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is LlmHandMemory =>
        !!item && typeof item === 'object' && isSlot((item as LlmHandMemory).slot),
    );
  } catch {
    return [];
  }
}

function writeAll(memories: LlmHandMemory[]): void {
  const trimmed = memories.slice(-MAX_TOTAL);
  if (!localStorageAvailable()) {
    fallbackMemories = trimmed;
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    fallbackMemories = trimmed;
  }
}

/** 读取某个大模型玩家的历史对局记忆（旧 → 新）。 */
export function loadHandMemories(slot: number): LlmHandMemory[] {
  return readAll()
    .filter((memory) => memory.slot === slot)
    .slice(-MAX_PER_SLOT);
}

export function appendHandMemory(memory: LlmHandMemory): void {
  const all = readAll();
  all.push(memory);
  const slots = new Set(all.map((item) => item.slot));
  writeAll(
    [...slots].flatMap((slot) =>
      all.filter((item) => item.slot === slot).slice(-MAX_PER_SLOT),
    ),
  );
}

export function clearHandMemories(slot?: number): void {
  if (slot === undefined) {
    writeAll([]);
    return;
  }
  writeAll(readAll().filter((memory) => memory.slot !== slot));
}

export function memoryCount(slot: number): number {
  return loadHandMemories(slot).length;
}

function memoryResultLabel(result: LlmHandOutcome): string {
  return result === 'win' ? 'win' : result === 'lose' ? 'lose' : 'split';
}

/** 供 LLM 提示词使用的极简英文经验行（不包含中文复盘，省 token）。 */
export function memoryPromptLines(slot: number, limit = 2): string[] {
  return loadHandMemories(slot)
    .slice(-limit)
    .map((memory) => {
      const net = `${memory.net >= 0 ? '+' : ''}${memory.net}`;
      const board = memory.board || '-';
      const actions = memory.actions.slice(-4).join(' > ');
      return `HIST hole ${memory.hole.replace(/\s+/g, '')} board ${board.replace(
        /\s+/g,
        '',
      )} ${memoryResultLabel(memory.result)} ${net}${actions ? ` [${actions}]` : ''}`;
    });
}

export interface BuildHandMemoryParams {
  slot: number;
  handNo: number;
  holeCards: readonly Card[];
  board: readonly Card[];
  actions: string[];
  result: LlmHandOutcome;
  net: number;
  note: string;
}

export function buildHandMemory(params: BuildHandMemoryParams): LlmHandMemory {
  return {
    slot: params.slot,
    handNo: params.handNo,
    hole: cardsLabel(params.holeCards),
    board: cardsLabel(params.board),
    actions: params.actions.slice(-8),
    result: params.result,
    net: params.net,
    note: params.note,
    at: Date.now(),
  };
}

/** 把玩家动作转成简短中文记录，供记忆 / 提示词使用。 */
export function describeActionForMemory(
  action: { type: string; amount?: number },
  streetLabel: string,
): string {
  switch (action.type) {
    case 'fold':
      return `${streetLabel}弃牌`;
    case 'check':
      return `${streetLabel}过牌`;
    case 'call':
      return `${streetLabel}跟注`;
    case 'bet':
      return `${streetLabel}下注 ${action.amount ?? ''}`.trim();
    case 'raise':
      return `${streetLabel}加注到 ${action.amount ?? ''}`.trim();
    case 'allin':
      return `${streetLabel}全下`;
    default:
      return `${streetLabel}${action.type}`;
  }
}

/** 底牌文本（调试 / 测试辅助）。 */
export function holeCardsLabel(cards: readonly Card[]): string {
  return cards.map(cardLabel).join(' ');
}
