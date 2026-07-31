/**
 * electron/main.js — Electron 主进程（ESM）
 *
 * 职责：
 *   1. 创建 BrowserWindow
 *   2. 以 child_process 启动多个 agent 进程（每个会话一个独立 Agent 主循环）
 *   3. 通过 stdio JSON 协议与 agent 通信，按 sessionId 路由
 *   4. 通过 IPC 在 agent 与渲染进程之间中转消息
 *
 * 多会话并发：切换会话只切换消息路由，不杀掉其他会话的 Agent 进程，
 * 因此各会话的 Agent 工作循环互不中断。
 *
 * 支持两种运行模式：
 *   - 开发模式：用 tsx 直接运行 src/electron-entry.ts
 *   - 打包模式：运行 dist/release/agent/electron-entry.js（编译后的版本）
 */

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { spawn, exec } from 'child_process';
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
function getAgentEnv(sessionId) {
  const base = isPackaged
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
  return { ...base, AGENT_SESSION_ID: sessionId };
}

/** agent 启动命令（打包模式用 node 直接跑，开发模式用 tsx） */
function getAgentSpawnArgs(sessionId) {
  if (isPackaged) {
    // 打包模式：cwd 设为 exe 所在目录，用户把 .env 放 exe 旁边
    const appDir = dirname(app.getPath('exe'));
    return ['node', [AGENT_ENTRY], { cwd: appDir, stdio: ['pipe', 'pipe', 'pipe'], env: getAgentEnv(sessionId), shell: false, windowsHide: false }];
  } else {
    // 开发模式：用 tsx/esm loader
    return [process.platform === 'win32' ? 'node.exe' : 'node', ['--import', 'tsx/esm', AGENT_ENTRY], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: getAgentEnv(sessionId), shell: false, windowsHide: false }];
  }
}

// ═════════════════════════════════════════════════════

let mainWindow = null;

// ── 多 Agent 进程池 ──
// sessionId -> { proc, ready, pending }
const agentProcs = new Map();
// sessionId -> resolve 队列（等待进程 init-done）
const readyWaiters = new Map();
// 当前活动会话（渲染层正在展示的会话）
let currentSessionId = 'default';

// 当前工作区目录（初始为 ROOT）
// [缓存] sessions 列表签名缓存：文件未变化时避免全量 JSON.parse（sessions 目录可达 20MB+）
let __sessionsSig = '';
let __sessionsCache = [];
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
// Agent 进程池管理
// ═════════════════════════════════════════════════════

/** 唤醒所有等待某会话就绪的调用方 */
function resolveReadyWaiters(sessionId) {
  const waiters = readyWaiters.get(sessionId) || [];
  readyWaiters.delete(sessionId);
  for (const w of waiters) w();
}

/** 等待指定会话进程完成初始化（带超时，避免进程启动失败时无限挂起） */
function waitForReady(sessionId, timeoutMs = 15000) {
  const entry = agentProcs.get(sessionId);
  if (entry && entry.ready) return Promise.resolve();
  return new Promise((resolve) => {
    const list = readyWaiters.get(sessionId) || [];
    list.push(resolve);
    readyWaiters.set(sessionId, list);
    setTimeout(resolve, timeoutMs);
  });
}

/** 拉起一个会话的 Agent 进程（已存在则复用） */
function spawnAgent(sessionId) {
  if (agentProcs.has(sessionId)) return agentProcs.get(sessionId);

  const [cmd, args, options] = getAgentSpawnArgs(sessionId);
  console.log(`[main] Starting agent session=${sessionId}: ${cmd} ${args.join(' ')}`);

  const proc = spawn(cmd, args, options);
  const entry = { proc, ready: false, pending: [] };
  agentProcs.set(sessionId, entry);

  let buffer = '';
  proc.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handleAgentMessage(JSON.parse(line), sessionId);
      } catch { /* ignore parse errors */ }
    }
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString();
    if (text.includes('ExperimentalWarning') || text.includes('--experimental-loader')) return;
    console.error(`[agent:${sessionId}]`, text);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:stderr', text);
    }
  });

  proc.on('exit', (code, signal) => {
    console.log(`[main] Agent ${sessionId} exited with code ${code} signal ${signal}`);
    agentProcs.delete(sessionId);
    resolveReadyWaiters(sessionId);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:status', { connected: false, code, sessionId });
    }
  });

  proc.on('error', (err) => {
    console.error(`[main] Failed to start agent ${sessionId}:`, err.message);
    agentProcs.delete(sessionId);
    resolveReadyWaiters(sessionId);
  });

  return entry;
}

/** 向指定会话的 Agent 进程发送消息（未就绪则入队） */
function sendToAgent(sessionId, msg) {
  const entry = agentProcs.get(sessionId);
  if (!entry || !entry.proc || !entry.proc.stdin.writable) {
    console.warn(`[main] Agent ${sessionId} not available, message dropped:`, msg.type);
    return;
  }
  if (!entry.ready) {
    entry.pending.push(msg);
    return;
  }
  entry.proc.stdin.write(JSON.stringify(msg) + '\n');
}

/** 向当前活动会话发送消息 */
function sendToCurrent(msg) {
  sendToAgent(currentSessionId, msg);
}


function handleAgentMessage(msg, sessionId) {
  if (msg.type === 'init-done') {
    const entry = agentProcs.get(sessionId);
    if (entry) entry.ready = true;
    console.log(`[main] Agent ${sessionId} ready`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:status', { connected: true, sessionId });
    }
    // 唤醒等待者
    resolveReadyWaiters(sessionId);
    // flush pending
    const e = agentProcs.get(sessionId);
    if (e) {
      for (const pending of e.pending) {
        e.proc.stdin.write(JSON.stringify(pending) + '\n');
      }
      e.pending = [];
    }
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 转发时附加 sessionId，渲染层据此区分会话
    mainWindow.webContents.send('agent:message', { ...msg, sessionId });
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

// 开发模式：监听 renderer dist 变化自动刷新（只监听 index.html，避免 assets 构建写入触发反复 reload）
// ═════════════════════════════════════════════════════

// ── 输入 / 命令 / 中断：路由到当前活动会话 ──

ipcMain.on('renderer:input', (_e, { content, id }) => {
  sendToCurrent({ type: 'input', content, id });
});

ipcMain.on('renderer:command', (_e, { cmd, id }) => {
  sendToCurrent({ type: 'command', cmd, id });
});

ipcMain.on('renderer:abort', () => sendToCurrent({ type: 'abort' }));

ipcMain.on('renderer:restart', () => {
  const entry = agentProcs.get(currentSessionId);
  if (entry?.proc) entry.proc.kill();
  agentProcs.delete(currentSessionId);
  spawnAgent(currentSessionId);
});

// ── 会话控制（多会话并发） ──

/**
 * 切换到指定会话。
 * - 会话进程已存在 → 直接切换路由，并让进程重放当前 UI 消息（session:activate）
 * - 进程不存在（首次打开已保存会话）→ 拉起新进程，init 后通过 /loadsession 恢复历史
 * 无论哪种情况，其他会话的 Agent 进程都不受影响，继续运行。
 */
ipcMain.handle('session:switch', async (_e, sessionId, name) => {
  try {
    if (!sessionId) return { error: '缺少 sessionId' };
    const existed = agentProcs.has(sessionId);
    let entry = agentProcs.get(sessionId);
    if (!entry) {
      spawnAgent(sessionId);
      await waitForReady(sessionId);
      if (agentProcs.has(sessionId) && agentProcs.get(sessionId).ready) {
        if (name) {
          sendToAgent(sessionId, { type: 'command', cmd: `/loadsession ${name}`, id: `load-${sessionId}` });
        } else {
          sendToAgent(sessionId, { type: 'command', cmd: 'session:new', id: `new-${sessionId}` });
        }
      } else {
        return { error: 'Agent 进程启动失败或超时', sessionId };
      }
    } else {
      // 已有进程：等就绪后重放显示（不打断其工作循环）
      await waitForReady(sessionId);
      if (agentProcs.get(sessionId)?.ready) {
        sendToAgent(sessionId, { type: 'command', cmd: 'session:activate', id: `activate-${sessionId}` });
      } else {
        return { error: 'Agent 进程不可用', sessionId };
      }
    }
    currentSessionId = sessionId;
    return { success: true, sessionId, name: name || null, created: !existed };
  } catch (err) {
    return { error: err.message };
  }
});

/** 新建会话：拉起全新 Agent 进程并切换过去 */
ipcMain.handle('session:new', async () => {
  const sessionId = `new-${Date.now().toString(36)}`;
  spawnAgent(sessionId);
  await waitForReady(sessionId);
  if (agentProcs.get(sessionId)?.ready) {
    sendToAgent(sessionId, { type: 'command', cmd: 'session:new', id: 'new-session' });
  } else {
    return { error: 'Agent 进程启动失败或超时' };
  }
  currentSessionId = sessionId;
  return { success: true, sessionId };
});

/** 关闭会话：杀掉对应 Agent 进程（不影响其他会话） */
ipcMain.handle('session:close', (_e, sessionId) => {
  const entry = agentProcs.get(sessionId);
  if (entry?.proc) {
    try {
      entry.proc.stdin.write(JSON.stringify({ type: 'exit' }) + '\n');
    } catch { /* ignore */ }
    setTimeout(() => { if (!entry.proc.killed) entry.proc.kill(); }, 800);
  }
  agentProcs.delete(sessionId);
  if (currentSessionId === sessionId) currentSessionId = 'default';
  return { success: true };
});

/** 查询当前活动会话 */
ipcMain.handle('session:current', () => ({ sessionId: currentSessionId }));

/** 查询当前存活的会话进程列表 */
ipcMain.handle('session:list', () => {
  return Array.from(agentProcs.keys()).map((sid) => ({
    sessionId: sid,
    ready: agentProcs.get(sid)?.ready ?? false,
  }));
});

// ── 窗口控制 ──

// 渲染进程查询当前 agent 连接状态（刷新后重连可用）
ipcMain.handle('agent:status:request', () => {
  const entry = agentProcs.get(currentSessionId);
  return { connected: entry?.ready ?? false };
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

// ── 工作区目录管理 ──

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

    sendToCurrent({ type: 'command', cmd: `workdir-global ${resolved}`, id: 'workdir-change' });

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

// ── 渲染进程请求 ──

/**
 * 读取文件树（只读单层，文件夹展开时前端按需加载子层）。
 * 避免对包含 ai-ide/repos 等大目录的工作区做同步递归遍历而阻塞主进程。
 */
ipcMain.handle('fs:readFileTree', async (_e, dirPath) => {
  const targetDir = dirPath ? resolve(currentWorkDir, dirPath) : currentWorkDir;
  try {
    return buildFileTree(targetDir, '', 1);
  } catch (err) {
    return { error: err.message };
  }
});

/** 递归构建文件树；depth 控制深入层数，depth=1 时文件夹不含 children（前端懒加载） */
function buildFileTree(dir, relativePath, depth) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const children = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env') continue;
    if (entry.name === 'node_modules') continue;
    const fullPath = join(dir, entry.name);
    const relPath = relativePath ? join(relativePath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      const node = { name: entry.name, path: relPath, type: 'folder' };
      if (depth > 1) node.children = buildFileTree(fullPath, relPath, depth - 1);
      children.push(node);
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

/** 读取 git 变更状态（异步 exec，避免阻塞主进程） */
ipcMain.handle('fs:readGitStatus', () => {
  return new Promise((resolvePromise) => {
    exec('git status --porcelain', { cwd: currentWorkDir, encoding: 'utf8', timeout: 8000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolvePromise({ error: err.message });
        return;
      }
      const lines = stdout.trim().split('\n').filter(Boolean);
      resolvePromise(lines.map(line => ({
        status: line.slice(0, 2).trim(),
        file: line.slice(3).trim(),
      })));
    });
  });
});

ipcMain.handle('fs:listSessions', async () => {
  const sessionsDir = join(ROOT, 'sessions');
  try {
    const files = readdirSync(sessionsDir, { withFileTypes: true });
    // [缓存] 签名 = 文件名:大小:mtime，无变化直接返回缓存（避免反复全量解析大文件）
    const sig = files
      .filter(f => f.name.endsWith('.json'))
      .map(f => {
        const st = statSync(join(sessionsDir, f.name));
        return `${f.name}:${st.size}:${st.mtimeMs}`;
      })
      .join('|');
    if (sig === __sessionsSig) return __sessionsCache;
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
    __sessionsSig = sig;
    __sessionsCache = sessions;
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

// ── 侧边栏静态数据（Skills / Instructions / Agents / MCP 配置 / Plugins） ──

/** 读取 src 或打包 agent 目录下的 prompts 配置 */
function getAgentSrcRoot() {
  return join(ROOT, isPackaged ? 'agent' : 'src');
}

ipcMain.handle('sidebar:static', async () => {
  const srcRoot = getAgentSrcRoot();
  const skillsDir = join(srcRoot, 'tools', 'inner_skills');
  const promptsDir = join(srcRoot, 'prompts');
  const addonDir = join(promptsDir, 'addon');
  const platformDir = join(promptsDir, 'platform');

  // 1. inner_skills（含启用状态）→ Skills 与 Plugins
  const skills = [];
  try {
    const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      let enabled = false;
      let description = '';
      try {
        const config = JSON.parse(readFileSync(join(skillsDir, dir.name, 'enable.json'), 'utf8'));
        enabled = !!config.enable;
        description = config.description || '';
      } catch { /* 无 enable.json 视为未启用 */ }
      skills.push({ name: dir.name, description, enabled });
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
  } catch { /* ignore */ }

  // 2. prompts 文件 → Instructions
  const readPromptFiles = (dir, kind) => {
    const out = [];
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        out.push({ name: f.replace(/\.md$/, ''), kind, file: f });
      }
    } catch { /* ignore */ }
    return out;
  };
  const instructions = [
    ...readPromptFiles(promptsDir, 'core'),
    ...readPromptFiles(platformDir, 'platform'),
    ...readPromptFiles(addonDir, 'addon'),
  ];

  // 3. addon prompts → 领域 Agents
  const addonAgents = [];
  try {
    for (const f of readdirSync(addonDir)) {
      if (!f.endsWith('.md')) continue;
      addonAgents.push({ name: f.replace(/\.md$/, ''), kind: 'addon', file: f });
    }
  } catch { /* ignore */ }

  // 4. mcp.json 配置 → MCP Servers
  const mcpConfig = [];
  try {
    for (const filename of ['mcp.json', '.mcp.json', 'seek.mcp.json']) {
      const cfgPath = join(ROOT, filename);
      if (!existsSync(cfgPath)) continue;
      const config = JSON.parse(readFileSync(cfgPath, 'utf8'));
      for (const [name, cfg] of Object.entries(config.mcpServers || {})) {
        mcpConfig.push({ name, command: cfg.command || '' });
      }
      break;
    }
  } catch { /* ignore */ }

  return { skills, instructions, addonAgents, mcpConfig };
});

/** 读取 Instruction / Agent 描述文件内容（限制在 prompts 目录内） */
ipcMain.handle('sidebar:instruction', (_e, kind, file) => {
  const srcRoot = getAgentSrcRoot();
  const base = join(srcRoot, 'prompts', kind === 'addon' ? 'addon' : kind === 'platform' ? 'platform' : '');
  try {
    const target = resolve(base, file);
    if (!target.startsWith(resolve(base))) return { error: '路径越界' };
    if (!existsSync(target)) return { error: '文件不存在' };
    const content = readFileSync(target, 'utf8');
    return { content };
  } catch (err) {
    return { error: err.message };
  }
});

// ═════════════════════════════════════════════════════
// 应用生命周期
// ═════════════════════════════════════════════════════


// ═════════════════════════════════════════════════════

app.whenReady().then(() => {
  createWindow();
  // 启动默认会话（与渲染层初始 currentSessionId 保持一致）
  spawnAgent('default');
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const [, entry] of agentProcs) {
    try {
      entry.proc.stdin.write(JSON.stringify({ type: 'exit' }) + '\n');
    } catch { /* ignore */ }
    setTimeout(() => { if (!entry.proc.killed) entry.proc.kill(); }, 1000);
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const [, entry] of agentProcs) {
    try { entry.proc.kill(); } catch { /* ignore */ }
  }
  agentProcs.clear();
});



























