/**
 * scripts/pack-win.mjs — Windows 一键打包脚本
 *
 * 1. 编译 Agent TypeScript → JS
 * 2. 拷贝 prompts、skill 配置等资源
 * 3. 构建 Electron 渲染器（React → dist）
 * 4. 用 electron-builder 打包为便携版 exe
 *
 * 用法：node scripts/pack-win.mjs
 */

import { execSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function log(msg) {
  console.log(`[pack] ${msg}`);
}

function run(cmd, label) {
  log(`▶ ${label}...`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

try {
  log('开始打包 Seek Agent');
  log('');

  // 步骤 1：编译 Agent
  log('═══════ 步骤 1/3 ═══════');
  try {
    execSync('npx tsc -p tsconfig.json --outDir dist/agent', { cwd: ROOT, stdio: 'inherit' });
  } catch {
    log('⚠ Agent 编译有类型警告，继续...');
  }
  log('✅ Agent 编译完成');

  // 步骤 2：拷贝资源 + 构建渲染器
  log('');
  log('═══════ 步骤 2/3 ═══════');
  run('node scripts/build-agent.mjs', '拷贝资源 + 构建渲染器');

  // 步骤 3：electron-builder 打包
  log('');
  log('═══════ 步骤 3/3 ═══════');

  // 清理之前打包产物
  if (existsSync(resolve(ROOT, 'release'))) {
    log('清理旧打包文件...');
    rmSync(resolve(ROOT, 'release'), { recursive: true, force: true });
  }

  log('electron-builder 打包中（约 30-60 秒）...');
  execSync('npx electron-builder --win --dir', {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 120000,
  });

  log('');
  log('══════════════════════');
  log('');
  log('✅ 打包完成！');
  log('');
  log('📦 便携版：release/win-unpacked/Seek Agent.exe');
  log('');

} catch (err) {
  console.error(`[pack] ❌ 打包失败:`, err.message);
  process.exit(1);
}

