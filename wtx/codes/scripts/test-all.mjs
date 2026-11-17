/**
 * scripts/test-all.mjs
 * 测试入口：在同一进程内依次加载全部 *.test.mjs。
 *
 * 为什么不直接用 `node --test`：某些受限环境（如 CI 沙箱）不允许
 * test runner 为每个文件派生子进程（spawn EPERM）。此脚本用 import
 * 复用同一进程，行为一致且可移植。
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const testsDir = path.resolve(here, '..', 'tests');

const files = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

if (files.length === 0) {
  console.error('未找到测试文件');
  process.exit(1);
}

console.log(`加载 ${files.length} 个测试文件：${files.join(', ')}\n`);
for (const f of files) {
  await import(pathToFileURL(path.join(testsDir, f)).href);
}
