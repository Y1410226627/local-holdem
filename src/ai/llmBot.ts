/**
 * 本地大模型机器人（纯本地调用，OpenAI 兼容接口）。
 *
 * 支持：Ollama（/v1）、LM Studio、vLLM、llama.cpp server 等 OpenAI 兼容服务。
 * - 只把 PlayerView 的公开信息 + 自己的底牌写进提示词（不会泄露对手底牌）；
 * - 强制模型输出 JSON 动作，解析后再次用引擎规则校验合法性；
 * - 解析失败 / 网络失败时抛出 LlmError，由 UI 自动回退到本地算法决策；
 * - 训练脚本生成的 `llm-experience.json` + 浏览器本地对局记忆会作为 few-shot 经验。
 */
import type { Difficulty, LegalActions, LlmSeatConfig, PlayerAction } from '../game/types';
import { DIFFICULTY_LABELS } from '../game/types';
import type { PlayerView } from '../game/playerView';
import { cardLabel } from '../game/cards';
import { fallbackAction, isActionLegal, type AIDecision, type AIDebugInfo } from './aiPlayer';
import { DIFFICULTY_PROFILES } from './difficulty';
import { analyzePostflop, handKey, positionOf, POSITION_LABELS } from './rangeModel';
import { memoryPromptLines } from './llmMemory';
import llmExperienceData from './data/llm-experience.json';

export type LlmErrorKind = 'network' | 'http' | 'timeout' | 'format';

export class LlmError extends Error {
  readonly kind: LlmErrorKind;

  constructor(kind: LlmErrorKind, message: string) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
  }
}

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
  debug: LlmDecisionDebug;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TOKENS = 400;

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

/** 把用户填写的 Base URL 规范化为 chat/completions 端点。 */
export function resolveChatCompletionsUrl(baseUrl: string): string {
  let base = (baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/\/chat\/completions$/i.test(base)) return base;
  // Ollama 本地地址常省略 /v1，自动补齐。
  if (!/\/v\d+(?:beta)?$/i.test(base)) base += '/v1';
  return `${base}/chat/completions`;
}

function actionText(action: PlayerAction): string {
  switch (action.type) {
    case 'fold':
      return '弃牌';
    case 'check':
      return '过牌';
    case 'call':
      return '跟注';
    case 'bet':
      return `下注到 ${action.amount}`;
    case 'raise':
      return `加注到 ${action.amount}`;
    case 'allin':
      return '全下';
    default:
      return '未知动作';
  }
}

function formatLegalActions(legal: LegalActions): string {
  return JSON.stringify({
    canCheck: legal.canCheck,
    canCall: legal.canCall,
    callAmount: legal.callAmount,
    canBet: legal.canBet,
    canRaise: legal.canRaise,
    minRaiseTo: legal.minRaiseTo,
    maxRaiseTo: legal.maxRaiseTo,
    canAllIn: legal.canAllIn,
    currentBet: legal.currentBet,
  });
}

function difficultyHint(difficulty: Difficulty): string {
  const profile = DIFFICULTY_PROFILES[difficulty];
  return `${DIFFICULTY_LABELS[difficulty]}（风格参考：${profile.style}）`;
}

function formatExamples(view: PlayerView): string[] {
  const examples = llmExperience.examples ?? [];
  const facingBet = view.currentBet > view.self.committedThisStreet;
  const matched = examples
    .filter(
      (example) =>
        example.street === view.street &&
        Boolean(example.facingBet ?? example.callAmount > 0) === facingBet,
    )
    .slice(0, 2)
    .map((example) => {
      const equityText =
        example.equity !== undefined ? `，胜率约 ${Math.round(example.equity * 100)}%` : '';
      const amountText = example.amount !== undefined ? ` ${example.amount}` : '';
      return `- [${example.street}] 位置 ${example.position ?? '未知'}，底牌 ${example.hole}，公共牌 ${
        example.board || '无'
      }，底池 ${example.pot}，需跟注 ${example.callAmount}；参考行动：${example.action}${amountText}${equityText}${
        example.note ? `（${example.note}）` : ''
      }`;
    });
  return matched;
}

/* ------------------------------------------------------------------ */
/* 提示词                                                              */
/* ------------------------------------------------------------------ */

export function buildLlmPrompt(
  view: PlayerView,
  difficulty: Difficulty,
  config: LlmSeatConfig,
): { system: string; user: string } {
  const legal = view.legal;
  if (!legal) throw new LlmError('format', '当前不是该大模型机器人的行动回合');
  const position = POSITION_LABELS[positionOf(view)];
  const opponents = view.players
    .filter((player) => player.id !== view.viewerId)
    .map((player) => {
      const kindText =
        player.kind === 'llm' ? '大模型机器人' : player.isHuman ? '人类玩家' : '本地机器人';
      return `${player.name}（${kindText}，筹码 ${player.stack}，本轮已下注 ${player.committedThisStreet}，状态 ${player.status}）`;
    })
    .join('；');
  const recentActions = view.actions
    .slice(-12)
    .map(
      (record) =>
        `${record.street === 'preflop' ? '翻牌前' : record.street === 'flop' ? '翻牌' : record.street === 'turn' ? '转牌' : '河牌'} ${record.actorName} ${actionText(record.action)}`,
    )
    .join('\n');
  const potOdds = legal.callAmount > 0 ? legal.callAmount / (view.pot + legal.callAmount) : 0;
  const callTo = view.players.find((player) => player.id === view.viewerId)?.committedThisStreet ?? 0;
  const streetLabel =
    view.street === 'preflop' ? '翻牌前' : view.street === 'flop' ? '翻牌' : view.street === 'turn' ? '转牌' : '河牌';

  const trainedExamples = formatExamples(view);
  const memories = memoryPromptLines(config.slot, 2);
  const experienceLines = [...trainedExamples, ...memories];
  const experienceText =
    experienceLines.length > 0
      ? experienceLines.join('\n')
      : '（暂无历史经验；可运行 npm run train 生成经验库，之后每手牌结束都会积累你的复盘记忆。）';

  const system = [
    `你是「${config.name || '本地大模型机器人'}」，一位参与本地无限注德州扑克的职业牌手机器人。`,
    `你的难度定位：${difficultyHint(difficulty)}。`,
    '规则速记：无限注德州扑克；加注金额 amount 表示本轮“加到”的总投入（含你本轮已下注部分）；',
    '合法动作严格以【合法动作 JSON】为准；全下使用 allin；不要臆测或询问对手底牌。',
    '你只能看到自己的底牌与所有公开信息。',
    '请像职业牌手一样结合底池赔率、位置、下注尺度与对手行动做决策，并在 reason 中给出简短中文理由。',
    '只输出一行 JSON，不要输出其它任何文字。',
  ].join('\n');

  const user = [
    `【当前牌局】${streetLabel}；玩家人数 ${view.players.length}；你的座位 ${view.viewerId}；按钮位 ${view.buttonIndex}；你的位置：${position}。`,
    `底池 ${view.pot}；当前下注 ${view.currentBet}；你本轮已投入 ${callTo}；需跟注 ${legal.callAmount}；底池赔率 ${(potOdds * 100).toFixed(1)}%；你的筹码 ${view.self.stack}。`,
    `你的底牌：${view.self.holeCards.map((card) => cardLabel(card)).join(' ')}`,
    `公共牌：${view.board.length > 0 ? view.board.map((card) => cardLabel(card)).join(' ') : '无（翻牌前）'}`,
    `其他玩家：${opponents}`,
    `最近行动：\n${recentActions || '（本手尚无行动）'}`,
    `合法动作 JSON：${formatLegalActions(legal)}`,
    `经验参考（来自自博弈训练库与你的往局复盘，仅供参考，不必盲从）：\n${experienceText}`,
    `【输出格式】只输出一行 JSON：{"action":"fold|check|call|bet|raise|allin","amount":整数或省略,"reason":"中文不超过80字"}`,
  ].join('\n');

  return { system, user };
}

/* ------------------------------------------------------------------ */
/* 响应解析                                                            */
/* ------------------------------------------------------------------ */

const ACTION_ALIASES: Record<string, PlayerAction['type']> = {
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
  all_in: 'allin',
  shove: 'allin',
  全下: 'allin',
};

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

export interface ParsedLlmAction {
  action: PlayerAction;
  reason: string;
  /** 模型输出被修正（金额夹取 / 动作回退）时标记。 */
  repaired: boolean;
}

/** 解析大模型输出并发合法动作（解析失败时回退到 check/call/fold）。 */
export function parseLlmAction(
  raw: string,
  legal: LegalActions,
  fallbackReason = '模型输出无法解析，已使用安全动作',
): ParsedLlmAction {
  if (!raw || typeof raw !== 'string') {
    return { action: pickFallback(legal), reason: fallbackReason, repaired: true };
  }
  let jsonText = raw.trim().replace(/```(?:json)?/gi, '').trim();
  const start = jsonText.indexOf('{');
  const end = jsonText.lastIndexOf('}');
  let parsed: Record<string, unknown> | null = null;
  if (start >= 0 && end > start) {
    jsonText = jsonText.slice(start, end + 1);
    try {
      const value: unknown = JSON.parse(jsonText);
      if (value && typeof value === 'object') parsed = value as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  if (!parsed) {
    return { action: pickFallback(legal), reason: fallbackReason, repaired: true };
  }

  const rawAction = String(parsed.action ?? parsed.type ?? parsed.decision ?? '').trim();
  const mapped = ACTION_ALIASES[rawAction.toLowerCase()] ?? ACTION_ALIASES[rawAction];
  const reasonRaw = parsed.reason ?? parsed.reasoning ?? parsed.note ?? parsed.explanation;
  const reason =
    typeof reasonRaw === 'string' && reasonRaw.trim().length > 0
      ? reasonRaw.trim().slice(0, 200)
      : '模型未提供理由';
  if (!mapped) {
    return { action: pickFallback(legal), reason: `${reason}（动作无法识别，已回退）`, repaired: true };
  }

  if (mapped === 'bet' || mapped === 'raise') {
    let repaired = false;
    const amountRaw = parsed.amount ?? parsed.to ?? parsed.raiseTo ?? parsed.bet;
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
      if (legal.maxRaiseTo < legal.minRaiseTo) {
        amount = legal.maxRaiseTo;
      } else {
        amount = legal.minRaiseTo;
      }
      repaired = true;
    }
    const candidate: PlayerAction =
      amount === legal.maxRaiseTo && legal.canAllIn
        ? { type: 'allin' }
        : { type: mapped, amount };
    if (isActionLegal(candidate, legal)) {
      return {
        action: candidate,
        reason,
        repaired,
      };
    }
    return {
      action: pickFallback(legal),
      reason: `${reason}（加注不合法，已回退为安全动作）`,
      repaired: true,
    };
  }

  const candidate = simpleAction(mapped as 'fold' | 'check' | 'call' | 'allin');
  if (isActionLegal(candidate, legal)) {
    return { action: candidate, reason, repaired: false };
  }
  return {
    action: pickFallback(legal),
    reason: `${reason}（动作不合法，已回退为安全动作）`,
    repaired: true,
  };
}

function potOddsOf(view: PlayerView, legal: LegalActions): number {
  const cost = Math.max(0, legal.callAmount);
  return cost === 0 ? 0 : cost / (view.pot + cost);
}

/* ------------------------------------------------------------------ */
/* 网络请求                                                            */
/* ------------------------------------------------------------------ */

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCallResult {
  content: string;
  latencyMs: number;
  raw: unknown;
}

function isAbortError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    ((error as { name?: string }).name === 'AbortError' ||
      (error as { code?: string }).code === 'ABORT_ERR')
  );
}

function networkErrorMessage(): string {
  return [
    '无法连接本地大模型服务。请检查：',
    '1) 本地模型服务已启动；',
    '2) Base URL 正确（Ollama 默认 http://127.0.0.1:11434/v1，LM Studio 默认 http://127.0.0.1:1234/v1）；',
    '3) 允许浏览器跨域（Ollama 需设置环境变量 OLLAMA_ORIGINS=*；LM Studio 需在服务器设置里开启 CORS）。',
  ].join('');
}

function httpErrorMessage(status: number, body: string): string {
  const trimmed = body.trim().slice(0, 200);
  if (status === 401 || status === 403) {
    return `本地模型服务鉴权失败（HTTP ${status}），请检查 API Key 配置。${trimmed ? ` 服务返回：${trimmed}` : ''}`;
  }
  if (status === 404) {
    return `接口路径不存在（HTTP 404）。Base URL 应为 OpenAI 兼容地址，例如 http://127.0.0.1:11434/v1。${trimmed ? ` 服务返回：${trimmed}` : ''}`;
  }
  return `本地模型服务返回错误（HTTP ${status}）。${trimmed ? ` 服务返回：${trimmed}` : ''}`;
}

async function callChat(
  config: LlmSeatConfig,
  messages: ChatMessage[],
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<ChatCallResult> {
  const baseUrl = (config.baseUrl ?? '').trim();
  const model = (config.model ?? '').trim();
  if (!baseUrl) throw new LlmError('format', '请先在设置中填写本地大模型的 Base URL');
  if (!model) throw new LlmError('format', '请先在设置中填写本地大模型的模型名称');
  const url = resolveChatCompletionsUrl(baseUrl);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1000, timeoutMs));
  const onExternalAbort = (): void => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
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
        temperature: typeof config.temperature === 'number' ? config.temperature : 0.5,
        max_tokens: MAX_TOKENS,
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
    const record = (data ?? {}) as Record<string, unknown>;
    let content = '';
    const choices = record.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const choice = choices[0] as Record<string, unknown>;
      const message = choice.message as Record<string, unknown> | undefined;
      const rawContent = message?.content ?? choice.text;
      if (typeof rawContent === 'string') content = rawContent;
      else if (Array.isArray(rawContent)) {
        content = rawContent
          .map((part) =>
            typeof part === 'string'
              ? part
              : ((part as Record<string, unknown>)?.text as string | undefined) ?? '',
          )
          .join('');
      }
    } else if (typeof record.response === 'string') {
      // 兼容 Ollama 原生 /api/generate 的返回格式
      content = record.response;
    }
    if (!content.trim()) {
      throw new LlmError('format', '本地模型返回了空内容，请检查模型名称或服务日志。');
    }
    return { content, latencyMs, raw: data };
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (isAbortError(error)) {
      if (timedOut) {
        throw new LlmError(
          'timeout',
          `本地模型响应超时（${Math.round(timeoutMs / 1000)} 秒）。可以换更小的模型、降低温度或调大超时时间。`,
        );
      }
      throw new LlmError('timeout', '本地模型请求已取消。');
    }
    throw new LlmError('network', networkErrorMessage());
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

export interface LlmDecisionOptions {
  /** UI 在换局 / 人类操作时可传入以取消在途请求。 */
  signal?: AbortSignal;
}

/** 调用本地大模型做出一次合法决策。失败时抛出 LlmError（UI 可兜底为本地算法）。 */
export async function decideWithLlm(
  view: PlayerView,
  difficulty: Difficulty,
  config: LlmSeatConfig,
  options: LlmDecisionOptions = {},
): Promise<LlmDecision> {
  const legal = view.legal;
  if (!legal) throw new LlmError('format', '当前不是该玩家的行动回合');
  const { system, user } = buildLlmPrompt(view, difficulty, config);
  const timeoutMs =
    typeof config.timeoutMs === 'number' && config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  let call: ChatCallResult;
  try {
    call = await callChat(
      config,
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      timeoutMs,
      options.signal,
    );
  } catch (error) {
    if (error instanceof LlmError) throw error;
    throw new LlmError('network', networkErrorMessage());
  }

  const parsed = parseLlmAction(call.content, legal);
  const handCategory =
    view.board.length >= 3
      ? analyzePostflop(view.self.holeCards, view.board).categoryName
      : `起手牌 ${handKey(view.self.holeCards)}`;
  const debug: LlmDecisionDebug = {
    difficulty,
    profile: `本地大模型：${config.name || '模型'}（${config.model}）`,
    potOdds: potOddsOf(view, legal),
    handCategory,
    reasoning: parsed.repaired ? `${parsed.reason}（输出已被规则修正）` : parsed.reason,
    source: 'llm',
    model: config.model,
    latencyMs: call.latencyMs,
    rawResponse: call.content.slice(0, 500),
  };
  return { action: parsed.action, debug };
}

/** 测试本地模型连接（设置面板「测试连接」按钮）。不会抛异常。 */
export async function testLlmConnection(
  config: LlmSeatConfig,
): Promise<LlmConnectionResult> {
  const timeoutMs = Math.min(
    typeof config.timeoutMs === 'number' && config.timeoutMs > 0 ? config.timeoutMs : 20000,
    20000,
  );
  try {
    const call = await callChat(
      config,
      [
        { role: 'system', content: '你是本地模型连通性测试助手。' },
        { role: 'user', content: '只回复两个字：正常' },
      ],
      timeoutMs,
    );
    return {
      ok: true,
      message: `连接成功（${call.latencyMs}ms）`,
      latencyMs: call.latencyMs,
      sample: call.content.trim().slice(0, 80),
    };
  } catch (error) {
    const message = error instanceof LlmError ? error.message : networkErrorMessage();
    return { ok: false, message };
  }
}

export { actionText as formatLlmActionText, formatLegalActions, potOddsOf as llmPotOdds };
