/** 历史 / 回放弹窗（P1）：查看已结束手牌、公共牌、底牌、底池结果与日志。 */
import { useEffect, useState } from 'react';
import type { HandHistory } from '../game/types';
import { cardLabel } from '../game/cards';
import { PlayingCard } from './CardView';
import { formatChips, STATUS_LABELS } from './format';

interface HistoryModalProps {
  history: HandHistory[];
  seed: string;
  onClose: () => void;
}

export function HistoryModal({ history, seed, onClose }: HistoryModalProps) {
  const [selected, setSelected] = useState(() => Math.max(0, history.length - 1));

  useEffect(() => {
    if (selected > history.length - 1) {
      setSelected(Math.max(0, history.length - 1));
    }
  }, [history.length, selected]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const hand = history[selected] ?? history[history.length - 1] ?? null;
  const winMap = new Map<number, number>();
  if (hand) {
    for (const winner of hand.result.winners) winMap.set(winner.playerId, winner.amount);
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal history-modal" role="dialog" aria-modal="true" aria-label="牌局历史">
        <header className="modal__header">
          <div>
            <h2 className="modal__title">牌局历史</h2>
            <p className="modal__subtitle">
              共 {history.length} 手 · 种子：{seed} · 按 Esc 关闭
            </p>
          </div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="关闭历史">
            ×
          </button>
        </header>

        {history.length === 0 || !hand ? (
          <div className="history-empty">
            暂无历史牌局。完整打完一手后，即可在这里查看公共牌、底牌、底池结果与日志。
          </div>
        ) : (
          <div className="history-modal__body">
            <div className="history-list" role="tablist" aria-label="历史手牌列表">
              {history.map((item, index) => (
                <button
                  key={`history-${item.handNo}`}
                  type="button"
                  role="tab"
                  aria-selected={index === selected}
                  className={`history-item${index === selected ? ' is-active' : ''}`}
                  onClick={() => setSelected(index)}
                >
                  <span className="history-item__no">第 {item.handNo} 手</span>
                  <span className="history-item__winner">
                    {item.result.winners
                      .map((winner) => `${winner.name} +${formatChips(winner.amount)}`)
                      .join('、') || '已结算'}
                  </span>
                  <span className="history-item__board">
                    {item.board.length > 0 ? item.board.map(cardLabel).join(' ') : '未发公共牌'}
                  </span>
                </button>
              ))}
            </div>

            <div className="history-detail">
              <div className="history-detail__head">
                <div>
                  <h3 className="history-detail__title">第 {hand.handNo} 手</h3>
                  <p className="history-detail__sub">
                    按钮位：{hand.players[hand.buttonIndex]?.name ?? '—'} · 种子：{hand.seed}
                  </p>
                </div>
                <div className="history-board" aria-label="公共牌">
                  {Array.from({ length: 5 }, (_item, index) => (
                    <PlayingCard
                      key={`history-board-${index}`}
                      card={hand.board[index] ?? null}
                      size="md"
                    />
                  ))}
                </div>
              </div>

              <section className="history-section">
                <h4 className="history-section__title">玩家与底牌</h4>
                <div className="history-players">
                  {hand.players.map((player) => {
                    const winAmount = winMap.get(player.id) ?? 0;
                    return (
                      <div
                        className={`history-player${winAmount > 0 ? ' history-player--winner' : ''}`}
                        key={`history-player-${player.id}`}
                      >
                        <div className="history-player__head">
                          <span className="history-player__name">{player.name}</span>
                          <span className={`history-player__status history-player__status--${player.status}`}>
                            {STATUS_LABELS[player.status]}
                          </span>
                        </div>
                        <div className="history-player__cards">
                          {player.holeCards.length > 0 ? (
                            player.holeCards.map((card) => (
                              <PlayingCard
                                key={`${player.id}-${card.rank}-${card.suit}`}
                                card={card}
                                size="sm"
                              />
                            ))
                          ) : (
                            <span className="history-player__empty">未发牌</span>
                          )}
                        </div>
                        <div className="history-player__stack">
                          {formatChips(player.startingStack)} → {formatChips(player.endingStack)}
                          {winAmount > 0 && ` · 赢 +${formatChips(winAmount)}`}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="history-section">
                <h4 className="history-section__title">底池结果</h4>
                <div className="history-pots">
                  {hand.result.pots.length === 0 && (
                    <div className="history-pot history-pot--empty">本手无底池可分</div>
                  )}
                  {hand.result.pots.map((pot) => (
                    <div className="history-pot" key={`history-pot-${pot.index}`}>
                      <span className="history-pot__label">{pot.label}</span>
                      <span className="history-pot__amount">{formatChips(pot.amount)}</span>
                      <span className="history-pot__payout">
                        {pot.payouts
                          .map((payout) => `${payout.name} +${formatChips(payout.amount)}`)
                          .join('、')}
                        {pot.oddChips > 0 && ` · 奇数筹码 ${pot.oddChips}`}
                      </span>
                    </div>
                  ))}
                  {hand.result.refunds.map((refund) => (
                    <div className="history-pot history-pot--refund" key={`history-refund-${refund.playerId}`}>
                      <span className="history-pot__label">退回</span>
                      <span className="history-pot__amount">{formatChips(refund.amount)}</span>
                      <span className="history-pot__payout">{refund.name} 收回未被跟注的筹码</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="history-section">
                <h4 className="history-section__title">牌局日志</h4>
                <div className="history-log">
                  {hand.log.map((entry) => (
                    <div
                      className={`history-log__line log-tone--${entry.kind}`}
                      key={`history-log-${entry.id}`}
                    >
                      {entry.text}
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
        )}

        <footer className="modal__footer">
          <span>历史数据保存在本页面内存中；可用设置栏「导出历史」保存为 JSON。</span>
          <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
