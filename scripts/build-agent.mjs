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
import { extname, relative, sep } from 'path';
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
/**
 * 判断某个路径是否位于「技能目录正下方」（即 skillsRoot/<skill>/<name>）。
 * 用于只对顶层开发目录（如各技能自己的 scripts/）做排除，避免误伤更深层的同名目录。
 */
function isSkillRootChild(fullPath, skillsRoot) {
  const rel = relative(skillsRoot, fullPath);
  return rel.split(sep).length === 2;
}

function copyDir(src, dest, filter = () => true) {
  if (!existsSync(src)) return;
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });

  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    // filter 对目录同样生效，否则「整个目录不进包」的规则永远没机会执行
    if (!filter(entry.name, srcPath)) continue;

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, filter);
    } else if (entry.isFile()) {
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

  // 2b. 拷贝 inner_skills 的静态资源
  //
  // 过滤规则要排除「源码 / 开发脚本」，而不是「只收配置」：
  //   ✗ .ts 源码      — tsc 已产出 .js，源码进包只会混淆（也拖大体积）
  //   ✗ .map          — 产物已有各自的 sourcemap
  //   ✗ node_modules  — 依赖由各自的 package.json 管理
  //   ✗ scripts/      — 插件的开发/验收脚本，运行时不用
  // 其余一律保留：.md（提示词/风格库）、.json（配置）、.js/.mjs（前端与宿主）、
  // .html（沙箱页）、.woff2/.ttf（字体）、.css 等——这些是插件的运行时资源。
  const SKIP_EXT = new Set(['.ts', '.tsx', '.map']);
  const SKIP_DIRS = new Set(['node_modules', 'scripts']);
  const skillsSrc = join(srcDir, 'tools', 'inner_skills');
  const skillsDest = join(agentDist, 'tools', 'inner_skills');
  if (existsSync(skillsSrc)) {
    copyDir(skillsSrc, skillsDest, (name, fullPath) => {
      if (name === '.git' || name === '.gitignore') return false;
      if (SKIP_EXT.has(extname(name))) return false;
      // 顶层（技能目录正下方）的开发目录不进包；各技能内部的 styles/assets 保留
      if (SKIP_DIRS.has(name) && isSkillRootChild(fullPath, skillsSrc)) return false;
      return true;
    });
    log(`  ✅ inner_skills 静态资源已拷贝`);
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

