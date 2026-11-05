/**
 * 测试用 Node 内置模块的最小类型声明。
 *
 * 本项目刻意不引入 @types/node（见 scripts/train.ts 的做法），但 Vitest 测试
 * 需要读写临时目录；这里只声明测试实际用到的 API，运行期由 Node 提供真实实现。
 */
declare module 'node:fs' {
  export interface Stats {
    size: number;
    mtimeMs: number;
    isFile(): boolean;
    isDirectory(): boolean;
  }
  interface Fs {
    mkdtempSync(prefix: string): string;
    rmSync(target: string, options?: { recursive?: boolean; force?: boolean }): void;
    mkdirSync(target: string, options?: { recursive?: boolean }): void;
    writeFileSync(target: string, data: string, encoding?: string): void;
    readFileSync(target: string, encoding: 'utf8'): string;
    existsSync(target: string): boolean;
    utimesSync(target: string, atime: number, mtime: number): void;
    statSync(target: string): Stats;
  }
  const fs: Fs;
  export default fs;
}

declare module 'node:os' {
  interface Os {
    tmpdir(): string;
  }
  const os: Os;
  export default os;
}

declare module 'node:path' {
  interface Path {
    join(...parts: string[]): string;
    dirname(target: string): string;
    basename(target: string): string;
    resolve(...parts: string[]): string;
  }
  const path: Path;
  export default path;
}
