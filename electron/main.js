/**
 * electron/main.js — Electron 主进程（ESM）
 *
 * 职责：
 *   1. 创建 BrowserWindow
 *   2. 以 child_process 启动 agent (tsx src/electron-entry.ts)
 *   3. 通过 stdio JSON 协议与 agent 通信
 *   4. 通过 IPC 在 agent 与渲染进程之间中转消息
 */

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT = resolve(__dirname, '..');
const AGENT_ENTRY = join(ROOT, 'src', 'electron-entry.ts');
const RENDERER_HTML = join(__dirname, 'renderer', 'dist', 'index.html');
const RECENT_DIRS_FILE = join(ROOT, '.seek-agent', 'recent-dirs.json');

let agentProcess = null;
let mainWindow = null;
let pendingMessages = [];
let agentReady = false;

// 当前工作区目录（初始为 ROOT）
let currentWorkDir = ROOT;

// ═════════════════════════════════════════════════════
// 最近目录管理
// ═════════════════════════════════════════════════════

function loadRecentDirs() {
  try {
    if (!existsSync(RECENT_DIRS_FILE)) return [];
    const data = readFileSync(RECENT_DIRS_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function saveRecentDirs(dirs) {
  try {
    const dir = dirname(RECENT_DIRS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(RECENT_DIRS_FILE, JSON.stringify(dirs, null, 2), 'utf8');
  } catch { /* ignore */ }
}

function addRecentDir(dirPath) {
  let dirs = loadRecentDirs();
  // 去重：移除已有同名项
  dirs = dirs.filter(d => d !== dirPath);
  // 插入到最前面
  dirs.unshift(dirPath);
  // 最多保留 10 个
  if (dirs.length > 10) dirs = dirs.slice(0, 10);
  saveRecentDirs(dirs);
}

// ═════════════════════════════════════════════════════
// Agent 进程管理
// ═════════════════════════════════════════════════════

function startAgent() {
  agentProcess = spawn(process.platform === 'win32' ? 'node.exe' : 'node', ['--import', 'tsx/esm', AGENT_ENTRY], {
    cwd: currentWorkDir,
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
    frame: false,
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

  // 最大化状态变化时通知渲染进程
  mainWindow.on('maximize', () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('window:maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('window:maximized', false);
  });
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


// ─── 窗口控制（自定义标题栏）───
ipcMain.on('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window:maximize', () => {
  if (mainWindow) {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  }
});

ipcMain.on('window:close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('window:isMaximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});


// ─── 工作区目录管理 ───

/** 获取当前工作目录 */
ipcMain.handle('workdir:get', () => {
  return currentWorkDir;
});

/** 设置工作目录 */
ipcMain.handle('workdir:set', async (_e, newDir) => {
  try {
    const resolved = resolve(newDir);
    if (!existsSync(resolved)) {
      return { error: '目录不存在' };
    }
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      return { error: '路径不是目录' };
    }
    currentWorkDir = resolved;
    addRecentDir(resolved);

    // 通知 agent 切换工作目录（通过 workdir-global 命令）
    if (agentReady) {
      sendToAgent({ type: 'command', cmd: `workdir-global ${resolved}`, id: 'workdir-change' });
    }

    // 通知渲染进程工作目录已变更
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('workdir:changed', resolved);
    }

    return { success: true, path: resolved };
  } catch (err) {
    return { error: err.message };
  }
});

/** 打开系统对话框选择文件夹 */
ipcMain.handle('workdir:select', async () => {
  if (!mainWindow) return { error: '窗口不可用' };
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择工作区目录',
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }
  return { canceled: false, path: result.filePaths[0] };
});

/** 获取最近目录列表 */
ipcMain.handle('workdir:getRecent', () => {
  return loadRecentDirs();
});


// ─── 渲染进程请求：读取目录文件树 ───
ipcMain.handle('fs:readFileTree', async (_e, dirPath) => {
  const targetDir = dirPath ? resolve(currentWorkDir, dirPath) : currentWorkDir;
  try {
    return buildFileTree(targetDir, '');
  } catch (err) {
    return { error: err.message };
  }
});

function buildFileTree(dir, relativePath) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const children = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env') continue;
    if (entry.name === 'node_modules') continue;
    const fullPath = join(dir, entry.name);
    const relPath = relativePath ? join(relativePath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      const subtree = buildFileTree(fullPath, relPath);
      children.push({ name: entry.name, path: relPath, type: 'folder', children: subtree });
    } else {
      const ext = entry.name.split('.').pop().toLowerCase();
      children.push({ name: entry.name, path: relPath, type: 'file', ext });
    }
  }
  return children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ─── 渲染进程请求：读取 git 变更 ───
ipcMain.handle('fs:readGitStatus', async () => {
  try {
    const output = execSync('git status --porcelain', { cwd: currentWorkDir, encoding: 'utf8', timeout: 5000 });
    const lines = output.trim().split('\n').filter(Boolean);
    return lines.map(line => ({
      status: line.slice(0, 2).trim(),
      file: line.slice(3).trim(),
    }));
  } catch (err) {
    return { error: err.message };
  }
});

// ─── 渲染进程请求：读取 sessions 列表 ───
ipcMain.handle('fs:listSessions', async () => {
  const sessionsDir = join(ROOT, 'sessions');
  try {
    const files = readdirSync(sessionsDir, { withFileTypes: true });
    const sessions = [];
    for (const file of files) {
      if (!file.name.endsWith('.json')) continue;
      const fullPath = join(sessionsDir, file.name);
      try {
        const data = JSON.parse(readFileSync(fullPath, 'utf8'));
        const msgCount = data.agentMessages ? data.agentMessages.length : 0;
        const lastMsg = msgCount > 0 ? data.agentMessages[msgCount - 1] : null;
        const preview = lastMsg && lastMsg.content
          ? lastMsg.content.replace(/<[^>]+>/g, '').slice(0, 80).replace(/\n/g, ' ')
          : '';
        sessions.push({
          name: file.name.replace('.json', ''),
          timestamp: data.timestamp || null,
          messageCount: msgCount,
          preview,
        });
      } catch {
        // 跳过无法解析的 JSON
      }
    }
    sessions.sort((a, b) => {
      if (a.timestamp && b.timestamp) return b.timestamp.localeCompare(a.timestamp);
      return a.name.localeCompare(b.name);
    });
    return sessions;
  } catch (err) {
    return { error: err.message };
  }
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

