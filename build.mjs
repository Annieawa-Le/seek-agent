#!/usr/bin/env node
/**
 * build.mjs — 一键构建 Seek Agent Windows 桌面应用
 *
 * 用法：
 *   node build.mjs              # 完整打包（便携版）
 *   node build.mjs --skip-pack  # 只编译+拷贝，不打包
 *   node build.mjs --installer  # 打包成 NSIS 安装包
 *
 * 环境变量：
 *   ELECTRON_MIRROR   Electron 镜像（默认 https://npmmirror.com/mirrors/electron/）
 */

import { execSync } from 'child_process';
import { readdirSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(__filename);

// ─── 路径 ───
const RELEASE = join(ROOT, 'dist', 'release', 'agent');
const RENDERER_DIR = join(ROOT, 'electron', 'renderer');
const VITE_BIN = join(RENDERER_DIR, 'node_modules', '.bin', 'vite');
const TSC_BIN = join(ROOT, 'node_modules', '.bin', 'tsc');
const EB_BIN = join(ROOT, 'node_modules', '.bin', 'electron-builder');
const LOG = join(ROOT, 'build.log');

const log = (msg) => {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  try { writeFileSync(LOG, line + '\n', { flag: 'a' }); } catch {}
};

const run = (cmd, opts = {}) => {
  log(`> ${cmd}`);
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
    return { ok: true, out: out || '' };
  } catch (e) {
    return { ok: false, out: e.stdout || '', err: e.stderr || '', code: e.status };
  }
};

// ─── Step 1: Compile Agent (CommonJS — 不依赖 ESM 扩展名) ───
function step1() {
  log('═══ Step 1/4: Compile Agent (CommonJS) ═══');
  if (!existsSync(TSC_BIN)) return { ok: false, err: `tsc not found at ${TSC_BIN}` };

  const r = run(`"${TSC_BIN}" -p tsconfig.build.json --skipLibCheck`, { quiet: true });
  const hasJs = existsSync(join(RELEASE, 'electron-entry.js'));
  if (!hasJs) return { ok: false, err: 'tsc did not generate electron-entry.js' };
  if (!r.ok) log('[warn] tsc reported type errors (JS still generated)');
  log('[ok] Agent compiled');
  return { ok: true };
}

// ─── Step 2: Copy static assets ───
function step2() {
  log('═══ Step 2/4: Copy Assets ═══');

  function copyDir(src, dest, filter) {
    if (!existsSync(src)) return;
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const s = join(src, entry.name);
      const d = join(dest, entry.name);
      if (entry.isDirectory()) copyDir(s, d, filter);
      else if (filter(entry.name)) copyFileSync(s, d);
    }
  }

  copyDir(join(ROOT, 'src', 'prompts'), join(RELEASE, 'prompts'), n => n.endsWith('.md'));
  copyDir(join(ROOT, 'src', 'tools', 'inner_skills'), join(RELEASE, 'tools', 'inner_skills'),
    n => n === 'enable.json' || n.endsWith('.md'));

  log('[ok] Assets copied');
  return { ok: true };
}

// ─── Step 3: Build Renderer ───
function step3() {
  log('═══ Step 3/4: Build Renderer ═══');
  if (!existsSync(VITE_BIN)) return { ok: false, err: `vite not found at ${VITE_BIN}` };
  const r = run(`"${VITE_BIN}" build`, { cwd: RENDERER_DIR, quiet: true });
  if (!r.ok) return { ok: false, err: `vite build failed (code ${r.code})`, log: r.err || r.out };
  log('[ok] Renderer built');
  return { ok: true };
}

// ─── Step 4: Package ───
function step4(installer) {
  log('═══ Step 4/4: Package ═══');
  if (!existsSync(EB_BIN)) return { ok: false, err: `electron-builder not found at ${EB_BIN}` };

  if (!process.env.ELECTRON_MIRROR) {
    process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
  }

  const releaseDir = join(ROOT, 'release');
  if (existsSync(releaseDir)) execSync(`rmdir /s /q "${releaseDir}"`, { stdio: 'pipe' });

  const target = installer ? '--win' : '--win --dir';
  const r = run(`"${EB_BIN}" ${target}`, { quiet: true, timeout: 600000 });

  if (!r.ok && (r.err || '').includes('ETIMEOUT')) {
    log('[warn] Timed out. Retrying with mirror...');
    process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
    const r2 = run(`"${EB_BIN}" ${target}`, { quiet: true, timeout: 600000 });
    if (!r2.ok) return { ok: false, err: 'Packaging failed', log: r2.err || r2.out };
  } else if (!r.ok) {
    return { ok: false, err: `electron-builder failed (code ${r.code})`, log: r.err || r.out };
  }

  log('[ok] Package complete');
  return { ok: true };
}

// ─── Main ───
function main() {
  const args = process.argv.slice(2);
  writeFileSync(LOG, '', 'utf8');

  console.log('\n  ╔══════════════════════════════════╗');
  console.log('  ║   Seek Agent - Windows Build     ║');
  console.log('  ╚══════════════════════════════════╝\n');

  const steps = [
    { name: 'Compile Agent', fn: step1 },
    { name: 'Copy Assets',   fn: step2 },
    { name: 'Build Renderer',fn: step3 },
  ];
  if (!args.includes('--skip-pack')) {
    steps.push({ name: 'Package', fn: () => step4(args.includes('--installer')) });
  }

  for (const step of steps) {
    const result = step.fn();
    if (!result.ok) {
      console.error(`\n  ❌ ${step.name} FAILED`);
      if (result.err) console.error(`     ${result.err}`);
      if (result.log) console.error(`     ${result.log.slice(0, 500)}`);
      console.error(`     See ${LOG}\n`);
      process.exit(1);
    }
  }

  console.log('\n  ╔══════════════════════════════════╗');
  console.log('  ║   ✅ BUILD COMPLETE              ║');
  console.log('  ╚══════════════════════════════════╝\n');
  if (args.includes('--skip-pack')) {
    console.log('  Output: dist/release/agent/');
  } else {
    console.log('  Output: release/win-unpacked/Seek Agent.exe');
  }
  console.log('  Log:    build.log\n');
}

main();

