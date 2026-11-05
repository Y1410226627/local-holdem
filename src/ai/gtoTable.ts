/**
 * GTO 查表（方案 B1）：加载离线生成的 push/fold 策略表，按有效筹码深度线性插值。
 * 表由 `npm run gto:tables` 生成，运行时零求解成本。
 */
import raw from './data/gto-pushfold.json';

export interface GtoPushFoldEntry {
  stackBB: number;
  sbPushFrequency: number[];
  bbCallFrequency: number[];
  exploitability: number;
}

export interface GtoPushFoldTable {
  generatedAt: string;
  description: string;
  buckets: number;
  stackMinBB: number;
  stackMaxBB: number;
  iterations: number;
  boundaries: number[];
  entries: GtoPushFoldEntry[];
}

export interface GtoPushFoldChart {
  stackBB: number;
  buckets: number;
  boundaries: number[];
  sbPushFrequency: number[];
  bbCallFrequency: number[];
  exploitability: number;
  /** exact = 表内精确深度；interpolated = 两档深度线性插值。 */
  source: 'exact' | 'interpolated';
}

export const GTO_PUSH_FOLD_TABLE = raw as GtoPushFoldTable;

function blend(a: readonly number[], b: readonly number[], ratio: number): number[] {
  return a.map((value, index) => value + ((b[index] ?? value) - value) * ratio);
}

/**
 * 查表：有效筹码深度（BB）→ push/fold 均衡频率。
 * 超出表范围（4–20BB）返回 null，由调用方回退到在线求解或启发式。
 */
export function lookupPushFoldChart(stackBB: number): GtoPushFoldChart | null {
  const table = GTO_PUSH_FOLD_TABLE;
  if (!Number.isFinite(stackBB)) return null;
  if (stackBB < table.stackMinBB || stackBB > table.stackMaxBB) return null;
  const entries = table.entries;
  if (entries.length === 0) return null;
  for (const entry of entries) {
    if (Math.abs(entry.stackBB - stackBB) < 1e-9) {
      return {
        stackBB,
        buckets: table.buckets,
        boundaries: table.boundaries,
        sbPushFrequency: entry.sbPushFrequency,
        bbCallFrequency: entry.bbCallFrequency,
        exploitability: entry.exploitability,
        source: 'exact',
      };
    }
  }
  for (let index = 1; index < entries.length; index++) {
    const next = entries[index];
    if (next.stackBB < stackBB) continue;
    const previous = entries[index - 1];
    if (!previous) return null;
    const ratio = (stackBB - previous.stackBB) / (next.stackBB - previous.stackBB);
    return {
      stackBB,
      buckets: table.buckets,
      boundaries: table.boundaries,
      sbPushFrequency: blend(previous.sbPushFrequency, next.sbPushFrequency, ratio),
      bbCallFrequency: blend(previous.bbCallFrequency, next.bbCallFrequency, ratio),
      exploitability: Math.max(previous.exploitability, next.exploitability),
      source: 'interpolated',
    };
  }
  return null;
}
