/**
 * scripts/dev-electron.mjs — Electron 开发模式启动器
 *
 * 同时启动 Vite 开发服务器（HMR 热更新）和 Electron 主进程。
 * 自动清理残留进程，端口冲突递增查找空闲端口。
 *
 * 用法：node scripts/dev-electron.mjs
 */

import { spawn, execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const RENDERER_DIR = resolve(ROOT, 'electron', 'renderer');

const DEFAULT_PORT = 5173;
const MAX_PORT_ATTEMPTS = 20;

function log(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

// 强制清理占用指定端口的进程（Windows）
function killProcessOnPort(port) {
  try {
    const stdout = execSync(
      `netstat -ano | findstr ":${port} " | findstr LISTENING`,
      { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const lines = stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && pid !== '0') {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore', timeout: 2000 });
          log('cleanup', `已杀死占用端口 ${port} 的进程 (PID ${pid})`);
        } catch { /* 权限不够忽略 */ }
      }
    }
  } catch { /* 没有进程占用 */ }
}

// 检测端口是否可用
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(); resolve(true); });
    server.listen(port, '127.0.0.1');
  });
}

// 找到空闲端口（先清理旧进程）
async function findFreePort(startPort) {
  killProcessOnPort(startPort);
  await new Promise(r => setTimeout(r, 500));

  for (let port = startPort; port < startPort + MAX_PORT_ATTEMPTS; port++) {
    if (await isPortAvailable(port)) return port;
    log('vite', `端口 ${port} 被占用，尝试 ${port + 1}...`);
  }
  throw new Error(`无法找到空闲端口 (${startPort}-${startPort + MAX_PORT_ATTEMPTS - 1})`);
}

// 启动 Vite 开发服务器（合并 stderr 检测，加 --yes 跳过确认）
function startVite(port) {
  return new Promise((resolveVite, reject) => {
    const vite = spawn('npx', ['--yes', 'vite', '--port', String(port)], {
      cwd: RENDERER_DIR, stdio: ['pipe', 'pipe', 'pipe'], shell: true,
    });

    let started = false;
    let output = '';

    function onData(text) {
      output += text;
      process.stdout.write(`  ${text}`);
      if (!started && /Local:\s+http:\/\/localhost:\d+/.test(output)) {
        started = true;
        const match = output.match(/http:\/\/localhost:(\d+)/);
        const actualPort = match ? parseInt(match[1]) : port;
        log('vite', `Vite 就绪 -> http://localhost:${actualPort}`);
        resolveVite({ proc: vite, port: actualPort });
      }
    }

    vite.stdout.on('data', onData);
    vite.stderr.on('data', onData);
    vite.on('error', (err) => reject(err));
    vite.on('exit', (code) => { if (!started) reject(new Error(`Vite 异常退出 (code=${code})`)); });
    setTimeout(() => { if (!started) reject(new Error('Vite 启动超时（60s）')); }, 60000);
  });
}

// 启动 Electron
function startElectron(port) {
  return new Promise((resolveElectron) => {
    log('electron', `启动 Electron（加载 http://localhost:${port}）...`);

    const electron = spawn('npx', ['electron', '.'], {
      cwd: ROOT, stdio: ['inherit', 'inherit', 'pipe'], shell: true,
      env: { ...process.env, VITE_DEV_URL: `http://localhost:${port}`, NODE_ENV: 'development' },
    });

    electron.stderr.on('data', (data) => process.stderr.write(`  ${data}`));
    electron.on('close', (code) => { log('electron', `已退出 (code=${code})`); resolveElectron(); });
  });
}

// 主流程
async function main() {
  console.log('');
  log('dev', '🚀 启动 Electron 开发模式\n');

  let viteProc;

  try {
    const port = await findFreePort(DEFAULT_PORT);
    const { proc, port: actualPort } = await startVite(port);
    viteProc = proc;

    log('dev', '');
    log('dev', '✅ Vite 就绪，启动 Electron...');

    await startElectron(actualPort);
  } catch (err) {
    console.error(`[dev] ❌ 启动失败:`, err.message);
  } finally {
    if (viteProc && !viteProc.killed) viteProc.kill();
    process.exit(0);
  }
}

main();

