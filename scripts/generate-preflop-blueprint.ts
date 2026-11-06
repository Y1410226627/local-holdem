/**
 * 离线生成单挑翻前 CFR+ 蓝图。
 * 运行：npx tsx scripts/generate-preflop-blueprint.ts
 * 输出：src/ai/data/preflop-blueprint.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { solvePreflopBlueprint } from '../src/ai/solver/preflop';
import { preflopBucketTable } from '../src/ai/solver/abstraction';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/ai/data/preflop-blueprint.json');
const ITERATIONS = Number(process.env.ITERATIONS ?? 6000);

const started = Date.now();
const blueprint = solvePreflopBlueprint({ iterations: ITERATIONS });
fs.writeFileSync(OUT, JSON.stringify(blueprint, null, 1) + '\n', 'utf8');

console.log(
  `wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB), ` +
    `${blueprint.entries.length} entries, exploitability=${blueprint.exploitability} BB/hand, ` +
    `${((Date.now() - started) / 1000).toFixed(1)}s`,
);

const table = preflopBucketTable();
const root = blueprint.entries.filter((entry) => entry.node === 'sb_root').sort((a, b) => a.bucket - b.bucket);
console.log('\nSB root (bucket: fold / limp / raise2.5 / raise3.5):');
for (const entry of root) {
  const classes = table.classesOfBucket[entry.bucket] ?? [];
  console.log(
    `  ${entry.bucket} [${classes[0]}..${classes[classes.length - 1]}]: ` +
      entry.strategy.map((v) => (v * 100).toFixed(0).padStart(3)).join(' / '),
  );
}

const bbRoot = blueprint.entries.filter((entry) => entry.node === 'bb_vs_open_2.5').sort((a, b) => a.bucket - b.bucket);
console.log('\nBB vs 2.5BB open (bucket: fold / call / 3bet / allin):');
for (const entry of bbRoot) {
  const classes = table.classesOfBucket[entry.bucket] ?? [];
  console.log(
    `  ${entry.bucket} [${classes[0]}..${classes[classes.length - 1]}]: ` +
      entry.strategy.map((v) => (v * 100).toFixed(0).padStart(3)).join(' / '),
  );
}
