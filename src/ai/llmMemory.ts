/**
 * 大模型机器人的「对局记忆」：把每手牌结束后的复盘存入浏览器 localStorage，
 * 下次决策时作为 few-shot 经验注入提示词，让本地大模型在一局又一局中积累经验。
 *
 * 注意：仅存公开信息 + 该模型自己的底牌与行动，不涉及其他玩家底牌（摊牌公开的除外）。
 */
import type { Card } from '../game/types';
import { cardLabel, cardsLabel } from '../game/cards';

export type LlmHandOutcome = 'win' | 'lose' | 'split';

export interface LlmHandMemory {
  slot: 1 | 2;
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
const MAX_TOTAL = 240;
const MAX_PER_SLOT = 120;

let fallbackMemories: LlmHandMemory[] = [];

function localStorageAvailable(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
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
        !!item &&
        typeof item === 'object' &&
        ((item as LlmHandMemory).slot === 1 || (item as LlmHandMemory).slot === 2),
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

/** 读取某个大模型机器人的历史对局记忆（旧 → 新）。 */
export function loadHandMemories(slot: 1 | 2): LlmHandMemory[] {
  return readAll()
    .filter((memory) => memory.slot === slot)
    .slice(-MAX_PER_SLOT);
}

export function appendHandMemory(memory: LlmHandMemory): void {
  const all = readAll();
  all.push(memory);
  // 每个槽位只保留最近 120 条
  const bySlot = (slot: 1 | 2): LlmHandMemory[] =>
    all.filter((item) => item.slot === slot).slice(-MAX_PER_SLOT);
  writeAll([...bySlot(1), ...bySlot(2)]);
}

export function clearHandMemories(slot?: 1 | 2): void {
  if (slot === undefined) {
    writeAll([]);
    return;
  }
  writeAll(readAll().filter((memory) => memory.slot !== slot));
}

export function memoryCount(slot: 1 | 2): number {
  return loadHandMemories(slot).length;
}

/** 供 LLM 提示词使用的经验行（最近的复盘）。 */
export function memoryPromptLines(slot: 1 | 2, limit = 3): string[] {
  return loadHandMemories(slot)
    .slice(-limit)
    .map((memory) => {
      const resultText =
        memory.result === 'win' ? '赢' : memory.result === 'lose' ? '输' : '平分';
      const netText = `${memory.net >= 0 ? '+' : ''}${memory.net}`;
      return `- 底牌 ${memory.hole}，公共牌 ${memory.board || '翻牌前'}，行动：${
        memory.actions.join(' → ') || '无'
      }；结果${resultText} ${netText}；复盘：${memory.note}`;
    });
}

export interface BuildHandMemoryParams {
  slot: 1 | 2;
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
