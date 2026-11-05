/** 调试面板：展示最近 10 条 AI 决策（动作、胜率、赔率、模拟次数与中文依据）。 */
import { DIFFICULTY_LABELS } from '../game/types';
import { formatPercent, STREET_LABELS } from './format';
import type { AiDebugRecord } from './types';

interface DebugPanelProps {
  records: AiDebugRecord[];
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="debug-metric">
      <span className="debug-metric__label">{label}</span>
      <span className="debug-metric__value">{value}</span>
    </div>
  );
}

function sourceLabel(record: AiDebugRecord): string {
  if (record.source === 'llm') return '大模型';
  return record.fallbackFromLlm ? '已回退本地算法' : '本地算法';
}

export function DebugPanel({ records }: DebugPanelProps) {
  return (
    <section className="side-panel debug-panel" aria-label="AI 调试">
      <div className="side-panel__header">
        <span className="side-panel__title">AI 调试</span>
        <span className="side-panel__meta">最近 {records.length}/10 条决策</span>
      </div>

      <div className="debug-list">
        {records.length === 0 ? (
          <div className="debug-empty">
            调试模式已开启。机器人行动后，这里会显示动作、来源、胜率、底池赔率与决策依据。
          </div>
        ) : (
          records.map((record) => (
            <article className="debug-card" key={record.id}>
              <div className="debug-card__head">
                <span className="debug-card__player">{record.playerName}</span>
                <span className="diff-badge">{DIFFICULTY_LABELS[record.difficulty]}</span>
                <span
                  className={`debug-source${
                    record.source === 'llm' ? ' debug-source--llm' : ' debug-source--local'
                  }${record.fallbackFromLlm ? ' debug-source--fallback' : ''}`}
                >
                  {sourceLabel(record)}
                </span>
                <span className="debug-card__meta">
                  第 {record.handNo} 手 · {STREET_LABELS[record.street]}
                </span>
              </div>
              <div className="debug-card__action">{record.actionText}</div>

              {(record.model || record.latencyMs !== undefined) && (
                <div className="debug-card__model">
                  {record.model && <span>模型：{record.model}</span>}
                  {record.latencyMs !== undefined && <span>耗时：{record.latencyMs}ms</span>}
                </div>
              )}

              <div className="debug-card__metrics">
                <Metric label="胜率" value={formatPercent(record.equity)} />
                <Metric label="底池赔率" value={formatPercent(record.potOdds)} />
                <Metric
                  label="模拟次数"
                  value={
                    record.iterations !== undefined
                      ? record.iterations.toLocaleString('zh-CN')
                      : '—'
                  }
                />
              </div>
              {record.profile && <div className="debug-card__profile">策略：{record.profile}</div>}
              {record.fallbackReason && (
                <div className="debug-card__fallback">回退原因：{record.fallbackReason}</div>
              )}
              <div className="debug-card__reason">{record.reasoning || '（无决策说明）'}</div>
              {record.rawResponse && (
                <details className="debug-raw">
                  <summary>原始响应（已截断）</summary>
                  <pre className="debug-raw__content">{record.rawResponse}</pre>
                </details>
              )}
            </article>
          ))
        )}
      </div>
    </section>
  );
}
