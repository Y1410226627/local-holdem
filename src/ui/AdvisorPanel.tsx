/**
 * AI 军师面板：人类玩家的私人教练 / 聊天伙伴（中文输出）。
 *
 * 省 token 设计：只有点击「分析当前局势」或按回车发送时才会请求模型；
 * 关闭开关后完全静默；不参与牌局 AI 决策。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TableState } from '../game/types';
import { DIFFICULTY_LABELS } from '../game/types';
import { buildPlayerView } from '../game/playerView';
import { askAdvisor, type AdvisorContext } from '../ai/advisor';
import {
  advisorReady,
  toAdvisorConfig,
  type LlmSettings,
} from './llmSettings';
import { formatAction, getErrorMessage, STREET_LABELS } from './format';

interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
}

interface AdvisorPanelProps {
  table: TableState;
  settings: LlmSettings;
  onOpenSettings: () => void;
  onDisable: () => void;
}

function buildContext(table: TableState): AdvisorContext {
  const humanIndex = table.players.findIndex((player) => player.isHuman);
  let view: AdvisorContext['view'] = null;
  if (table.hand && humanIndex >= 0) {
    try {
      view = buildPlayerView(table.hand, table.players[humanIndex].id, table.config.seed);
    } catch {
      view = null;
    }
  }
  const recentActions = table.hand
    ? table.hand.actions
        .slice(-6)
        .map((record) => `${STREET_LABELS[record.street]} ${record.actorName} ${formatAction(record.action)}`)
    : [];
  return {
    view,
    difficultyLabel: DIFFICULTY_LABELS[table.config.difficulty],
    recentActions,
  };
}

const QUICK_QUESTIONS = ['分析当前局势', '我这手该怎么打？', '对手大概什么范围？'];

export function AdvisorPanel({ table, settings, onOpenSettings, onDisable }: AdvisorPanelProps) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const ready = advisorReady(settings);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [entries, loading]);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  const send = useCallback(
    async (preset?: string) => {
      if (loading || !ready) return;
      const question = (preset ?? input).trim();
      if (!question) return;
      const history = entries.map((entry) => ({ role: entry.role, content: entry.content }));
      const context = buildContext(table);
      controllerRef.current = new AbortController();
      setLoading(true);
      setError(null);
      setInput('');
      setEntries((previous) => [...previous, { role: 'user', content: question }]);
      try {
        const reply = await askAdvisor(
          toAdvisorConfig(settings),
          context,
          history,
          preset ? undefined : question,
          { signal: controllerRef.current.signal },
        );
        setEntries((previous) => [...previous, { role: 'assistant', content: reply.text }]);
      } catch (caught) {
        if (controllerRef.current?.signal.aborted) return;
        const message = getErrorMessage(caught);
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [entries, input, loading, ready, settings, table],
  );

  return (
    <section className="advisor-panel" aria-label="AI 军师">
      <header className="advisor-panel__head">
        <div>
          <h2 className="advisor-panel__title">AI 军师</h2>
          <p className="advisor-panel__hint">只在你点按钮/发送时调用（省 token）；中文回答，仅作参考。</p>
        </div>
        <div className="advisor-panel__head-actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onOpenSettings}>
            设置
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onDisable} aria-label="关闭 AI 军师">
            ×
          </button>
        </div>
      </header>

      {!ready ? (
        <div className="advisor-panel__empty">
          <p>还没有配置军师模型。可以填一个你喜欢的本地/外部模型，专门用来聊天和复盘。</p>
          <button type="button" className="btn btn--primary btn--sm" onClick={onOpenSettings}>
            去设置军师模型
          </button>
        </div>
      ) : (
        <>
          <div className="advisor-quick" aria-label="快捷提问">
            {QUICK_QUESTIONS.map((question) => (
              <button
                key={question}
                type="button"
                className="quick-button"
                disabled={loading}
                onClick={() => {
                  void send(question);
                }}
              >
                {question}
              </button>
            ))}
            {entries.length > 0 && (
              <button
                type="button"
                className="quick-button"
                disabled={loading}
                onClick={() => {
                  setEntries([]);
                  setError(null);
                }}
              >
                清空对话
              </button>
            )}
          </div>

          <div className="advisor-messages" ref={listRef}>
            {entries.length === 0 && !loading && (
              <p className="advisor-messages__empty">
                点上方快捷问题，或直接输入问题（比如「这手牌要不要跟注？」）。也可以随便聊两句。
              </p>
            )}
            {entries.map((entry, index) => (
              <div key={`advisor-${index}`} className={`advisor-message advisor-message--${entry.role}`}>
                <span className="advisor-message__role">{entry.role === 'user' ? '你' : '军师'}</span>
                <p className="advisor-message__text">{entry.content}</p>
              </div>
            ))}
            {loading && (
              <div className="advisor-message advisor-message--assistant" role="status">
                <span className="advisor-message__role">军师</span>
                <p className="advisor-message__text advisor-message__text--loading">思考中…</p>
              </div>
            )}
          </div>

          {error && (
            <div className="advisor-error" role="alert">
              调用失败：{error}
            </div>
          )}

          <form
            className="advisor-input"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <input
              type="text"
              className="advisor-input__field"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="问局势，或随便聊聊…"
              aria-label="向 AI 军师提问"
              disabled={loading}
            />
            <button type="submit" className="btn btn--primary btn--sm" disabled={loading || !input.trim()}>
              发送
            </button>
          </form>
        </>
      )}
    </section>
  );
}
