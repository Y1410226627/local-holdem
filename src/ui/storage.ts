/**
 * UI 层 localStorage 封装：教程标记、训练参数开关等。
 *
 * 所有读写都做异常兜底：隐私模式 / 配额不足 / 禁用 localStorage 时
 * 只影响持久化，不影响牌局本身。
 */

export const TUTORIAL_SEEN_KEY = 'holdem-tutorial-seen-v1';
export const LLM_SETTINGS_KEY = 'holdem-llm-settings-v1';
export const LEARNED_ENABLED_KEY = 'holdem-learned-profiles-v1';

function storageAvailable(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

export function readStorage(key: string): string | null {
  if (!storageAvailable()) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  if (!storageAvailable()) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // 忽略写入失败（隐私模式 / 配额不足）。
  }
}

export function readJsonStorage(key: string): unknown {
  const raw = readStorage(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function writeJsonStorage(key: string, value: unknown): void {
  try {
    writeStorage(key, JSON.stringify(value));
  } catch {
    // 不可序列化时忽略。
  }
}

/** 是否已经看过新手教程（首次访问自动弹出）。 */
export function hasSeenTutorial(): boolean {
  return readStorage(TUTORIAL_SEEN_KEY) === '1';
}

export function markTutorialSeen(): void {
  writeStorage(TUTORIAL_SEEN_KEY, '1');
}

/** 「使用训练后参数」开关；默认开启。 */
export function loadLearnedProfilesEnabled(): boolean {
  return readStorage(LEARNED_ENABLED_KEY) !== '0';
}

export function saveLearnedProfilesEnabled(enabled: boolean): void {
  writeStorage(LEARNED_ENABLED_KEY, enabled ? '1' : '0');
}
