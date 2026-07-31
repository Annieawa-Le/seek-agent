#!/usr/bin/env node
/**
 * dev.mjs — 开发模式启动器
 *
 * 1. vite build（首次构建）
 * 2. vite build --watch（保存文件自动重构建）
 * 3. Electron（加载本地 dist/，自动刷新）
 *
 * 用法：node dev.mjs
 */

import { spawn, execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(__filename);
const RENDERER_DIR = join(ROOT, 'electron', 'renderer');
const VITE_BIN = join(RENDERER_DIR, 'node_modules', '.bin', 'vite');

const log = (tag, msg) => console.log(`[${tag}] ${msg}`);

async function main() {
  console.log('');
  log('dev', '═══ Seek Agent 开发模式 ═══\n');

  try {
    execSync(`"${VITE_BIN}" build`, { cwd: RENDERER_DIR, stdio: 'inherit' });
  } catch {
    log('dev', '❌ 构建失败');
    process.exit(1);
  }

  const viteWatch = spawn(VITE_BIN, ['build', '--watch'], {
    cwd: RENDERER_DIR, stdio: ['pipe', 'inherit', 'pipe'], shell: true,
  });
  viteWatch.stderr.on('data', d => process.stdout.write(`  ${d}`));
  log('vite', '监听中（修改文件自动构建 → Electron 自动刷新）\n');

  const electron = spawn('npx', ['electron', '.'], {
    cwd: ROOT, stdio: 'inherit', shell: true,
  });

  const cleanup = () => {
    if (viteWatch && !viteWatch.killed) viteWatch.kill();
    if (electron && !electron.killed) electron.kill();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main();

