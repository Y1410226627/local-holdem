/** 设置栏：难度、人数、速度、种子、调试 / 训练开关与牌局按钮。 */
import type { Difficulty, TableState } from '../game/types';
import { DIFFICULTY_LABELS, DIFFICULTY_ORDER } from '../game/types';
import { SPEED_LABELS, SPEED_OPTIONS, type AiSpeed, type GameSettings } from './types';
import { RANDOM_SEED_PLACEHOLDER } from './seed';

interface SettingsBarProps {
  settings: GameSettings;
  table: TableState;
  onChange: (patch: Partial<GameSettings>) => void;
  onNewGame: () => void;
  onNextHand: () => void;
  onResetChips: () => void;
  onExport: () => void;
  onOpenTutorial: () => void;
  onOpenLlmSettings: () => void;
  llmEnabledCount: number;
  learnedAvailable: boolean;
  learnedEnabled: boolean;
  onToggleLearned: (enabled: boolean) => void;
  /** 大模型玩家是否输出神态/语句。 */
  tableTalk: boolean;
  onToggleTableTalk: (enabled: boolean) => void;
  /** AI 军师面板开关。 */
  advisorEnabled: boolean;
  onToggleAdvisor: (enabled: boolean) => void;
}

const PLAYER_COUNTS = [2, 3, 4, 5, 6];

export function SettingsBar({
  settings,
  table,
  onChange,
  onNewGame,
  onNextHand,
  onResetChips,
  onExport,
  onOpenTutorial,
  onOpenLlmSettings,
  llmEnabledCount,
  learnedAvailable,
  learnedEnabled,
  onToggleLearned,
  tableTalk,
  onToggleTableTalk,
  advisorEnabled,
  onToggleAdvisor,
}: SettingsBarProps) {
  const canNextHand = table.phase === 'handOver' || table.phase === 'idle';
  const maxLlmCount = Math.max(0, settings.playerCount - 1);

  return (
    <section className="settings-bar" aria-label="牌局设置">
      <div className="settings-bar__fields">
        <label className="field">
          <span className="field__label">难度</span>
          <select
            className="field__control"
            value={settings.difficulty}
            onChange={(event) => onChange({ difficulty: event.target.value as Difficulty })}
            aria-label="机器人难度"
          >
            {DIFFICULTY_ORDER.map((difficulty) => (
              <option key={difficulty} value={difficulty}>
                {DIFFICULTY_LABELS[difficulty]}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">人数</span>
          <select
            className="field__control"
            value={settings.playerCount}
            onChange={(event) => onChange({ playerCount: Number(event.target.value) })}
            aria-label="玩家人数"
          >
            {PLAYER_COUNTS.map((count) => (
              <option key={count} value={count}>
                {count} 人
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">速度</span>
          <select
            className="field__control"
            value={settings.speed}
            onChange={(event) => onChange({ speed: event.target.value as AiSpeed })}
            aria-label="机器人行动速度"
          >
            {SPEED_OPTIONS.map((speed) => (
              <option key={speed} value={speed}>
                {SPEED_LABELS[speed]}
              </option>
            ))}
          </select>
        </label>

        <label className="field field--seed" title={RANDOM_SEED_PLACEHOLDER}>
          <span className="field__label">随机种子</span>
          <input
            type="text"
            className="field__control"
            value={settings.seed}
            onChange={(event) => onChange({ seed: event.target.value })}
            spellCheck={false}
            autoComplete="off"
            placeholder={RANDOM_SEED_PLACEHOLDER}
            aria-label="随机种子"
          />
        </label>

        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.debugMode}
            onChange={(event) => onChange({ debugMode: event.target.checked })}
          />
          <span>调试模式</span>
        </label>

        <label className="toggle" title="让大模型玩家在行动时附带一句神态/台词（额外消耗少量 token）">
          <input
            type="checkbox"
            checked={tableTalk}
            onChange={(event) => onToggleTableTalk(event.target.checked)}
          />
          <span>神态语句</span>
        </label>

        <label className="toggle" title="人类玩家的私人教练：按需分析局势/闲聊（中文，省 token）">
          <input
            type="checkbox"
            checked={advisorEnabled}
            onChange={(event) => onToggleAdvisor(event.target.checked)}
          />
          <span>AI 军师</span>
        </label>

        {learnedAvailable && (
          <label className="toggle toggle--learned">
            <input
              type="checkbox"
              checked={learnedEnabled}
              onChange={(event) => onToggleLearned(event.target.checked)}
            />
            <span>使用训练后参数</span>
          </label>
        )}

        <span className="settings-hint">
          种子留空 = 每局自动随机（牌不会重复）；填写固定值可复现。人数与种子在点「新局」后生效；难度即时生效。
          <span className="settings-hint__seed" aria-label="本局实际种子">
            {table.phase === 'idle'
              ? '点「开始对局」时生成实际种子'
              : `本局实际种子：${table.config.seed}`}
          </span>
          <span className="settings-hint__players" aria-label="玩家名称">
            玩家名称、多个大模型、人物设定与 AI 军师：点「AI 玩家设置」。
          </span>
          {learnedAvailable && (
            <span className="settings-hint__loaded">
              训练数据已加载 · 运行 训练机器人.bat 或 npm run train:quick 生成
            </span>
          )}
        </span>
      </div>

      <div className="settings-bar__actions">
        <button type="button" className="btn btn--primary" onClick={onNewGame}>
          新局
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={onNextHand}
          disabled={!canNextHand}
        >
          下一手
        </button>
        <button type="button" className="btn btn--secondary" onClick={onResetChips}>
          重置筹码
        </button>
        <button type="button" className="btn btn--secondary" onClick={onExport}>
          导出历史
        </button>
        <button type="button" className="btn btn--ghost" onClick={onOpenTutorial}>
          新手教程
        </button>
        <button
          type="button"
          className={`btn btn--secondary settings-bar__llm${
            llmEnabledCount > 0 ? ' settings-bar__llm--on' : ''
          }`}
          onClick={onOpenLlmSettings}
        >
          AI 玩家设置
          <span className="settings-bar__llm-count" aria-label={`已启用 ${llmEnabledCount} 个大模型玩家`}>
            {llmEnabledCount}/{maxLlmCount}
          </span>
        </button>
      </div>
    </section>
  );
}
