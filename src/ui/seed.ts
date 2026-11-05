/**
 * 随机种子工具。
 *
 * 设置栏的种子输入框默认留空：每次「新局 / 开始对局 / 重置筹码」都会生成新的随机种子，
 * 因此不会每次发到同一副牌；如果填写固定种子，则相同种子 + 相同动作序列可复现牌局。
 */

/** 种子输入框的占位提示（留空即每局随机）。 */
export const RANDOM_SEED_PLACEHOLDER = '留空 = 每局随机';

/** 解析结果：实际使用的种子 + 是否为本次随机生成。 */
export interface ResolvedSeed {
  /** 真正传给牌桌的种子（界面上会显示，便于复现）。 */
  seed: string;
  /** true 表示输入框留空、由本次自动生成。 */
  isRandom: boolean;
}

function randomHex(bytes: number): string | null {
  try {
    const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') return null;
    const buffer = new Uint8Array(bytes);
    cryptoApi.getRandomValues(buffer);
    return Array.from(buffer, (value) => value.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** 生成一个新的随机种子（形如 12 位十六进制 + 时间戳），保证每次开局不重复。 */
export function generateRandomSeed(): string {
  const random = randomHex(8) ?? Math.random().toString(36).slice(2, 12);
  const time = Date.now().toString(36);
  return `${random}-${time}`;
}

/**
 * 把设置栏的种子输入解析成真正使用的种子：
 * - 填写了内容 → 原样使用（固定种子模式，可复现同一副牌）；
 * - 留空 / 只有空白 → 生成新的随机种子（默认模式，每局牌都不同）。
 */
export function resolveSeed(input: string | null | undefined): ResolvedSeed {
  const trimmed = (input ?? '').trim();
  return trimmed ? { seed: trimmed, isRandom: false } : { seed: generateRandomSeed(), isRandom: true };
}

/** 在提示文案里展示种子来源，例如「随机种子 ab12-xyz」或「种子 demo-b」。 */
export function describeSeed(resolved: ResolvedSeed): string {
  return `${resolved.isRandom ? '随机种子' : '种子'} ${resolved.seed}`;
}
