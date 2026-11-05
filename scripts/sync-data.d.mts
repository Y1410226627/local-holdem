/** 给 TypeScript 测试用的类型声明（脚本本身是纯 ESM .mjs，可直接被 Node 运行）。 */
export interface SyncDataFile {
  relPath: string;
  absPath: string;
  size: number;
  mtimeMs: number;
}

export interface SyncCandidate {
  dir: string;
  files: SyncDataFile[];
  latestMtimeMs: number;
  totalBytes: number;
}

export interface CopySyncDataResult {
  fromDir: string;
  toDir: string;
  backupDir: string;
  dryRun: boolean;
  copied: string[];
  backedUp: string[];
  identical: string[];
  missing: string[];
}

export interface ParsedSyncArgs {
  from: string | null;
  scanDir: string | null;
  dryRun: boolean;
  list: boolean;
  yes: boolean;
  agent: boolean;
  help: boolean;
}

export const PROJECT_NAME: string;
export const BACKUP_DIR: string;
export const SYNC_FILES: string[];

export function isProjectRoot(dir: string): boolean;
export function collectDataFiles(projectRoot: string): SyncDataFile[];
export function findSyncCandidates(
  searchRoot: string,
  options?: { excludeDir?: string; maxDepth?: number; maxEntries?: number },
): SyncCandidate[];
export function pickBestCandidate(candidates: SyncCandidate[]): SyncCandidate | null;
export function copySyncData(options: {
  fromDir: string;
  toDir: string;
  dryRun?: boolean;
  now?: Date;
  backupDirName?: string | null;
}): CopySyncDataResult;
export function parseArgs(argv: string[]): ParsedSyncArgs;
export function formatBytes(bytes: number): string;
export function main(argv?: string[]): Promise<number>;
