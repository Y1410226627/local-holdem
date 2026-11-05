/**
 * 大模型玩家：把限定视图压缩成「极简英文提示词」，让模型输出一行紧凑 JSON 动作。
 *
 * 设计目标（按优先级）：
 * - 正确：只把公开信息 + 自己的底牌写进提示词；输出动作再用引擎规则校验；
 * - 省 token：英文短提示词、短键名 JSON、不给无关寒暄；人物设定 / 经验提示都做了长度上限；
 * - 稳定：兼容思考型模型（content 为空时自动重试并放宽 token 上限，也支持 reasoning_content）；
 * - 可解释：返回结构化调试信息；失败抛 LlmError，由 UI 回退本地算法。
 */
import type { Difficulty, LegalActions, LlmSeatConfig, PlayerAction } from '../game/types';
import { DIFFICULTY_LABELS } from '../game/types';
import type { PlayerView } from '../game/playerView';
import { cardsLabel } from '../game/cards';import { fallbackAction, isActionLegal, type AIDecision, type AIDebugInfo } from './aiPlayer';
import { analyzePostflop, handKey, positionOf } from './rangeModel';
import { stylePromptHint } from './style';
import { memoryPromptLines } from './llmMemory';
import {
  DEFAULT_MAX_TOKENS,
  LlmError,
  callChatCompletion,
  resolveChatCompletionsUrl,
  type ChatCallResult,
  type ChatMessage,
  type LlmEndpointConfig,
} from './llmClient';
import llmExperienceData from './data/llm-experience.json';

export { LlmError, resolveChatCompletionsUrl };
export type { LlmEndpointConfig };

export interface LlmExample {
  street: string;
  position?: string;
  hole: string;
  board?: string;
  pot: number;
  currentBet: number;
  callAmount: number;
  facingBet?: boolean;
  action: string;
  amount?: number;
  equity?: number;
  note?: string;
}

export interface LlmExperienceFile {
  generatedAt?: string | null;
  hands?: number;
  examples?: LlmExample[];
}

export const llmExperience = llmExperienceData as LlmExperienceFile;

export interface LlmConnectionResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  sample?: string;
}

export interface LlmDecisionDebug extends AIDebugInfo {
  source: 'llm';
  model: string;
  latencyMs: number;
  rawResponse?: string;
}

export interface LlmDecision extends AIDecision {
  /** 开启「神态/语句」时，模型可选的短发言（已截断，适合显示在座位气泡）。 */
  talk?: string;
  debug: LlmDecisionDebug;
}

export interface LlmPromptOptions {
  /** 是否允许模型输出神态/语句（默认 false，省 token）。 */
  talk?: boolean;
  /** 是否附带训练经验提示（默认 true；重试时关闭以进一步缩短提示词）。 */
  includeHints?: boolean;
}

export interface LlmDecisionOptions {
  /** UI 在换局 / 人类操作时可传入以取消在途请求。 */
  signal?: AbortSignal;
  /** 是否允许模型输出神态/语句。 */
  talk?: boolean;
}

type Position = ReturnType<typeof positionOf>;
const POSITION_CODES: Record<Position, string> = {
  early: 'EP',
  middle: 'MP',
  late: 'LP',
  blinds: 'BLIND',
};

const STREET_CODES: Record<string, string> = {
  preflop: 'PRE',
  flop: 'FLOP',
  turn: 'TURN',
  river: 'RIVER',
};

const DIFFICULTY_STYLES: Record<Difficulty, string> = {
  beginner: 'loose-passive',
  normal: 'balanced',
  hard: 'tricky-aggressive',
  expert: 'exploitative',
};

const MAX_TOKENS_RETRY = 2400;
const MAX_TALK_CHARS = 40;
const MAX_REASON_CHARS = 160;
const MAX_EXPERIENCE_EXAMPLES = 2;
const MAX_MEMORY_LINES = 2;

/* ------------------------------------------------------------------ */
/* 紧凑格式化                                                          */
/* ------------------------------------------------------------------ */

function streetCode(street: string): string {
  return STREET_CODES[street] ?? street.toUpperCase();
}

function actionCode(action: string, amount?: number): string {
  const normalized = action.trim().toLowerCase();
  const alias: Record<string, string> = {
    fold: 'fold',
    弃牌: 'fold',
    check: 'check',
    过牌: 'check',
    call: 'call',
    跟注: 'call',
    bet: 'bet',
    下注: 'bet',
    raise: 'raise',
    加注: 'raise',
    allin: 'allin',
    'all-in': 'allin',
    全下: 'allin',
  };
  const type = alias[normalized] ?? normalized;
  return amount !== undefined ? `${type} ${amount}` : type;
}

function positionCode(position: string): string {
  const map: Record<string, Position> = {
    早位: 'early',
    中位: 'middle',
    晚位: 'late',
    盲注位: 'blinds',
  };
  const resolved = (map[position] ?? position) as Position;
  return POSITION_CODES[resolved] ?? 'MP';
}

/** 极简合法动作描述（英文短键，只有 1 行）。 */
export function formatLegalActions(legal: LegalActions): string {
  return JSON.stringify({
    f: legal.canFold ? 1 : 0,
    ck: legal.canCheck ? 1 : 0,
    ca: legal.canCall ? 1 : 0,
    caAmt: legal.callAmount,
    b: legal.canBet ? 1 : 0,
    r: legal.canRaise ? 1 : 0,
    min: legal.minRaiseTo,
    max: legal.maxRaiseTo,
    ai: legal.canAllIn ? 1 : 0,
    cur: legal.currentBet,
  });
}

function formatExamples(view: PlayerView): string[] {
  const examples = llmExperience.examples ?? [];
  const facingBet = view.currentBet > view.self.committedThisStreet;
  return examples
    .filter(
      (example) =>
        example.street === view.street &&
        Boolean(example.facingBet ?? example.callAmount > 0) === facingBet,
    )
    .slice(0, MAX_EXPERIENCE_EXAMPLES)
    .map((example) => {
      const board = example.board ? example.board.replace(/\s+/g, '') : '-';
      return `HINT ${streetCode(example.street)} ${positionCode(example.position ?? '')} ${
        example.hole
      } ${board} pot${example.pot} call${example.callAmount} -> ${actionCode(
        example.action,
        example.amount,
      )}`;
    });
}

function formatActionRecord(view: PlayerView): string {
  const recent = view.actions.slice(-10);
  if (recent.length === 0) return 'ACTIONS -';
  const byStreet = new Map<string, string[]>();
  for (const record of recent) {
    const key = streetCode(record.street);
    const list = byStreet.get(key) ?? [];
    const amount =
      record.action.type === 'bet' || record.action.type === 'raise'
        ? record.action.amount
        : record.toAmount > 0
          ? record.toAmount
          : undefined;
    list.push(`${record.actorName} ${actionCode(record.action.type, amount)}`);
    byStreet.set(key, list);
  }
  return `ACTIONS ${[...byStreet.entries()].map(([key, list]) => `${key}: ${list.join(', ')}`).join(' | ')}`;
}

function formatSeats(view: PlayerView): string {
  return view.players
    .map((player) => {
      const mark = player.id === view.viewerId ? 'YOU' : player.isHuman ? 'H' : player.kind === 'llm' ? 'AI' : 'B';
      return `${mark}:${player.name}(${player.stack}/${player.committedThisStreet}/${player.status})`;
    })
    .join('; ');
}

/** 公开跨手统计数据（足够样本时）→ 一行紧凑英文画像，供大模型参考。 */
function formatOpponentStats(view: PlayerView): string | null {
  const rows = view.players
    .filter((player) => player.id !== view.viewerId && player.stats && player.stats.hands >= 2)
    .slice(0, 6)
    .map((player) => {
      const stats = player.stats;
      if (!stats) return '';
      const fold =
        stats.foldToBetRate === null ? '-' : Math.round(stats.foldToBetRate * 100) + '%';
      return (
        player.name +
        ' VPIP' +
        Math.round(stats.vpipRate * 100) +
        ' PFR' +
        Math.round(stats.pfrRate * 100) +
        ' AF' +
        stats.aggression.toFixed(1) +
        ' F2B' +
        fold
      );
    })
    .filter((row) => row.length > 0);
  if (rows.length === 0) return null;
  return 'READS ' + rows.join('; ');
}

/* ------------------------------------------------------------------ */
/* 提示词                                                              */
/* ------------------------------------------------------------------ */

export function buildLlmPrompt(
  view: PlayerView,
  difficulty: Difficulty,
  config: LlmSeatConfig,
  options: LlmPromptOptions = {},
): { system: string; user: string } {
  const legal = view.legal;
  if (!legal) throw new LlmError('format', '当前不是该大模型玩家的行动回合');
  const talk = options.talk === true;
  const includeHints = options.includeHints !== false;
  const name = config.name?.trim() || `LLM#${config.slot}`;
  const persona = config.persona?.trim().slice(0, 300) ?? '';

  const actionSpec =
    '{"a":"fold|check|call|bet|raise|allin","x":<int, only bet/raise>,"w":"<short English reason>"}';
  const talkSpec = talk
    ? '{"a":"fold|check|call|bet|raise|allin","x":<int, only bet/raise>,"w":"<short English reason>","say":"<short table talk, <=20 chars, Chinese ok>"}'
    : actionSpec;

  const systemLines = [
    `You are ${name}, a No-Limit Hold'em player at a local table. Play to win; use pot odds, position, bet sizes and opponent actions.`,
  ];
  if (persona) systemLines.push(`Persona: ${persona}`);
  const archetype = stylePromptHint(view.self.styleId);
  if (archetype) systemLines.push(`Table archetype: ${archetype}.`);
  systemLines.push(
    `Style: ${DIFFICULTY_STYLES[difficulty]} (${DIFFICULTY_LABELS[difficulty]}).`,
    `You see only public info and your own hole cards; never guess opponents' hole cards.`,
    `Amount x for bet/raise is the TOTAL chips you put in this street (raise-to). Follow LEGAL exactly; allin = shove.`,
    `Reply with EXACTLY ONE compact JSON line, no markdown, no thinking: ${talkSpec}`,
  );

  const callAmount = legal.callAmount;
  const potOdds = callAmount > 0 ? callAmount / (view.pot + callAmount) : 0;
  const userLines = [
    `HAND ${view.handNo} ${streetCode(view.street)} | POS ${POSITION_CODES[positionOf(view)]} | STACK ${
      view.self.stack
    } | POT ${view.pot} | CURBET ${view.currentBet} | TO-CALL ${callAmount} | ODDS ${(
      potOdds * 100
    ).toFixed(0)}%`,
    `HOLE ${cardsLabel(view.self.holeCards)} | BOARD ${view.board.length > 0 ? cardsLabel(view.board) : '-'}`,
    `SEATS ${formatSeats(view)}`,
    formatActionRecord(view),
    `LEGAL ${formatLegalActions(legal)}`,
  ];

  if (includeHints) {
    const hints = [...formatExamples(view), ...memoryPromptLines(config.slot, MAX_MEMORY_LINES)];
    if (hints.length > 0) userLines.push(`HINTS\n${hints.join('\n')}`);
  }

  const reads = formatOpponentStats(view);
  if (reads) userLines.push(reads);

  return { system: systemLines.join('\n'), user: userLines.join('\n') };
}

/* ------------------------------------------------------------------ */
/* 输出解析                                                            */
/* ------------------------------------------------------------------ */

const ACTION_ALIASES: Record<string, PlayerAction['type']> = {
  fold: 'fold',
  f: 'fold',
  弃牌: 'fold',
  check: 'check',
  ck: 'check',
  k: 'check',
  过牌: 'check',
  call: 'call',
  c: 'call',
  ca: 'call',
  跟注: 'call',
  bet: 'bet',
  b: 'bet',
  下注: 'bet',
  raise: 'raise',
  r: 'raise',
  rr: 'raise',
  加注: 'raise',
  allin: 'allin',
  ai: 'allin',
  'all-in': 'allin',
  all_in: 'allin',
  shove: 'allin',
  jam: 'allin',
  全下: 'allin',
};

export interface ParsedLlmAction {
  action: PlayerAction;
  reason: string;
  /** 开启神态/语句时模型给出的短发言（已清洗、截断）。 */
  talk?: string;
  /** 模型输出被修正（金额夹取 / 动作回退）时标记。 */
  repaired: boolean;
  /** 是否成功识别出动作（false 时 action 是安全兜底动作）。 */
  matched: boolean;
}

function simpleAction(type: 'fold' | 'check' | 'call' | 'allin'): PlayerAction {
  switch (type) {
    case 'fold':
      return { type: 'fold' };
    case 'check':
      return { type: 'check' };
    case 'call':
      return { type: 'call' };
    default:
      return { type: 'allin' };
  }
}

function pickFallback(legal: LegalActions): PlayerAction {
  if (legal.canCheck) return { type: 'check' };
  if (legal.canCall) return { type: 'call' };
  return fallbackAction(legal);
}

function sanitizeTalk(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > MAX_TALK_CHARS ? `${text.slice(0, MAX_TALK_CHARS)}…` : text;
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const withoutFence = raw.trim().replace(/```(?:json)?/gi, '').trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(withoutFence.slice(start, end + 1));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 解析大模型输出并发合法动作（无法识别时 matched=false，动作为安全兜底）。 */
export function parseLlmAction(
  raw: string,
  legal: LegalActions,
  fallbackReason = '模型输出无法解析，已使用安全动作',
): ParsedLlmAction {
  if (!raw || typeof raw !== 'string') {
    return { action: pickFallback(legal), reason: fallbackReason, repaired: true, matched: false };
  }
  const parsed = extractJsonObject(raw);
  if (!parsed) {
    return { action: pickFallback(legal), reason: fallbackReason, repaired: true, matched: false };
  }

  const rawAction = String(
    parsed.a ?? parsed.action ?? parsed.type ?? parsed.decision ?? parsed.act ?? '',
  ).trim();
  const mapped = ACTION_ALIASES[rawAction.toLowerCase()] ?? ACTION_ALIASES[rawAction];
  const reasonRaw = parsed.w ?? parsed.why ?? parsed.reason ?? parsed.reasoning ?? parsed.note;
  const reason =
    typeof reasonRaw === 'string' && reasonRaw.trim().length > 0
      ? reasonRaw.trim().slice(0, MAX_REASON_CHARS)
      : '模型未提供理由';
  const talk = sanitizeTalk(parsed.say ?? parsed.talk ?? parsed.trash ?? parsed.line);
  if (!mapped) {
    return {
      action: pickFallback(legal),
      reason: `${reason}（动作无法识别，已回退）`,
      talk,
      repaired: true,
      matched: false,
    };
  }

  if (mapped === 'bet' || mapped === 'raise') {
    let repaired = false;
    const amountRaw =
      parsed.x ?? parsed.amount ?? parsed.to ?? parsed.raiseTo ?? parsed.raise_to ?? parsed.bet;
    let amount = Number(amountRaw);
    if (!Number.isFinite(amount)) {
      amount = legal.minRaiseTo;
      repaired = true;
    }
    amount = Math.round(amount);
    if (amount > legal.maxRaiseTo) {
      amount = legal.maxRaiseTo;
      repaired = true;
    }
    if (amount < legal.minRaiseTo) {
      amount = legal.maxRaiseTo < legal.minRaiseTo ? legal.maxRaiseTo : legal.minRaiseTo;
      repaired = true;
    }
    const candidate: PlayerAction =
      amount === legal.maxRaiseTo && legal.canAllIn
        ? { type: 'allin' }
        : { type: mapped, amount };
    if (isActionLegal(candidate, legal)) {
      return { action: candidate, reason, talk, repaired, matched: true };
    }
    return {
      action: pickFallback(legal),
      reason: `${reason}（加注不合法，已回退为安全动作）`,
      talk,
      repaired: true,
      matched: false,
    };
  }

  const candidate = simpleAction(mapped as 'fold' | 'check' | 'call' | 'allin');
  if (isActionLegal(candidate, legal)) {
    return { action: candidate, reason, talk, repaired: false, matched: true };
  }
  return {
    action: pickFallback(legal),
    reason: `${reason}（动作不合法，已回退为安全动作）`,
    talk,
    repaired: true,
    matched: false,
  };
}

/* ------------------------------------------------------------------ */
/* 请求与决策                                                          */
/* ------------------------------------------------------------------ */

function potOddsOf(view: PlayerView, legal: LegalActions): number {
  const cost = Math.max(0, legal.callAmount);
  return cost === 0 ? 0 : cost / (view.pot + cost);
}

/** 重试用的极短提示：去掉人物设定 / 经验 / 复杂说明，并加大输出预算。 */
function buildRetryMessages(
  view: PlayerView,
  config: LlmSeatConfig,
  legal: LegalActions,
  talk: boolean,
): ChatMessage[] {
  const actionSpec = talk
    ? '{"a":"fold|check|call|bet|raise|allin","x":int-only-bet-raise,"w":"short reason","say":"short table talk"}'
    : '{"a":"fold|check|call|bet|raise|allin","x":int-only-bet-raise,"w":"short reason"}';
  const system = [
    `You are ${config.name?.trim() || 'a poker bot'}. Decide one legal action now.`,
    `Reply with EXACTLY ONE JSON line, no thinking, no markdown: ${actionSpec}`,
  ].join(' ');
  const user = [
    `HAND ${streetCode(view.street)} HOLE ${cardsLabel(view.self.holeCards)} BOARD ${
      view.board.length > 0 ? cardsLabel(view.board) : '-'
    } POT ${view.pot} CURBET ${view.currentBet} TO-CALL ${legal.callAmount} STACK ${view.self.stack}`,
    `LEGAL ${formatLegalActions(legal)}`,
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function failureMessage(result: ChatCallResult | null): string {
  const finish = result?.finishReason ? `（finish_reason=${result.finishReason}）` : '';
  if (!result) return '大模型没有返回内容。';
  if (!result.content.trim() && !result.reasoning.trim()) {
    return `大模型返回了空内容${finish}。常见原因：模型把 token 花在“思考”上导致输出被截断，或模型名/接口不匹配；已自动重试并放宽 token 上限，仍失败时可换用非思考模型、或调大该模型的 maxTokens/超时。`;
  }
  const snippet = (result.content || result.reasoning).replace(/\s+/g, ' ').trim().slice(0, 120);
  return `大模型输出不是可解析的动作 JSON${finish}。模型原文：${snippet}`;
}

function decisionFrom(
  parsed: ParsedLlmAction,
  result: ChatCallResult,
  view: PlayerView,
  difficulty: Difficulty,
  config: LlmSeatConfig,
  legal: LegalActions,
  attempts: number,
): LlmDecision {
  const handCategory =
    view.board.length >= 3
      ? analyzePostflop(view.self.holeCards, view.board).categoryName
      : `起手牌 ${handKey(view.self.holeCards)}`;
  const debug: LlmDecisionDebug = {
    difficulty,
    profile: `大模型：${config.name || '模型'}（${config.model}）`,
    potOdds: potOddsOf(view, legal),
    handCategory,
    reasoning:
      (parsed.repaired ? `${parsed.reason}（输出已被规则修正）` : parsed.reason) +
      (attempts > 1 ? '（已在重试后成功）' : ''),
    source: 'llm',
    model: config.model,
    latencyMs: result.latencyMs,
    rawResponse: (result.content || result.reasoning).slice(0, 400),
  };
  return { action: parsed.action, talk: parsed.talk, debug };
}

/** 调用大模型做出一次合法决策；失败抛 LlmError（UI 回退本地算法）。 */
export async function decideWithLlm(
  view: PlayerView,
  difficulty: Difficulty,
  config: LlmSeatConfig,
  options: LlmDecisionOptions = {},
): Promise<LlmDecision> {
  const legal = view.legal;
  if (!legal) throw new LlmError('format', '当前不是该玩家的行动回合');
  const talk = options.talk === true;
  const prompt = buildLlmPrompt(view, difficulty, config, { talk });
  const firstMaxTokens =
    typeof config.maxTokens === 'number' && config.maxTokens > 0
      ? Math.max(200, config.maxTokens)
      : DEFAULT_MAX_TOKENS;

  let last: ChatCallResult | null = null;
  let attempts = 0;

  const tryOnce = async (messages: ChatMessage[], maxTokens: number): Promise<ParsedLlmAction | null> => {
    attempts += 1;
    const result = await callChatCompletion(config, messages, {
      signal: options.signal,
      maxTokens: maxTokens,
    });
    last = result;
    // 思考型模型有时把内容写进 reasoning_content，正文为空；这里也尝试解析思考内容。
    const candidateText = result.content.trim()
      ? result.content
      : result.reasoning.trim()
        ? result.reasoning
        : '';
    const parsed = parseLlmAction(candidateText, legal);
    return parsed.matched ? parsed : null;
  };

  let parsed = await tryOnce(
    [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    firstMaxTokens,
  );

  if (!parsed) {
    // 第一次失败（空内容 / 被截断 / 不是 JSON）→ 用更短提示 + 更大输出预算重试一次。
    parsed = await tryOnce(
      buildRetryMessages(view, config, legal, talk),
      Math.max(MAX_TOKENS_RETRY, firstMaxTokens * 2),
    );
  }

  if (!parsed || !last) {
    throw new LlmError('format', failureMessage(last));
  }
  return decisionFrom(parsed, last, view, difficulty, config, legal, attempts);
}

/** 测试大模型连接（设置面板「测试连接」按钮）。不会抛异常。 */
export async function testLlmConnection(config: LlmEndpointConfig): Promise<LlmConnectionResult> {
  const timeoutMs = Math.min(
    typeof config.timeoutMs === 'number' && config.timeoutMs > 0 ? config.timeoutMs : 20000,
    20000,
  );
  try {
    const result = await callChatCompletion(
      { ...config, timeoutMs },
      [
        { role: 'system', content: 'You are a connectivity probe. Reply with exactly: OK' },
        { role: 'user', content: 'Reply OK' },
      ],
      { maxTokens: 32, temperature: 0 },
    );
    if (!result.content.trim() && !result.reasoning.trim()) {
      const finish = result.finishReason ? `（finish_reason=${result.finishReason}）` : '';
      return {
        ok: false,
        message: `服务已连通，但模型返回空内容${finish}。多为思考型模型把 token 用尽，请调大 maxTokens 或换非思考模型。`,
        latencyMs: result.latencyMs,
      };
    }
    return {
      ok: true,
      message: `连接成功（${result.latencyMs}ms）`,
      latencyMs: result.latencyMs,
      sample: (result.content || result.reasoning).trim().slice(0, 80),
    };
  } catch (error) {
    const message = error instanceof LlmError ? error.message : '连接失败，请检查配置。';
    return { ok: false, message };
  }
}

export { potOddsOf as llmPotOdds };
