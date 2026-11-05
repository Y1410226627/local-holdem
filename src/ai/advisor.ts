/**
 * AI 军师：帮助人类玩家分析局势 / 闲聊的独立大模型通道（中文输出）。
 *
 * 特点：
 * - 只用「人类玩家自己的 PlayerView」构造成本（自己的底牌 + 公开信息），不泄露对手底牌；
 * - 中文回答，简洁优先；仅在用户点击「分析局势」或发送消息时调用，绝不定时空转烧 token；
 * - 与牌桌上的大模型玩家完全分开配置（可接不同的模型 / 接口）；
 * - 输出失败时抛出 LlmError，由 UI 显示可读错误，不阻塞牌局。
 */
import type { PlayerView } from '../game/playerView';
import { cardsLabel } from '../game/cards';
import {
  LlmError,
  callChatCompletion,
  type ChatMessage,
  type LlmEndpointConfig,
} from './llmClient';

export interface AdvisorConfig extends LlmEndpointConfig {
  name?: string;
}

export interface AdvisorContext {
  view: PlayerView | null;
  /** 桌面难度标签（中文），可为空。 */
  difficultyLabel?: string;
  /** 最近几条公开行动文本（中文），可选。 */
  recentActions?: string[];
}

export interface AdvisorReply {
  text: string;
  latencyMs: number;
  /** 原始返回（调试用，已截断）。 */
  raw?: string;
}

const MAX_HISTORY_MESSAGES = 6;
const MAX_ADVISOR_TOKENS = 800;

const SYSTEM_PROMPT = [
  '你是用户的私人德州扑克教练与聊天伙伴，用简体中文回答。',
  '原则：',
  '1) 优先帮用户分析当前局势：位置、底池赔率、下注尺度、对手可能范围、下一步建议（可给 1-2 个选项并说明理由）；',
  '2) 只根据公开信息与用户自己的底牌，绝不假装知道对手底牌；',
  '3) 回答简洁，默认不超过 120 字；可以指出风险，但不要替用户做绝对决定；',
  '4) 用户如果不问牌局、只是闲聊，可以正常聊天，保持简短友好；',
  '5) 不输出 Markdown 表格、代码块或长篇分点，必要时用两三个短句。',
].join('\n');

function contextText(context: AdvisorContext): string {
  const view = context.view;
  if (!view) {
    return '当前没有进行中的手牌（在大厅或本手已结束）。';
  }
  const legal = view.legal;
  const recent = (context.recentActions ?? []).slice(-6).join('；');
  const lines = [
    `手牌：第 ${view.handNo} 手，${view.street}；位置 ${view.players.length} 人桌，你是 ${
      view.players.find((player) => player.id === view.viewerId)?.name ?? '你'
    }。`,
    `底池 ${view.pot}；当前下注 ${view.currentBet}；你的筹码 ${view.self.stack}；你本轮已投入 ${view.self.committedThisStreet}。`,
    `你的底牌：${cardsLabel(view.self.holeCards)}；公共牌：${
      view.board.length > 0 ? cardsLabel(view.board) : '无'
    }。`,
    `其他玩家：${view.players
      .filter((player) => player.id !== view.viewerId)
      .map((player) => `${player.name}（筹码 ${player.stack}，本轮 ${player.committedThisStreet}，${player.status}）`)
      .join('；')}。`,
  ];
  if (recent) lines.push(`最近行动：${recent}。`);
  if (legal) {
    lines.push(
      `现在轮到你：可跟注 ${legal.callAmount}，最小加注到 ${legal.minRaiseTo}，最大加注到 ${legal.maxRaiseTo}。`,
    );
  } else {
    lines.push('现在不是你的行动回合（或本手已结束）。');
  }
  if (context.difficultyLabel) lines.push(`对手难度：${context.difficultyLabel}。`);
  return lines.join('\n');
}

export interface AdvisorMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 构造发给军师模型的 messages（中文；含历史对话裁剪）。 */
export function buildAdvisorMessages(
  context: AdvisorContext,
  history: readonly AdvisorMessage[],
  question?: string,
): ChatMessage[] {
  const trimmedHistory = history
    .filter((message) => message.content.trim().length > 0)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => ({ role: message.role, content: message.content.trim() }));
  const lines = [contextText(context)];
  lines.push(
    question?.trim()
      ? `用户的问题：${question.trim()}`
      : '请简短分析当前局势，并给 1-2 个可执行选项。',
  );
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...trimmedHistory,
    { role: 'user', content: lines.join('\n') },
  ];
}

/** 调用军师模型（中文输出）。失败抛 LlmError。 */
export async function askAdvisor(
  config: AdvisorConfig,
  context: AdvisorContext,
  history: readonly AdvisorMessage[] = [],
  question?: string,
  options: { signal?: AbortSignal } = {},
): Promise<AdvisorReply> {
  const messages = buildAdvisorMessages(context, history, question);
  const result = await callChatCompletion(
    {
      ...config,
      timeoutMs: typeof config.timeoutMs === 'number' && config.timeoutMs > 0 ? config.timeoutMs : 60_000,
    },
    messages,
    { signal: options.signal, maxTokens: Math.max(MAX_ADVISOR_TOKENS, config.maxTokens ?? 0) },
  );
  const text = (result.content || result.reasoning).trim();
  if (!text) {
    const finish = result.finishReason ? `（finish_reason=${result.finishReason}）` : '';
    throw new LlmError(
      'format',
      `军师模型返回空内容${finish}。可换用非思考模型，或在设置里调大军师的 maxTokens。`,
    );
  }
  return { text, latencyMs: result.latencyMs, raw: result.content.slice(0, 400) };
}

/** 测试军师连接（不抛异常）。 */
export async function testAdvisorConnection(config: AdvisorConfig): Promise<{
  ok: boolean;
  message: string;
  latencyMs?: number;
  sample?: string;
}> {
  try {
    const result = await callChatCompletion(config, [
      { role: 'system', content: '你是连通性测试助手，只回复：正常' },
      { role: 'user', content: '只回复两个字：正常' },
    ]);
    const text = (result.content || result.reasoning).trim();
    if (!text) {
      return { ok: false, message: '服务已连通，但模型返回空内容，请换用非思考模型。' };
    }
    return {
      ok: true,
      message: `连接成功（${result.latencyMs}ms）`,
      latencyMs: result.latencyMs,
      sample: text.slice(0, 80),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof LlmError ? error.message : '连接失败，请检查配置。',
    };
  }
}
