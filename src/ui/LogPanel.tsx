/** 侧栏日志面板：本手 / 全部（最近 200 条），按日志类型着色并自动滚动。 */
import { useEffect, useRef, useState } from 'react';
import type { TableState } from '../game/types';
import { LOG_KIND_LABELS } from './format';

interface LogPanelProps {
  table: TableState;
}

type LogScope = 'hand' | 'all';

export function LogPanel({ table }: LogPanelProps) {
  const [scope, setScope] = useState<LogScope>('hand');
  const listRef = useRef<HTMLDivElement | null>(null);

  const effectiveScope: LogScope = table.hand ? scope : 'all';
  const entries =
    effectiveScope === 'hand' && table.hand ? table.hand.log : table.logs.slice(-200);

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [effectiveScope, entries.length, table.hand?.handNo]);

  return (
    <section className="side-panel log-panel" aria-label="牌局日志">
      <div className="side-panel__header">
        <span className="side-panel__title">牌局日志</span>
        <div className="log-tabs" role="tablist" aria-label="日志范围">
          <button
            type="button"
            className={`log-tab${effectiveScope === 'hand' ? ' is-active' : ''}`}
            onClick={() => setScope('hand')}
            disabled={!table.hand}
            role="tab"
            aria-selected={effectiveScope === 'hand'}
          >
            本手
          </button>
          <button
            type="button"
            className={`log-tab${effectiveScope === 'all' ? ' is-active' : ''}`}
            onClick={() => setScope('all')}
            role="tab"
            aria-selected={effectiveScope === 'all'}
          >
            全部
          </button>
        </div>
      </div>

      <div className="log-list" ref={listRef} role="log" aria-live="polite">
        {entries.length === 0 ? (
          <div className="log-empty">暂无日志，开始一手牌后这里会显示过程记录。</div>
        ) : (
          entries.map((entry) => (
            <div
              className={`log-entry log-entry--${entry.kind}`}
              key={`${entry.handNo}-${entry.id}`}
            >
              <span className={`log-entry__kind log-entry__kind--${entry.kind}`}>
                {LOG_KIND_LABELS[entry.kind]}
              </span>
              <span className="log-entry__text">{entry.text}</span>
            </div>
          ))
        )}
      </div>

      <div className="side-panel__footer">
        <span>{effectiveScope === 'hand' ? `第 ${table.handNo} 手` : `全部日志（最近 200 条）`}</span>
        <span>{entries.length} 条</span>
      </div>
    </section>
  );
}
