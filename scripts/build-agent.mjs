/**
 * scripts/build-agent.mjs — Agent 构建脚本
 *
 * 职责：
 *   1. 用 tsc 编译 src/ 下的 TypeScript 到 dist/
 *   2. 拷贝非 TS 资源文件（prompts/*.md, inner_skills 的配置文件等）
 *   3. 构建 Electron 渲染器（Vite build）
 *   4. 将所有构建产物整理到 release/ 目录下
 *
 * 用法：node scripts/build-agent.mjs
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function log(msg) {
  console.log(`[build] ${msg}`);
}

// ═══════════════════════════════════════════════════
// 递归拷贝目录（仅拷贝符合 filter 的文件）
// ═══════════════════════════════════════════════════
function copyDir(src, dest, filter = () => true) {
  if (!existsSync(src)) return;
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });

  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, filter);
    } else if (entry.isFile() && filter(entry.name, srcPath)) {
      copyFileSync(srcPath, destPath);
    }
  }
}

// ═══════════════════════════════════════════════════
// 步骤 1: 编译 Agent TypeScript
// ═══════════════════════════════════════════════════
function compileAgent() {
  log('=== 步骤 1/4: 编译 Agent TypeScript ===');
  try {
    execSync('npx tsc -p tsconfig.json --outDir dist/agent', { cwd: ROOT, stdio: 'inherit' });
  } catch {
    log('⚠ tsc 类型检查有警告（不影响 JS 输出），继续后续步骤...');
  }
}

// ═══════════════════════════════════════════════════
// 步骤 2: 拷贝资源文件
// ═══════════════════════════════════════════════════
function copyAssets() {
  log('=== 步骤 2/4: 拷贝资源文件 ===');

  const agentDist = join(ROOT, 'dist', 'agent');
  const srcDir = join(ROOT, 'src');

  // 2a. 拷贝 prompts/ 目录（所有 .md 文件）
  const promptsSrc = join(srcDir, 'prompts');
  const promptsDest = join(agentDist, 'prompts');
  if (existsSync(promptsSrc)) {
    copyDir(promptsSrc, promptsDest, (name) => name.endsWith('.md'));
    log(`  ✅ prompts/ 已拷贝`);
  }

  // 2b. 拷贝 inner_skills 的静态配置文件
  const skillsSrc = join(srcDir, 'tools', 'inner_skills');
  const skillsDest = join(agentDist, 'tools', 'inner_skills');
  if (existsSync(skillsSrc)) {
    copyDir(skillsSrc, skillsDest, (name) => {
      return name === 'enable.json' || name.endsWith('.md');
    });
    log(`  ✅ inner_skills 配置已拷贝`);
  }

  // 2c. 拷贝 assets/ 目录（非 TS 文件）
  const assetsSrc = join(srcDir, 'assets');
  const assetsDest = join(agentDist, 'assets');
  if (existsSync(assetsSrc)) {
    copyDir(assetsSrc, assetsDest, (name) => !name.endsWith('.ts'));
    log(`  ✅ assets/ 已拷贝`);
  }
}

// ═══════════════════════════════════════════════════
// 步骤 3: 构建 Electron 渲染器
// ═══════════════════════════════════════════════════
function buildRenderer() {
  log('=== 步骤 3/4: 构建 Electron 渲染器 ===');
  execSync('npx vite build', { cwd: join(ROOT, 'electron', 'renderer'), stdio: 'inherit' });
}

// ═══════════════════════════════════════════════════
// 步骤 4: 生成发布目录
// ═══════════════════════════════════════════════════
function prepareRelease() {
  log('=== 步骤 4/4: 整理发布目录 ===');

  const releaseDir = join(ROOT, 'dist', 'release');

  // agent/  → 编译后的 agent 代码 (来自 dist/agent/)
  const agentTarget = join(releaseDir, 'agent');
  if (!existsSync(agentTarget)) mkdirSync(agentTarget, { recursive: true });

  copyDir(join(ROOT, 'dist', 'agent'), agentTarget);
  log(`  ✅ agent 代码 → release/agent/`);

  log('\n🎉 构建完成！');
  log(`  ${releaseDir}/`);
  log(`    agent/     — 编译后的 AI Agent`);
}

// ═══════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════
function main() {
  log('开始构建 Seek Agent...\n');
  compileAgent();
  copyAssets();
  buildRenderer();
  prepareRelease();
  log('\n✅ 构建完成！');
}

main();

