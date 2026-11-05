/** 应用外壳：教程 / 大厅、会话状态、设置、AI 驱动、日志 / 历史 / 提示的编排。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Difficulty, PlayerAction, TableState } from '../game/types';
import { DIFFICULTY_LABELS } from '../game/types';
import {
  act,
  createTable,
  exportHistory,
  getHumanLegalActions,
  resetChips,
  setTableDifficulty,
  startNextHand,
} from '../game/stateMachine';
import { hasLearnedProfiles, setLearnedProfilesEnabled } from '../ai/learnedProfiles';
import { useAiDriver } from './useAiDriver';
import type { AiDebugRecord, GameSettings, LobbyInfo, Notice } from './types';
import { DEFAULT_SETTINGS } from './types';
import { SettingsBar } from './SettingsBar';
import { Table } from './Table';
import { Controls } from './Controls';
import { LogPanel } from './LogPanel';
import { DebugPanel } from './DebugPanel';
import { HistoryModal } from './HistoryModal';
import { TutorialModal } from './TutorialModal';
import { LlmSettingsModal } from './LlmSettingsModal';
import { formatChips, getErrorMessage } from './format';
import {
  enabledLlmSeatConfigs,
  loadLlmSettings,
  saveLlmSettings,
  type LlmSettings,
} from './llmSettings';
import {
  hasSeenTutorial,
  loadLearnedProfilesEnabled,
  markTutorialSeen,
  saveLearnedProfilesEnabled,
} from './storage';
import { recordLlmHandMemories } from './handMemory';
import { describeSeed, resolveSeed } from './seed';

interface BootState {
  table: TableState;
  llm: LlmSettings;
  error: string | null;
}

/** 初始闲置牌桌：按默认设置与已启用的大模型座位创建，但绝不自动发牌。 */
function createBootState(): BootState {
  const llm = loadLlmSettings();
  const base = {
    playerCount: DEFAULT_SETTINGS.playerCount,
    difficulty: DEFAULT_SETTINGS.difficulty,
    // 种子留空 = 随机：闲置牌桌只是占位，真正开局时还会再生成一次新种子。
    seed: resolveSeed(DEFAULT_SETTINGS.seed).seed,
    smallBlind: 10,
    bigBlind: 20,
    startingStack: 1000,
  };
  try {
    return {
      table: createTable({ ...base, llmSeats: enabledLlmSeatConfigs(llm) }),
      llm,
      error: null,
    };
  } catch (error) {
    return {
      table: createTable(base),
      llm,
      error: `当前大模型设置无法加入牌桌：${getErrorMessage(error)}。已先创建不含大模型的闲置牌桌，请调整人数或关闭一个槽位后再开始。`,
    };
  }
}

export function App() {
  const [boot] = useState<BootState>(createBootState);
  const [settings, setSettings] = useState<GameSettings>(DEFAULT_SETTINGS);
  const [llmSettings, setLlmSettings] = useState<LlmSettings>(boot.llm);
  const [table, setTable] = useState<TableState>(boot.table);
  const [debugRecords, setDebugRecords] = useState<AiDebugRecord[]>([]);
  const [notice, setNotice] = useState<Notice | null>(() =>
    boot.error ? { id: 0, tone: 'error', text: boot.error } : null,
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(() => !hasSeenTutorial());
  const [llmSettingsOpen, setLlmSettingsOpen] = useState(false);
  const [learnedAvailable] = useState(() => hasLearnedProfiles());
  const [learnedEnabled, setLearnedEnabled] = useState(
    () => learnedAvailable && loadLearnedProfilesEnabled(),
  );

  /** 换局 / 改难度 / 人类行动时递增，用于作废在途的 AI 决策。 */
  const epochRef = useRef(0);
  const noticeIdRef = useRef(0);
  const recordIdRef = useRef(0);
  /** 已经写入过大模型对局记忆的历史手数（防重复）。 */
  const recordedHistoryRef = useRef(0);

  const humanIndex = table.players.findIndex((player) => player.isHuman);
  const legal = getHumanLegalActions(table);
  const humanStack = humanIndex >= 0 ? (table.players[humanIndex]?.stack ?? 0) : 0;

  const showNotice = useCallback((tone: Notice['tone'], text: string) => {
    noticeIdRef.current += 1;
    setNotice({ id: noticeIdRef.current, tone, text });
  }, []);

  const handleAiDecision = useCallback((record: Omit<AiDebugRecord, 'id'>) => {
    recordIdRef.current += 1;
    const nextRecord: AiDebugRecord = { ...record, id: recordIdRef.current };
    setDebugRecords((previous) => [nextRecord, ...previous].slice(0, 10));
  }, []);

  const handleAiError = useCallback(
    (message: string) => {
      showNotice('error', message);
    },
    [showNotice],
  );

  useAiDriver({
    table,
    speed: settings.speed,
    setTable,
    onDecision: handleAiDecision,
    onError: handleAiError,
    epochRef,
    llmSettings,
  });

  // 训练后参数默认开启（检测到训练产物时）；切换立即生效。
  useEffect(() => {
    setLearnedProfilesEnabled(learnedAvailable && learnedEnabled);
  }, [learnedAvailable, learnedEnabled]);

  // 每手结束写入大模型对局记忆：按 history 长度增量处理，并用 ref 防重复。
  useEffect(() => {
    if (table.history.length < recordedHistoryRef.current) recordedHistoryRef.current = 0;
    if (table.history.length === recordedHistoryRef.current) return;
    const pending = table.history.slice(recordedHistoryRef.current);
    recordedHistoryRef.current = table.history.length;
    for (const hand of pending) {
      try {
        recordLlmHandMemories(hand);
      } catch {
        // 浏览器存储异常不应打断牌局。
      }
    }
  }, [table.history]);

  // 信息类提示自动消失；错误提示保留到下一次操作或手动关闭。
  useEffect(() => {
    if (!notice || notice.tone !== 'info') return;
    const timer = window.setTimeout(() => {
      setNotice((current) => (current && current.id === notice.id ? null : current));
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const handleHumanAction = useCallback(
    (action: PlayerAction) => {
      if (table.phase !== 'playing' || !table.hand) return;
      try {
        const index = table.players.findIndex((player) => player.isHuman);
        if (index < 0) throw new Error('找不到人类玩家');
        const next = act(table, index, action);
        epochRef.current += 1;
        setTable(next);
        setNotice(null);
      } catch (error) {
        showNotice('error', `操作失败：${getErrorMessage(error)}`);
      }
    },
    [table, showNotice],
  );

  const handleSettingsChange = useCallback(
    (patch: Partial<GameSettings>) => {
      setSettings((previous) => ({ ...previous, ...patch }));
      const nextDifficulty: Difficulty | undefined = patch.difficulty;
      if (nextDifficulty && nextDifficulty !== table.config.difficulty) {
        epochRef.current += 1;
        setTable((previous) => setTableDifficulty(previous, nextDifficulty));
      }
    },
    [table.config.difficulty],
  );

  /** 按当前设置创建新桌并开始第一手（大厅「开始对局」与「新局」共用）。 */
  const startGame = useCallback(() => {
    try {
      // 种子留空 → 每次开局生成新随机种子，保证每局发牌不同；填写固定种子 → 可复现同一局。
      const resolvedSeed = resolveSeed(settings.seed);
      const llmSeats = enabledLlmSeatConfigs(llmSettings);
      const next = startNextHand(
        createTable({
          playerCount: settings.playerCount,
          difficulty: settings.difficulty,
          seed: resolvedSeed.seed,
          smallBlind: 10,
          bigBlind: 20,
          startingStack: 1000,
          llmSeats,
        }),
      );
      setLearnedProfilesEnabled(learnedAvailable && learnedEnabled);
      epochRef.current += 1;
      recordedHistoryRef.current = 0;
      setTable(next);
      setDebugRecords([]);
      setHistoryOpen(false);
      showNotice(
        'info',
        `新牌局已开始：${settings.playerCount} 人 · 盲注 10/20 · ${
          DIFFICULTY_LABELS[settings.difficulty]
        }难度${llmSeats.length > 0 ? ` · ${llmSeats.length} 个大模型机器人` : ''} · ${describeSeed(
          resolvedSeed,
        )}。`,
      );
    } catch (error) {
      showNotice('error', `无法开始牌局：${getErrorMessage(error)}`);
    }
  }, [settings, llmSettings, learnedAvailable, learnedEnabled, showNotice]);

  const handleNextHand = useCallback(() => {
    // 闲置状态（首次进入 / 重置后）按当前设置重新开桌，而不是沿用旧配置。
    if (table.phase === 'idle') {
      startGame();
      return;
    }
    if (table.phase !== 'handOver') return;
    try {
      const next = startNextHand(table);
      epochRef.current += 1;
      setTable(next);
      setNotice(null);
    } catch (error) {
      showNotice('error', `无法开始下一手：${getErrorMessage(error)}`);
    }
  }, [table, startGame, showNotice]);

  const handleResetChips = useCallback(() => {
    try {
      // 重置筹码后同样重新解析种子：留空 → 换一副新牌，固定种子 → 可复现。
      const resolvedSeed = resolveSeed(settings.seed);
      const next = startNextHand(resetChips(table, { seed: resolvedSeed.seed }));
      epochRef.current += 1;
      setTable(next);
      setDebugRecords([]);
      setHistoryOpen(false);
      showNotice('info', `筹码已重置，开始新的牌局（${describeSeed(resolvedSeed)}）。`);
    } catch (error) {
      showNotice('error', `无法重置筹码：${getErrorMessage(error)}`);
    }
  }, [table, settings.seed, showNotice]);

  const handleExport = useCallback(() => {
    if (table.history.length === 0) {
      showNotice('info', '还没有可导出的历史牌局，先完整打完一手吧。');
      return;
    }
    try {
      const json = exportHistory(table);
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      anchor.href = url;
      anchor.download = `holdem-history-${stamp}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      showNotice('info', `已导出 ${table.history.length} 手牌局历史。`);
    } catch (error) {
      showNotice('error', `导出失败：${getErrorMessage(error)}`);
    }
  }, [table, showNotice]);

  const openHistory = useCallback(() => setHistoryOpen(true), []);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  const openTutorial = useCallback(() => setTutorialOpen(true), []);
  const closeTutorial = useCallback(() => {
    markTutorialSeen();
    setTutorialOpen(false);
  }, []);
  const handleTutorialStart = useCallback(() => {
    markTutorialSeen();
    setTutorialOpen(false);
    startGame();
  }, [startGame]);

  const openLlmSettings = useCallback(() => setLlmSettingsOpen(true), []);
  const closeLlmSettings = useCallback(() => setLlmSettingsOpen(false), []);
  const handleLlmSettingsChange = useCallback((next: LlmSettings) => {
    setLlmSettings(next);
    saveLlmSettings(next);
  }, []);

  const handleToggleLearned = useCallback(
    (enabled: boolean) => {
      setLearnedEnabled(enabled);
      saveLearnedProfilesEnabled(enabled);
      setLearnedProfilesEnabled(learnedAvailable && enabled);
      showNotice(
        'info',
        enabled
          ? '已启用训练后参数，下一次 AI 决策开始生效。'
          : '已切回内置默认 AI 参数，下一次 AI 决策开始生效。',
      );
    },
    [learnedAvailable, showNotice],
  );

  const llmSeatConfigs = enabledLlmSeatConfigs(llmSettings);
  const lobby: LobbyInfo = {
    playerCount: settings.playerCount,
    difficulty: settings.difficulty,
    llmCount: llmSeatConfigs.length,
    llmNames: llmSeatConfigs.map((seat) => seat.name),
  };

  const potText =
    table.hand && table.phase === 'playing' ? formatChips(table.hand.pot) : '—';

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            ♠
          </span>
          <div>
            <h1 className="brand__title">德州扑克</h1>
            <p className="brand__subtitle">本地人机 · 无限注 · 可选大模型</p>
          </div>
        </div>
        <div className="header-stats">
          <div className="stat">
            <span className="stat__label">手数</span>
            <span className="stat__value">第 {table.handNo} 手</span>
          </div>
          <div className="stat">
            <span className="stat__label">盲注</span>
            <span className="stat__value">
              {table.config.smallBlind}/{table.config.bigBlind}
            </span>
          </div>
          <div className="stat">
            <span className="stat__label">你的筹码</span>
            <span className="stat__value">{formatChips(humanStack)}</span>
          </div>
          <div className="stat">
            <span className="stat__label">底池</span>
            <span className="stat__value stat__value--gold">{potText}</span>
          </div>
        </div>
      </header>

      <SettingsBar
        settings={settings}
        table={table}
        onChange={handleSettingsChange}
        onNewGame={startGame}
        onNextHand={handleNextHand}
        onResetChips={handleResetChips}
        onExport={handleExport}
        onOpenTutorial={openTutorial}
        onOpenLlmSettings={openLlmSettings}
        llmEnabledCount={llmSeatConfigs.length}
        learnedAvailable={learnedAvailable}
        learnedEnabled={learnedEnabled}
        onToggleLearned={handleToggleLearned}
      />

      <main className="app-main">
        <div className="table-column">
          <Table
            table={table}
            lobby={lobby}
            onNextHand={handleNextHand}
            onResetChips={handleResetChips}
            onNewGame={startGame}
            onStartGame={startGame}
            onOpenTutorial={openTutorial}
            onOpenHistory={openHistory}
          />

          {notice && (
            <div
              className={`notice notice--${notice.tone}`}
              role={notice.tone === 'error' ? 'alert' : 'status'}
            >
              <span className="notice__text">{notice.text}</span>
              <button
                type="button"
                className="notice__close"
                onClick={() => setNotice(null)}
                aria-label="关闭提示"
              >
                ×
              </button>
            </div>
          )}

          <Controls
            table={table}
            humanIndex={humanIndex}
            legal={legal}
            onAction={handleHumanAction}
            onNextHand={handleNextHand}
            onNewGame={startGame}
            onResetChips={handleResetChips}
            onStartGame={startGame}
            onOpenTutorial={openTutorial}
          />
        </div>

        <aside className={`sidebar${settings.debugMode ? ' sidebar--with-debug' : ''}`}>
          <LogPanel table={table} />
          {settings.debugMode && <DebugPanel records={debugRecords} />}
        </aside>
      </main>

      <footer className="app-footer">
        <span>纯本地运行 · 大模型仅访问你配置的本地地址</span>
        <span>机器人难度：{DIFFICULTY_LABELS[table.config.difficulty]} · 无限注</span>
      </footer>

      {historyOpen && (
        <HistoryModal history={table.history} seed={table.config.seed} onClose={closeHistory} />
      )}

      {tutorialOpen && (
        <TutorialModal onClose={closeTutorial} onStartGame={handleTutorialStart} />
      )}

      {llmSettingsOpen && (
        <LlmSettingsModal
          settings={llmSettings}
          onChange={handleLlmSettingsChange}
          onClose={closeLlmSettings}
        />
      )}
    </div>
  );
}
