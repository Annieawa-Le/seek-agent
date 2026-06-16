/**
 * electron/main.js — Electron 主进程（ESM）
 *
 * 职责：
 *   1. 创建 BrowserWindow
 *   2. 以 child_process 启动 agent (tsx src/electron-entry.ts)
 *   3. 通过 stdio JSON 协议与 agent 通信
 *   4. 通过 IPC 在 agent 与渲染进程之间中转消息
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT = resolve(__dirname, '..');
const AGENT_ENTRY = join(ROOT, 'src', 'electron-entry.ts');
const RENDERER_HTML = join(__dirname, 'renderer', 'index.html');

let agentProcess = null;
let mainWindow = null;
let pendingMessages = [];
let agentReady = false;

// ═════════════════════════════════════════════════════
// Agent 进程管理
// ═════════════════════════════════════════════════════

function startAgent() {
  agentProcess = spawn(process.platform === 'win32' ? 'node.exe' : 'node', ['--import', 'tsx/esm', AGENT_ENTRY], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_MODE: '1' },
    shell: false,
    windowsHide: false,
  });

  let buffer = '';
  agentProcess.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handleAgentMessage(JSON.parse(line));
      } catch { /* ignore parse errors */ }
    }
  });

  agentProcess.stderr.on('data', (data) => {
    const text = data.toString();
    if (text.includes('ExperimentalWarning') || text.includes('--experimental-loader')) return;
    console.error('[agent]', text);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:stderr', text);
    }
  });

  agentProcess.on('exit', (code, signal) => {
    console.log(`[main] Agent process exited with code ${code} signal ${signal}`);
    agentProcess = null;
    agentReady = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:status', { connected: false, code });
    }
  });

  agentProcess.on('error', (err) => {
    console.error('[main] Failed to start agent:', err.message);
    agentProcess = null;
  });
}

function sendToAgent(msg) {
  if (!agentProcess || !agentProcess.stdin.writable) {
    console.warn('[main] Agent not available, message dropped:', msg.type);
    return;
  }
  agentProcess.stdin.write(JSON.stringify(msg) + '\n');
}

function handleAgentMessage(msg) {
  if (msg.type === 'init-done') {
    agentReady = true;
    console.log('[main] Agent ready');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:status', { connected: true });
    }
    for (const pending of pendingMessages) {
      sendToAgent(pending);
    }
    pendingMessages = [];
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('agent:message', msg);
  }
}

// ═════════════════════════════════════════════════════
// Electron 窗口管理
// ═════════════════════════════════════════════════════

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 600,
    minHeight: 400,
    title: 'Seek Agent',
    backgroundColor: '#f5f5f5',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  mainWindow.loadFile(RENDERER_HTML);

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ═════════════════════════════════════════════════════
// IPC 处理
// ═════════════════════════════════════════════════════

ipcMain.on('renderer:input', (_e, { content, id }) => {
  const msg = { type: 'input', content, id };
  agentReady ? sendToAgent(msg) : pendingMessages.push(msg);
});

ipcMain.on('renderer:command', (_e, { cmd, id }) => {
  const msg = { type: 'command', cmd, id };
  agentReady ? sendToAgent(msg) : pendingMessages.push(msg);
});

ipcMain.on('renderer:abort', () => sendToAgent({ type: 'abort' }));

ipcMain.on('renderer:restart', () => {
  if (agentProcess) agentProcess.kill();
  agentReady = false;
  pendingMessages = [];
  startAgent();
});

// ═════════════════════════════════════════════════════
// 应用生命周期
// ═════════════════════════════════════════════════════

app.whenReady().then(() => {
  createWindow();
  startAgent();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (agentProcess) {
    sendToAgent({ type: 'exit' });
    setTimeout(() => { if (agentProcess) agentProcess.kill(); }, 1000);
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (agentProcess) { agentProcess.kill(); agentProcess = null; }
});
