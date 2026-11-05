/**
 * 一键同步数据脚本（scripts/sync-data.mjs）的单元测试：
 * 项目识别、旧版本目录扫描、候选选择、复制 + 覆盖前备份、dry-run、参数解析。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BACKUP_DIR,
  SYNC_FILES,
  collectDataFiles,
  copySyncData,
  findSyncCandidates,
  formatBytes,
  isProjectRoot,
  parseArgs,
  pickBestCandidate,
} from '../../scripts/sync-data.mjs';

let tmpRoot: string;

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function makeInstall(dir: string, name = 'local-holdem'): string {
  fs.mkdirSync(dir, { recursive: true });
  writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.3.0' }));
  return dir;
}

function makeData(installDir: string, relPath: string, content: string): string {
  const file = path.join(installDir, relPath);
  writeFile(file, content);
  return file;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-sync-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('isProjectRoot / collectDataFiles', () => {
  it('按 package.json 的 name 识别项目根目录', () => {
    const good = makeInstall(path.join(tmpRoot, 'good'));
    const wrong = makeInstall(path.join(tmpRoot, 'wrong'), 'other-project');
    expect(isProjectRoot(good)).toBe(true);
    expect(isProjectRoot(wrong)).toBe(false);
    expect(isProjectRoot(path.join(tmpRoot, 'missing'))).toBe(false);
  });

  it('只收集实际存在的数据文件', () => {
    const install = makeInstall(path.join(tmpRoot, 'app'));
    makeData(install, 'src/ai/data/learnedProfiles.json', '{"profiles":{}}');
    makeData(install, 'training/REPORT.md', '# report');
    const files = collectDataFiles(install);
    const paths = files.map((file) => file.relPath);
    expect(paths).toContain('src/ai/data/learnedProfiles.json');
    expect(paths).toContain('training/REPORT.md');
    expect(paths).not.toContain('training/llm-sft-dataset.jsonl');
    for (const file of files) {
      expect(file.size).toBeGreaterThan(0);
      expect(file.mtimeMs).toBeGreaterThan(0);
    }
  });
});

describe('findSyncCandidates / pickBestCandidate', () => {
  it('扫描同级目录找出旧版本，排除当前目录与普通目录，并按数据时间排序', () => {
    const current = makeInstall(path.join(tmpRoot, 'current'));
    const older = makeInstall(path.join(tmpRoot, 'older'));
    const newer = makeInstall(path.join(tmpRoot, 'newer'));
    makeInstall(path.join(tmpRoot, 'not-a-project'), 'unrelated');
    makeData(older, 'src/ai/data/learnedProfiles.json', '{"v":1}');
    makeData(newer, 'src/ai/data/learnedProfiles.json', '{"v":2}');
    const olderFile = path.join(older, 'src/ai/data/learnedProfiles.json');
    const newerFile = path.join(newer, 'src/ai/data/learnedProfiles.json');
    const now = Date.now() / 1000;
    fs.utimesSync(olderFile, now - 100, now - 100);
    fs.utimesSync(newerFile, now - 10, now - 10);

    const candidates = findSyncCandidates(tmpRoot, { excludeDir: current });
    const dirs = candidates.map((candidate) => path.basename(candidate.dir));
    expect(dirs).toEqual(['newer', 'older']);
    expect(pickBestCandidate(candidates)?.dir).toBe(newer);
  });

  it('能发现下载 zip 常见的「外层目录 / 内层项目」结构', () => {
    const current = makeInstall(path.join(tmpRoot, 'current'));
    const nested = makeInstall(path.join(tmpRoot, 'local-holdem-main', 'local-holdem'));
    makeData(nested, 'src/ai/data/learnedProfiles.json', '{}');
    const candidates = findSyncCandidates(tmpRoot, { excludeDir: current });
    expect(candidates.map((candidate) => candidate.dir)).toContain(nested);
  });

  it('没有候选时 pickBestCandidate 返回 null', () => {
    expect(pickBestCandidate([])).toBeNull();
  });
});

describe('copySyncData', () => {
  function setupPair() {
    const from = makeInstall(path.join(tmpRoot, 'old-version'));
    const to = makeInstall(path.join(tmpRoot, 'new-version'));
    makeData(from, 'src/ai/data/learnedProfiles.json', '{"from":"old","trained":true}');
    makeData(from, 'training/REPORT.md', '# old report');
    makeData(to, 'src/ai/data/learnedProfiles.json', '{"from":"new"}');
    makeData(from, 'src/ai/data/llm-experience.json', '{"same":true}');
    makeData(to, 'src/ai/data/llm-experience.json', '{"same":true}');
    return { from, to };
  }

  it('复制缺失/不同文件，内容相同的跳过，覆盖前备份，缺失的记为 missing', () => {
    const { from, to } = setupPair();
    const result = copySyncData({
      fromDir: from,
      toDir: to,
      now: new Date(2026, 0, 2, 3, 4, 5),
    });

    expect(result.copied).toEqual(
      expect.arrayContaining(['src/ai/data/learnedProfiles.json', 'training/REPORT.md']),
    );
    expect(result.identical).toEqual(['src/ai/data/llm-experience.json']);
    expect(result.missing).toEqual(['training/llm-sft-dataset.jsonl']);
    expect(result.backedUp).toEqual(['src/ai/data/learnedProfiles.json']);
    expect(result.backupDir).toBe(path.join(to, BACKUP_DIR, 'sync-20260102-030405'));

    // 新文件已覆盖
    expect(fs.readFileSync(path.join(to, 'src/ai/data/learnedProfiles.json'), 'utf8')).toContain('trained');
    expect(fs.readFileSync(path.join(to, 'training/REPORT.md'), 'utf8')).toBe('# old report');
    // 覆盖前内容已备份
    const backupFile = path.join(result.backupDir, 'src/ai/data/learnedProfiles.json');
    expect(fs.readFileSync(backupFile, 'utf8')).toBe('{"from":"new"}');
    // 内容相同的不备份、不复制
    expect(fs.existsSync(path.join(result.backupDir, 'src/ai/data/llm-experience.json'))).toBe(false);
  });

  it('dry-run 只计算，不写目标与备份文件', () => {
    const { from, to } = setupPair();
    const before = fs.readFileSync(path.join(to, 'src/ai/data/learnedProfiles.json'), 'utf8');
    const result = copySyncData({ fromDir: from, toDir: to, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.copied.length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(to, 'src/ai/data/learnedProfiles.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(result.backupDir)).toBe(false);
  });

  it('源目录与目标目录相同或源目录不是项目时抛错', () => {
    const { from, to } = setupPair();
    expect(() => copySyncData({ fromDir: from, toDir: from })).toThrow();
    const plain = path.join(tmpRoot, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    expect(() => copySyncData({ fromDir: plain, toDir: to })).toThrow();
  });
});

describe('parseArgs / formatBytes', () => {
  it('解析 --from / --scan-dir / --dry-run / --yes / --agent / --list / --help', () => {
    expect(parseArgs(['--from=../old', '--dry-run', '--list'])).toMatchObject({
      from: '../old',
      dryRun: true,
      list: true,
      yes: false,
      agent: false,
    });
    expect(parseArgs(['--from', '..\\old', '--scan-dir', 'D:\\Downloads'])).toMatchObject({
      from: '..\\old',
      scanDir: 'D:\\Downloads',
    });
    const agent = parseArgs(['--agent']);
    expect(agent.agent).toBe(true);
    expect(agent.yes).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('文件大小格式化可读', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.00 MB');
  });

  it('同步文件清单覆盖训练参数、经验库与训练产物', () => {
    expect(SYNC_FILES).toContain('src/ai/data/learnedProfiles.json');
    expect(SYNC_FILES).toContain('src/ai/data/llm-experience.json');
    expect(SYNC_FILES).toContain('training/REPORT.md');
    expect(SYNC_FILES).toContain('training/llm-sft-dataset.jsonl');
  });
});
