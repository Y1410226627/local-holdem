/**
 * AI 回合驱动：监听会话状态，轮到机器人时延迟调用本地 AI 或本地大模型。
 *
 * 去重与竞态防护：
 * - 用 `${handNo}:${actionCount}:${actingIndex}` 作为回合 key；
 * - effect 清理时取消定时器、中止在途大模型请求，并用 runId 丢弃过期决策；
 * - 通过 epochRef（由 App 在换局 / 改难度 / 人类行动时递增）作废在途决策；
 * - 决策成功后记录已执行的 key，避免同一回合被重复执行。
 *
 * 大模型失败 / 超时 / 未配置时：提示原因并回退本地算法（最多 400 次蒙特卡洛），
 * 保证牌局永远能继续。
 */
import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { LlmSeatConfig, PlayerAction, TableState } from '../game/types';
import { act } from '../game/stateMachine';
import { getLegalActions } from '../game/gameEngine';
import { buildPlayerView } from '../game/playerView';
import { derivedRng } from '../game/cards';
import { decide, type AIDecision } from '../ai/aiPlayer';
import { decideWithLlm } from '../ai/llmBot';
import { pickLocalTalk, shouldLocalTalk } from '../ai/style';
import { findEnabledLlmSlot, toLlmSeatConfig, type LlmSettings } from './llmSettings';
import type { AiDebugRecord, AiSpeed } from './types';
import { SPEED_DELAYS } from './types';
import { formatAction, getErrorMessage } from './format';

interface AiDriverOptions {
  table: TableState;
  speed: AiSpeed;
  setTable: Dispatch<SetStateAction<TableState>>;
  onDecision: (record: Omit<AiDebugRecord, 'id'>) => void;
  onError: (message: string) => void;
  epochRef: { current: number };
  /** 当前大模型设置：每个大模型回合开始时读取一次，避免编辑设置打断在途请求。 */
  llmSettings: LlmSettings;
}

export function useAiDriver({
  table,
  speed,
  setTable,
  onDecision,
  onError,
  epochRef,
  llmSettings,
}: AiDriverOptions): void {
  const tableRef = useRef(table);
  const runIdRef = useRef(0);
  const appliedRef = useRef<{ epoch: number; key: string } | null>(null);
  const llmSettingsRef = useRef(llmSettings);

  useEffect(() => {
    llmSettingsRef.current = llmSettings;
  }, [llmSettings]);

  useEffect(() => {
    tableRef.current = table;
    const epoch = epochRef.current;
    const hand = table.hand;

    if (table.phase !== 'playing' || !hand || hand.actingIndex === null) return;
    const actorIndex = hand.actingIndex;
    const actor = hand.players[actorIndex];
    if (!actor || actor.isHuman || actor.status !== 'active') return;

    const challengeMode = table.config.challengeMode === true;
    const turnStartedAt = performance.now();
    const key = `${hand.handNo}:${hand.actionCount}:${actorIndex}`;
    const applied = appliedRef.current;
    if (applied && applied.epoch === epoch && applied.key === key) return;

    // hand.players 中的难度是发牌时的快照；改难度会更新 table.players，
    // 因此这里以会话层玩家为准，保证“下一动作立即使用新难度”。
    const aiDifficulty = table.players[actorIndex]?.difficulty ?? table.config.difficulty;
    const tablePlayer = table.players[actorIndex];
    const isLlm = actor.kind === 'llm' || tablePlayer?.kind === 'llm';
    const llmSlot = actor.llmSlot ?? tablePlayer?.llmSlot;
    const slotSettings =
      isLlm && llmSlot ? findEnabledLlmSlot(llmSettingsRef.current, llmSlot) : undefined;
    const llmConfig: LlmSeatConfig | null = slotSettings ? toLlmSeatConfig(slotSettings) : null;

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    let cancelled = false;
    const controller = new AbortController();

    const isCurrent = (): boolean =>
      !cancelled && epochRef.current === epoch && runIdRef.current === runId;

    const readActingKey = (): string | null => {
      const latest = tableRef.current;
      const latestHand = latest.hand;
      if (latest.phase !== 'playing' || !latestHand || latestHand.actingIndex === null) {
        return null;
      }
      return `${latestHand.handNo}:${latestHand.actionCount}:${latestHand.actingIndex}`;
    };

    /** 异常兜底：尝试用 check（可过牌时）或 fold 推进牌局，避免卡死。 */
    const recover = (reason: string): void => {
      if (epochRef.current !== epoch) return;
      const latest = tableRef.current;
      const latestHand = latest.hand;
      if (latest.phase !== 'playing' || !latestHand || latestHand.actingIndex !== actorIndex) {
        onError(reason);
        return;
      }
      try {
        const legal = getLegalActions(latestHand, actorIndex);
        const safeAction: PlayerAction = legal.canCheck ? { type: 'check' } : { type: 'fold' };
        const nextTable = act(latest, actorIndex, safeAction);
        setTable(nextTable);
        onError(
          `${reason}，已自动使用「${safeAction.type === 'check' ? '过牌' : '弃牌'}」继续牌局。`,
        );
      } catch (fallbackError) {
        onError(
          `${reason}，且无法自动恢复：${getErrorMessage(fallbackError)}。请点击「重置筹码」或「新局」。`,
        );
      }
    };

    const run = async (): Promise<void> => {
      if (!isCurrent() || readActingKey() !== key) return;

      const current = tableRef.current;
      const currentHand = current.hand;
      if (current.phase !== 'playing' || !currentHand) return;

      try {
        const view = buildPlayerView(currentHand, actor.id, current.config.seed);
        let decision: AIDecision | null = null;
        let fallbackFromLlm = false;
        let fallbackReason: string | undefined;
        let llmFailureMessage: string | null = null;
        let llmAttemptLatency: number | undefined;
        let talk: string | undefined;

        if (isLlm && llmConfig) {
          const attemptStarted = performance.now();
          try {
            const llmDecision = await decideWithLlm(view, aiDifficulty, llmConfig, {
              signal: controller.signal,
              talk: llmSettingsRef.current.tableTalk,
            });
            if (!isCurrent() || controller.signal.aborted) return;
            decision = llmDecision;
            talk = llmDecision.talk;
          } catch (error) {
            // 被换局 / 人类操作 / 新一手取消：静默退出，不提示、不回退。
            if (!isCurrent() || controller.signal.aborted) return;
            llmAttemptLatency = Math.round(performance.now() - attemptStarted);
            fallbackFromLlm = true;
            fallbackReason = getErrorMessage(error);
            llmFailureMessage = fallbackReason;
          }
        } else if (isLlm) {
          fallbackFromLlm = true;
          fallbackReason = '当前槽位没有已启用的本地大模型配置';
          llmFailureMessage = fallbackReason;
        }

        if (!decision) {
          // 大模型失败 → 回退本地算法；同一回合限制模拟次数，尽快推进。
          // 挑战模式下本地算法（含回退）启用宗师 AI。
          decision = await decide(view, aiDifficulty, {
            ...(isLlm ? { maxIterations: 400 } : {}),
            ...(challengeMode ? { challenge: true } : {}),
          });
        }

        // 挑战模式：用「快打 / 长考」伪装节奏（只影响等待时间，不影响动作合法性）。
        if (challengeMode && !isLlm && decision.timingHint === 'slow' && speed !== 'fast') {
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, Math.round(SPEED_DELAYS[speed] * 1.4));
          });
          if (!isCurrent() || readActingKey() !== key) return;
        }

        // 体验随机：本地算法玩家在开启「神态语句」时也会偶尔说一句（纯表演，不影响决策）。
        if (!isLlm && llmSettingsRef.current.tableTalk && decision.debug.source !== 'llm') {
          const seedParts = [view.seed, currentHand.actions.length, actor.id] as const;
          if (shouldLocalTalk(view.self.styleId, ...seedParts)) {
            talk = pickLocalTalk(view.self.styleId, ...seedParts);
          }
        }

        if (!isCurrent() || readActingKey() !== key) return;
        const alreadyApplied = appliedRef.current;
        if (alreadyApplied && alreadyApplied.epoch === epoch && alreadyApplied.key === key) return;

        const latest = tableRef.current;
        let nextTable: TableState;
        const thinkMs = Math.max(
          120,
          Math.min(30000, Math.round(performance.now() - turnStartedAt)),
        );
        try {
          nextTable = act(latest, actorIndex, decision.action, { thinkMs });
        } catch (actionError) {
          recover(`AI「${actor.name}」返回了非法动作（${getErrorMessage(actionError)}）`);
          return;
        }

        appliedRef.current = { epoch, key };
        setTable(nextTable);

        if (llmFailureMessage) {
          const separator = /[。！？.!?]$/.test(llmFailureMessage) ? '' : '。';
          onError(
            `大模型「${actor.name}」调用失败：${llmFailureMessage}${separator}已回退本地算法继续牌局。`,
          );
        }

        onDecision({
          handNo: currentHand.handNo,
          street: currentHand.street,
          playerId: actor.id,
          playerName: actor.name,
          difficulty: decision.debug.difficulty,
          actionText: formatAction(decision.action, view.legal),
          equity: decision.debug.equity,
          potOdds: decision.debug.potOdds,
          iterations: decision.debug.iterations,
          reasoning: decision.debug.reasoning,
          profile: decision.debug.profile,
          source: decision.debug.source === 'llm' ? 'llm' : 'local',
          model: decision.debug.model ?? llmConfig?.model,
          latencyMs: decision.debug.latencyMs ?? llmAttemptLatency,
          rawResponse: decision.debug.rawResponse,
          fallbackFromLlm,
          fallbackReason,
          talk,
          timing: decision.debug.timing,
          archetype: decision.debug.archetype,
        });
      } catch (error) {
        if (!isCurrent()) return;
        recover(`AI「${actor.name}」行动异常：${getErrorMessage(error)}`);
      }
    };

    // 体验随机：思考时间抖动 + 大底池“想久一点”，让节奏更像真人（不影响决策公平性）。
    const delayRng = derivedRng('bot-delay', table.config.seed, hand.handNo, actor.id, hand.actionCount);
    const jitter = 0.7 + delayRng() * 0.9;
    const potPressure = hand.pot > Math.max(1, actor.stack) * 1.5 ? 0.35 : 0;
    const delay = Math.max(150, Math.round(SPEED_DELAYS[speed] * (jitter + potPressure)));

    const timer = window.setTimeout(() => {
      void run();
    }, delay);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [table, speed, setTable, onDecision, onError, epochRef]);
}
