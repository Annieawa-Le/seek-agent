/**
 * electron/main.js — Electron 主进程（ESM）
 *
 * 职责：
 *   1. 创建 BrowserWindow
 *   2. 以 child_process 启动 agent
 *   3. 通过 stdio JSON 协议与 agent 通信
 *   4. 通过 IPC 在 agent 与渲染进程之间中转消息
 *
 * 支持两种运行模式：
 *   - 开发模式：用 tsx 直接运行 src/electron-entry.ts
 *   - 打包模式：运行 dist/release/agent/electron-entry.js（编译后的版本）
 */

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { watch } from 'fs';
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ═════════════════════════════════════════════════════
// 路径解析（区分打包/开发模式）
// ═════════════════════════════════════════════════════
const isPackaged = app.isPackaged;
const isDev = !isPackaged || process.env.NODE_ENV === 'development';

// 热重载调试模式：从 Vite dev server 加载 UI
const VITE_DEV_URL = process.env.VITE_DEV_URL || '';
/** 项目根目录（打包后 electron 在 resources/app, agent 在 resources/agent） */
const ROOT = isPackaged
  ? resolve(__dirname, '..', '..')
  : resolve(__dirname, '..');

/** Agent 入口路径（打包模式 vs 开发模式） */
const AGENT_ENTRY = isPackaged
  ? join(ROOT, 'agent', 'electron-entry.js')
  : join(ROOT, 'src', 'electron-entry.ts');

/** 渲染器 HTML 路径 */
const RENDERER_HTML = VITE_DEV_URL
  ? VITE_DEV_URL
  : join(__dirname, 'renderer', 'dist', 'index.html');
/** 最近目录文件（打包模式下存在用户数据目录中） */
const RECENT_DIRS_FILE = isPackaged
  ? join(app.getPath('userData'), 'recent-dirs.json')
  : join(ROOT, '.seek-agent', 'recent-dirs.json');

/** agent 启动时额外环境变量 */
const AGENT_ENV = isPackaged
  ? {
      ...process.env,
      ELECTRON_MODE: '1',
      AGENT_ROOT: join(ROOT, 'agent'),
      NODE_ENV: 'production',
    }
  : {
      ...process.env,
      ELECTRON_MODE: '1',
    };

/** agent 启动命令（打包模式用 node 直接跑，开发模式用 tsx） */
function getAgentSpawnArgs() {
  if (isPackaged) {
    // 打包模式：cwd 设为 exe 所在目录，用户把 .env 放 exe 旁边
    const appDir = dirname(app.getPath('exe'));
    return ['node', [AGENT_ENTRY], { cwd: appDir, stdio: ['pipe', 'pipe', 'pipe'], env: AGENT_ENV, shell: false, windowsHide: false }];
  } else {
    // 开发模式：用 tsx/esm loader
    return [process.platform === 'win32' ? 'node.exe' : 'node', ['--import', 'tsx/esm', AGENT_ENTRY], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: AGENT_ENV, shell: false, windowsHide: false }];
  }
}

// ═════════════════════════════════════════════════════

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
  dirs = dirs.filter(d => d !== dirPath);
  dirs.unshift(dirPath);
  if (dirs.length > 10) dirs = dirs.slice(0, 10);
  saveRecentDirs(dirs);
}

// ═════════════════════════════════════════════════════
// Agent 进程管理
// ═════════════════════════════════════════════════════

function startAgent() {
  const [cmd, args, options] = getAgentSpawnArgs();
  console.log(`[main] Starting agent: ${cmd} ${args.join(' ')}`);

  agentProcess = spawn(cmd, args, options);

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
  const isDev = !!VITE_DEV_URL;

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
      // 开发模式下允许加载 HTTP 资源
      webSecurity: !isDev,
    },
  });

  if (VITE_DEV_URL) {
    mainWindow.loadURL(RENDERER_HTML);
  } else {
    mainWindow.loadFile(RENDERER_HTML);
  }

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  // ── [debug] 转发渲染进程 console 消息到主进程 stdout ──
  mainWindow.webContents.on('console-message', (event) => {
    console.log(`[renderer:${event.level}] ${event.message}`);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('maximize', () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('window:maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('window:maximized', false);
  });
}

// ═════════════════════════════════════════════════════

// 开发模式：监听 renderer dist 变化自动刷新
if (!isPackaged) {
  const rendererDist = join(__dirname, 'renderer', 'dist');
  if (existsSync(rendererDist)) {
    let reloadTimer;
    watch(rendererDist, { recursive: true }, (event, file) => {
      if (!file || file.endsWith('.map')) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reload();
          console.log('[dev] Auto-reloaded after', file);
        }
      }, 300);
    });
    console.log('[dev] Watching renderer dist for auto-reload...');
  }
}

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

// ─── 窗口控制 ───

// 渲染进程查询当前 agent 连接状态（刷新后重连可用）
ipcMain.handle('agent:status:request', () => {
  return { connected: agentReady };
});
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

ipcMain.handle('workdir:get', () => {
  return currentWorkDir;
});

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

    if (agentReady) {
      sendToAgent({ type: 'command', cmd: `workdir-global ${resolved}`, id: 'workdir-change' });
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('workdir:changed', resolved);
    }

    return { success: true, path: resolved };
  } catch (err) {
    return { error: err.message };
  }
});

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

ipcMain.handle('dialog:openFiles', async () => {
  if (!mainWindow) return { error: '窗口不可用' };
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: '选择附件文件',
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, files: [] };
  }
  return { canceled: false, files: result.filePaths };
});

ipcMain.handle('workdir:getRecent', () => {
  return loadRecentDirs();
});

// ─── 渲染进程请求 ───

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
      } catch { /* skip */ }
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

ipcMain.handle('skills:list', async () => {
  const skillsDir = join(ROOT, isPackaged ? 'agent' : 'src', 'tools', 'inner_skills');
  try {
    const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    const skills = [];
    for (const dir of dirs) {
      const enablePath = join(skillsDir, dir.name, 'enable.json');
      try {
        const raw = readFileSync(enablePath, 'utf8');
        const config = JSON.parse(raw);
        if (config.enable) {
          skills.push({ name: dir.name, description: config.description || '' });
        }
      } catch { /* skip */ }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
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


























