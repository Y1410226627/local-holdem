/** 中文文案与数值格式化工具。 */
import type {
  Difficulty,
  HandResult,
  LegalActions,
  LogKind,
  PlayerAction,
  PlayerStatus,
  Street,
} from '../game/types';
import { DIFFICULTY_LABELS } from '../game/types';

export const STREET_LABELS: Record<Street, string> = {
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
};

export const LOG_KIND_LABELS: Record<LogKind, string> = {
  system: '系统',
  deal: '发牌',
  blind: '盲注',
  action: '动作',
  street: '轮次',
  board: '公共牌',
  showdown: '摊牌',
  pot: '底池',
  refund: '退回',
};

export const STATUS_LABELS: Record<PlayerStatus, string> = {
  active: '参与中',
  folded: '已弃牌',
  allin: '全下',
  out: '已淘汰',
};

export function formatChips(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  return Math.round(amount).toLocaleString('zh-CN');
}

/**
 * AI 返回的 equity / potOdds 可能是 0-1 比率，也可能是 0-100 百分数。
 * 小于等于 1 的值按比率处理，其余按百分数处理。
 */
export function formatPercent(value: number | undefined, digits = 1): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  const percent = Math.abs(value) <= 1 ? value * 100 : value;
  return `${percent.toFixed(digits)}%`;
}

export function difficultyLabel(difficulty: Difficulty): string {
  return DIFFICULTY_LABELS[difficulty];
}

/** 动作的中文描述；传入 legal 可补上跟注金额。 */
export function formatAction(action: PlayerAction, legal?: LegalActions | null): string {
  switch (action.type) {
    case 'fold':
      return '弃牌';
    case 'check':
      return '过牌';
    case 'call':
      return legal && legal.callAmount > 0 ? `跟注 ${formatChips(legal.callAmount)}` : '跟注';
    case 'bet':
      return `下注 ${formatChips(action.amount)}`;
    case 'raise':
      return `加注到 ${formatChips(action.amount)}`;
    case 'allin':
      return '全下';
  }
}

/** 本手赢家摘要，如「你 +420、小雅 +180」。 */
export function resultSummary(result: HandResult | null): string {
  if (!result) return '';
  if (result.winners.length === 0) return '本手结束';
  return result.winners.map((winner) => `${winner.name} +${formatChips(winner.amount)}`).join('、');
}

const SEAT_EMOJIS = ['🤖', '🦊', '🐼', '🐯', '🐸', '🦉'];

export function seatEmoji(playerId: number, isHuman: boolean): string {
  if (isHuman) return '🧑';
  return SEAT_EMOJIS[Math.abs(playerId) % SEAT_EMOJIS.length];
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return '未知错误';
}
