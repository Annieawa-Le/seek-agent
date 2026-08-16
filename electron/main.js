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
import { startRemoteBridge } from './remote-bridge.js';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ═════════════════════════════════════════════════════
// 环境变量：显式加载 seek-agent 根目录 .env（electron/ 的上一级），
// 让 SEEK_RELAY_URL / SEEK_DEVICE_ID / SEEK_RELAY_TOKEN 等配置在主进程启动时生效。
// （agent 子进程在 src/electron-entry.ts 另行加载 dotenv，此处负责主进程侧。）
// ═════════════════════════════════════════════════════
dotenv.config({ path: resolve(__dirname, '..', '.env') });

/** RPC 函数表：channel → handler（IPC 与 RemoteBridge RPC 共用） */
const rpcFns = new Map();
function registerRpc(channel, handler) {
  rpcFns.set(channel, handler);
  ipcMain.handle(channel, async (event, ...args) => handler(...args));
}

/** RemoteBridge RPC method（preload 方法名）→ main.js channel */
const METHOD_TO_CHANNEL = {
  getAgentStatus: 'agent:status:request',
  getWorkdir: 'workdir:get',
  setWorkdir: 'workdir:set',
  setWorkspaceRoots: 'workdir:setRoots',
  addWorkspaceRoot: 'workdir:addRoot',
  removeWorkspaceRoot: 'workdir:removeRoot',
  getRecentDirs: 'workdir:getRecent',
  readFileTree: 'fs:readFileTree',
  readGitStatus: 'fs:readGitStatus',
  listSessions: 'fs:listSessions',
  getCollabLog: 'collab:log',
  switchSession: 'session:switch',
  newSession: 'session:new',
  closeSession: 'session:close',
  getCurrentSession: 'session:current',
  listActiveSessions: 'session:list',
  getSidebarStatic: 'sidebar:static',
  readInstruction: 'sidebar:instruction',
  getSkillsList: 'skills:list',
  getEnvConfig: 'env:read',
  saveEnvConfig: 'env:write',
};

/** RemoteBridge RPC 查询分发：method → channel → rpcFns handler */
async function remoteInvokeHandler(method, params) {
  const channel = METHOD_TO_CHANNEL[method];
  if (!channel) throw new Error(`unknown rpc method: ${method}`);
  const fn = rpcFns.get(channel);
  if (!fn) throw new Error(`no handler for channel: ${channel}`);
  return fn(...(Array.isArray(params) ? params : []));
}

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

/** 信任设备持久化文件（打包模式 userData，开发模式 seek-agent/.seek-agent/；RemoteBridge 注入用） */
const TRUSTED_DEVICES_FILE = isPackaged
  ? join(app.getPath('userData'), 'trusted-devices.json')
  : join(ROOT, '.seek-agent', 'trusted-devices.json');

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
// 当前活动会话（渲染层正在展示的会话；启动时生成新 id，不再使用历史 'default' 会话）
let currentSessionId = '';

/** 生成新会话 ID：统一 session-xxxx-xxxx-xxxx 形态（避免所有聊天混入历史 default 会话文件） */
function newSessionId() {
  const r = () => Math.random().toString(36).substring(2, 6);
  return `session-${r()}-${r()}-${r()}`;
}

// 当前工作区目录（当前活动会话的工作区，初始为 ROOT）
// [缓存] sessions 列表签名缓存：文件未变化时避免全量 JSON.parse（sessions 目录可达 20MB+）
let __sessionsSig = '';
let __sessionsCache = [];
let currentWorkDir = ROOT;
// 按会话的工作区映射（sessionId -> { roots, active }）：不同标签页可各自挂载多个工作区，切换会话时应用
const sessionWorkDirs = new Map();

/** 获取指定会话的工作区状态 { roots, active }（优先会话映射；兼容旧 string；回退 session.json.cwd；最后回退当前活动会话的） */
function getWorkspaceStateFor(sessionId) {
  const sid = sessionId || currentSessionId;
  const hit = sessionWorkDirs.get(sid);
  // 旧数据兼容：sessionWorkDirs 曾存单目录字符串
  if (hit && typeof hit === 'string') {
    return { roots: [hit], active: hit };
  }
  if (hit && Array.isArray(hit.roots) && hit.roots.length > 0) {
    return { roots: [...hit.roots], active: hit.active || hit.roots[0] };
  }
  try {
    const sp = join(ROOT, 'sessions', sid, 'session.json');
    if (existsSync(sp)) {
      const data = JSON.parse(readFileSync(sp, 'utf8'));
      // 多工作区状态（新）：{ roots, active }
      if (data && Array.isArray(data.workspace?.roots) && data.workspace.roots.length > 0) {
        const roots = data.workspace.roots.filter(r => typeof r === 'string' && existsSync(r));
        if (roots.length > 0) {
          const active = data.workspace.active && roots.includes(data.workspace.active) ? data.workspace.active : roots[0];
          return { roots, active };
        }
      }
      // 旧字段兼容：cwd 为单目录
      if (data && typeof data.cwd === 'string' && existsSync(data.cwd)) {
        return { roots: [data.cwd], active: data.cwd };
      }
    }
  } catch { /* 读取失败忽略 */ }
  return { roots: [currentWorkDir || ROOT], active: currentWorkDir || ROOT };
}

/** 获取指定会话的工作区活跃根（旧语义，供 fs:readFileTree / git 等使用） */
function getWorkdirFor(sessionId) {
  return getWorkspaceStateFor(sessionId).active;
}

/** 保存某会话的工作区状态（roots 非空；同步当前活动会话的缓存） */
function saveWorkspaceState(sessionId, state) {
  const roots = Array.isArray(state.roots) && state.roots.length > 0 ? [...state.roots] : [currentWorkDir || ROOT];
  const active = state.active && roots.includes(state.active) ? state.active : roots[0];
  sessionWorkDirs.set(sessionId, { roots, active });
  if (sessionId === currentSessionId) currentWorkDir = active;
  return { roots, active };
}

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
    broadcastToClients('agent:stderr', text);
  });

  proc.on('exit', (code, signal) => {
    console.log(`[main] Agent ${sessionId} exited with code ${code} signal ${signal}`);
    agentProcs.delete(sessionId);
    resolveReadyWaiters(sessionId);
    broadcastToClients('agent:status', { connected: false, code, sessionId });
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

/** 向所有客户端（本地窗口 + RemoteBridge）广播事件 */
function broadcastToClients(event, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(event, payload);
  }
  if (global.remoteBridge) {
    global.remoteBridge.sendEvent(event, payload);
  }
}

/** 路由输入/命令/中断到当前活动会话（IPC 与 RemoteBridge RPC 共用） */
function routeToCurrent(msg) {
  sendToCurrent(msg);
}

/** 重启当前活动会话的 Agent（kill → 删 map → 重新 spawn） */
function restartCurrentAgent() {
  const entry = agentProcs.get(currentSessionId);
  if (entry?.proc) entry.proc.kill();
  agentProcs.delete(currentSessionId);
  spawnAgent(currentSessionId);
}


function handleAgentMessage(msg, sessionId) {
  if (msg.type === 'init-done') {
    const entry = agentProcs.get(sessionId);
    if (entry) entry.ready = true;
    console.log(`[main] Agent ${sessionId} ready`);
    broadcastToClients('agent:status', { connected: true, sessionId });
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

  // ── 跨会话协作请求：由主进程路由，不直接转发渲染层 ──
  if (msg.type === 'collab-request') {
    handleCollabRequest(msg, sessionId);
    return;
  }
  // ── 回复自动回传：目标会话产生的 agent 回复送回发起方 ──
  if (msg.type === 'message' && msg.role === 'agent' && collabReplyWaiters.has(sessionId)) {
    const from = collabReplyWaiters.get(sessionId);
    collabReplyWaiters.delete(sessionId);
    logCollab(sessionId, from, msg.content, 'reply');
    sendToAgent(from, { type: 'collab-message', from: sessionDisplayName(sessionId), content: msg.content });
  }
  // 转发时附加 sessionId，渲染层据此区分会话
  broadcastToClients('agent:message', { ...msg, sessionId });
}

// ═════════════════════════════════════════════════════
// 跨会话协作（collab）：身份卡 / 转发 / 回复回传
// ═════════════════════════════════════════════════════

/** 协作日志（最近 200 条，供 UI 展示通信记录） */
const collabLog = [];
function logCollab(from, to, content, direction) {
  collabLog.push({ from, to, content, direction, ts: Date.now() });
  if (collabLog.length > 200) collabLog.shift();
  // 通知渲染层 / RemoteBridge 刷新协作动态（collab Tab）
  broadcastToClients('collab:event', { type: 'log' });
}

/** 等待目标回复的映射：目标 sessionId → 发起方 sessionId */
const collabReplyWaiters = new Map();

/** 会话显示名：优先文件名中的标题，去掉 session- 前缀与 .json 后缀 */
function sessionTitle(sessionId) {
  return String(sessionId).replace(/^session-/, '').replace(/\.json$/, '');
}

/**
 * 会话 ID 固定形态：new-{base36}（Electron 新建）或 {4}-{4}-{4}（TUI 随机）。
 * 历史文件曾用副模型标题当 sessionId（如 session-工具结果缓存清理策略），
 * 标题随对话漂移导致身份与 worklog 分区一起漂移。此处检测非固定形态或缺失时，
 * 重新生成固定 id 并写回会话文件（一次性迁移），保证后续链路拿到稳定身份。
 */
const STABLE_SESSION_ID_RE = /^(session-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|new-[a-z0-9]+|[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/i;
function ensureStableSessionId(data, filePath) {
  const cur = data && typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  if (STABLE_SESSION_ID_RE.test(cur)) return cur;
  const fresh = newSessionId();
  if (data && filePath) {
    try {
      data.sessionId = fresh;
      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch { /* 迁移写回失败不影响本次返回 */ }
  }
  return fresh;
}

/** 会话显示名：优先 agent 侧标题（getSessionTitle 上报），回退文件名标题 */
function sessionDisplayName(sessionId) {
  return sessionTitle(sessionId);
}

/**
 * 迁移旧结构 session 数据到新文件夹结构（幂等，可重复执行）：
 *   sessions/*.json（单文件，含 session-{标题}.json / 手动保存 / default.json）
 *     → sessions/{sessionId}/session.json + payload.json（拆分）
 *   sessions/worklogs/{sid}.json
 *     → sessions/{sid}/worklog/entries.json
 * 新结构文件夹不会被重复迁移；解析失败的文件跳过（保留原样，不破坏数据）。
 */
function migrateLegacySessions() {
  const sessionsDir = join(ROOT, 'sessions');
  if (!existsSync(sessionsDir)) return;

  // 1. 根目录旧单文件 → 文件夹
  let entries;
  try { entries = readdirSync(sessionsDir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!entry.name.endsWith('.json')) continue;
    const fullPath = join(sessionsDir, entry.name);
    try {
      const raw = readFileSync(fullPath, 'utf8');
      const data = JSON.parse(raw);
      if (!data.agentMessages || !Array.isArray(data.agentMessages)) continue; // 非会话文件
      const sid = ensureStableSessionId(data, fullPath);
      const dir = join(sessionsDir, sid);
      mkdirSync(dir, { recursive: true });
      const sessionJson = join(dir, 'session.json');
      if (!existsSync(sessionJson)) {
        const payloads = Array.isArray(data.payloads) ? data.payloads : undefined;
        delete data.payloads;
        writeFileSync(sessionJson, JSON.stringify(data, null, 2), 'utf8');
        if (payloads) {
          writeFileSync(join(dir, 'payload.json'), JSON.stringify({ version: 1, sessionId: sid, payloads }, null, 2), 'utf8');
        }
      }
      unlinkSync(fullPath); // 迁移完成，删除旧单文件
    } catch { /* 解析失败的文件保留原样 */ }
  }

  // 2. 旧 worklogs 目录 → 各 session 文件夹的 worklog/entries.json
  const worklogsDir = join(sessionsDir, 'worklogs');
  if (existsSync(worklogsDir)) {
    try {
      for (const f of readdirSync(worklogsDir)) {
        if (!f.endsWith('.json')) continue;
        const sid = f.replace(/\.json$/, '');
        const src = join(worklogsDir, f);
        const dstDir = join(sessionsDir, sid, 'worklog');
        const dst = join(dstDir, 'entries.json');
        mkdirSync(dstDir, { recursive: true });
        if (!existsSync(dst)) {
          try {
            const parsed = JSON.parse(readFileSync(src, 'utf8'));
            parsed.sessionId = parsed.sessionId || sid;
            writeFileSync(dst, JSON.stringify(parsed, null, 2), 'utf8');
          } catch { /* 损坏文件跳过 */ }
        }
        unlinkSync(src);
      }
      // 空目录清理（失败忽略）
      try { rmdirSync(worklogsDir); } catch { /* ignore */ }
    } catch { /* ignore */ }
  }
}



/** 处理 agent 进程发来的跨会话协作请求（collab-request） */
function handleCollabRequest(msg, fromSessionId) {
  const reply = (data, error) => {
    sendToAgent(fromSessionId, { type: 'collab-result', requestId: msg.requestId, ok: !error, data, error });
  };
  if (msg.kind === 'send') {
    const to = String(msg.to || '');
    const content = String(msg.content || '');
    if (!to || !content) {
      reply(null, '缺少目标会话或消息内容');
      return;
    }
    logCollab(fromSessionId, to, content, 'out');
    const entry = agentProcs.get(to);
    if (entry && entry.ready) {
      // 目标活跃：直接送达，并登记回复回传
      collabReplyWaiters.set(to, fromSessionId);
      sendToAgent(to, { type: 'collab-message', from: sessionTitle(fromSessionId), content });
      reply({ delivered: true, target: to });
    } else {
      // 目标未活跃：不自动唤醒完整会话
      reply({ delivered: false, target: to, active: false });
    }
    return;
  }
  reply(null, `未知的协作请求类型: ${msg.kind}`);
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
 * - 会话进程已存在 → 立即切换路由，后台发 session:activate 重放 UI 消息
 * - 进程不存在（首次打开已保存会话）→ 立即切换路由，后台拉起新进程，init 后通过 /loadsession 恢复历史
 * 无论哪种情况，handler 不等待 Agent 就绪（避免阻塞渲染层），启动失败通过 agent:session-error 通知。
 */
registerRpc('session:switch', async (sessionId, name) => {
  try {
    if (!sessionId) return { error: '缺少 sessionId' };
    const existed = agentProcs.has(sessionId);
    if (!existed) spawnAgent(sessionId);
    currentSessionId = sessionId;
    // 应用目标会话自己的工作区（不同标签页各自工作区，切换时跟随）
    const targetState = getWorkspaceStateFor(sessionId);
    const targetDir = targetState.active;
    currentWorkDir = targetDir;
    // 后台拉起：就绪后下发激活/加载命令，失败则通知渲染层
    waitForReady(sessionId).then(() => {
      const entry = agentProcs.get(sessionId);
      if (entry?.ready) {
        // 同步目标会话的工作区到其 agent（静默，多根整体同步），再恢复/激活
        syncWorkspaceToAgent(sessionId, targetState);
        if (!existed) {
          if (name) {
            sendToAgent(sessionId, { type: 'command', cmd: `/loadsession ${name}`, id: `load-${sessionId}` });
          } else {
            sendToAgent(sessionId, { type: 'command', cmd: 'session:new', id: `new-${sessionId}` });
          }
        } else {
          // 已有进程：重放显示（不打断其工作循环）
          sendToAgent(sessionId, { type: 'command', cmd: 'session:activate', id: `activate-${sessionId}` });
        }
        // 通知渲染层当前会话工作区（FolderSelector 跟随显示不同标签页各自的工作区）
        broadcastToClients('workdir:changed', { roots: targetState.roots, active: targetState.active });
      } else {
        notifySessionError(sessionId, 'Agent 进程启动失败或超时');
      }
    });
    return { success: true, sessionId, name: name || null, created: !existed, workdir: targetDir };
  } catch (err) {
    return { error: err.message };
  }
});

/** 新建会话：立即切路由，Agent 进程在后台拉起（不阻塞渲染层） */
registerRpc('session:new', async () => {
  const sessionId = newSessionId();
  spawnAgent(sessionId);
  currentSessionId = sessionId;
  // 新会话继承当前活动会话的工作区（可后续各自修改）
  saveWorkspaceState(sessionId, getWorkspaceStateFor(currentSessionId));
  // 后台等待就绪，仅做失败兜底
  waitForReady(sessionId).then(() => {
    const entry = agentProcs.get(sessionId);
    if (entry?.ready) {
      // 新会话继承当前工作区（静默同步多根，不产生气泡）
      syncWorkspaceToAgent(sessionId, getWorkspaceStateFor(sessionId));
    } else {
      notifySessionError(sessionId, 'Agent 进程启动失败或超时');
    }
  });
  return { success: true, sessionId, workdir: currentWorkDir };
});

/** 通知渲染层某会话的 Agent 后台拉起失败 */
function notifySessionError(sessionId, error) {
  broadcastToClients('agent:session-error', { sessionId, error });
}
registerRpc('session:close', (sessionId) => {
  const entry = agentProcs.get(sessionId);
  if (entry?.proc) {
    try {
      entry.proc.stdin.write(JSON.stringify({ type: 'exit' }) + '\n');
    } catch { /* ignore */ }
    setTimeout(() => { if (!entry.proc.killed) entry.proc.kill(); }, 800);
  }
  agentProcs.delete(sessionId);
  if (currentSessionId === sessionId) currentSessionId = Array.from(agentProcs.keys())[0] || newSessionId();
  return { success: true };
});

/** 查询当前活动会话 */
registerRpc('session:current', () => ({ sessionId: currentSessionId }));

/** 查询当前存活的会话进程列表 */
registerRpc('session:list', () => {
  return Array.from(agentProcs.keys()).map((sid) => ({
    sessionId: sid,
    ready: agentProcs.get(sid)?.ready ?? false,
  }));
});


/** 跨会话协作：通信记录（最新在前，含展示名） */
registerRpc('collab:log', () => collabLog.slice().reverse().map(e => ({
  ...e,
  fromName: sessionTitle(e.from),
  toName: sessionTitle(e.to),
  time: new Date(e.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
})));

// ═════════════════════════════════════════════════════
// 远程信任设备（remote:getDevices / remote:revokeDevice，桌面 IPC 与远程 RPC 共用）
// ═════════════════════════════════════════════════════

/** 查询信任设备列表（本地持久化 + 最近 trust-list 的 online 状态） */
registerRpc('remote:getDevices', () => {
  const bridge = global.remoteBridge;
  if (!bridge) return { error: '远程桥未启动（未配置 SEEK_RELAY_URL）', devices: [] };
  return bridge.getTrustedDevices();
});

/** 撤销对某设备的信任（发 trust-revoke + 本地删除） */
registerRpc('remote:revokeDevice', (remoteId) => {
  const bridge = global.remoteBridge;
  if (!bridge) return { error: '远程桥未启动（未配置 SEEK_RELAY_URL）' };
  return bridge.revokeTrustedDevice(remoteId);
});

/** 把子 Agent 消息流保存为本地 json-session 文件。新结构落点：sessions/{当前主会话Id}/subagent-docs/{id}.json；旧路径 sessions/subagent/ 兼容读取 */
registerRpc('session:saveSubagent', (data) => {
  try {
    if (!data || typeof data !== 'object') return { ok: false, error: '无效的数据' };
    const sessionId = String(data.sessionId || `subagent-${Date.now().toString(36)}`);
    const safeId = sessionId.replace(/[\\\/:*?"<>|\r\n\t]/g, '-').trim().slice(0, 80);
    // 存到当前主会话的 subagent-docs 文件夹（文件夹名 = 稳定 sessionId）
    const hostId = (currentSessionId || newSessionId()).replace(/[\\\/:*?"<>|\r\n\t]/g, '_');
    const dir = join(ROOT, 'sessions', hostId, 'subagent-docs');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${safeId}.json`);
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});


// ── 窗口控制 ──

// 渲染进程查询当前 agent 连接状态（刷新后重连可用）
registerRpc('agent:status:request', () => {
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

/** 向指定会话的 agent 同步其工作区（静默：只改状态，不产生气泡）；dir 缺省取该会话工作区 */
function sendWorkdirToAgent(sessionId, dir) {
  const target = dir || getWorkdirFor(sessionId);
  if (!sessionId || !target) return;
  sendToAgent(sessionId, { type: 'command', cmd: `workdir-global silent ${target}`, id: `workdir-sync-${sessionId}` });
}

/** 向指定会话的 agent 同步多工作区根（workdir-roots 静默指令，整体替换） */
function syncWorkspaceToAgent(sessionId, state) {
  const st = state || getWorkspaceStateFor(sessionId);
  if (!sessionId || !st || !st.roots || !st.roots.length) return;
  const payload = JSON.stringify({ roots: st.roots, active: st.active });
  sendToAgent(sessionId, { type: 'command', cmd: `workdir-roots silent ${payload}`, id: `workdir-roots-${sessionId}` });
}

/** 校验目录存在且为目录；返回 { path } 或 { error } */
function normalizeDir(pathStr) {
  if (!pathStr) return { error: '缺少目录路径' };
  const resolved = resolve(pathStr);
  if (!existsSync(resolved)) return { error: `目录不存在: ${pathStr}` };
  if (!statSync(resolved).isDirectory()) return { error: `路径不是目录: ${pathStr}` };
  return { path: resolved };
}

registerRpc('workdir:get', () => {
  // 返回当前活动会话的工作区状态（多根 + 活跃）
  return getWorkspaceStateFor(currentSessionId);
});

registerRpc('workdir:set', async (newDir) => {
  // 单路径语义（向后兼容）：整体替换为单个根
  const norm = normalizeDir(newDir);
  if (norm.error) return { error: norm.error };
  const state = saveWorkspaceState(currentSessionId, { roots: [norm.path], active: norm.path });
  addRecentDir(norm.path);
  // 会话列表/身份卡目录随工作区变化，重置签名缓存强制重新读取
  __sessionsSig = '';
  __sessionsCache = [];

  // 只同步当前会话的 agent（其余会话保持各自工作区）
  syncWorkspaceToAgent(currentSessionId, state);

  broadcastToClients('workdir:changed', state);

  return { success: true, path: norm.path, roots: state.roots, active: state.active, sessionId: currentSessionId };
});

/** 整体设置多工作区根列表（{ roots, active? }）：校验后替换，广播并同步 agent */
registerRpc('workdir:setRoots', async ({ roots, active } = {}) => {
  try {
    const list = Array.isArray(roots) ? roots : [];
    if (list.length === 0) return { error: 'roots 不能为空' };
    const normed = [];
    for (const r of list) {
      const norm = normalizeDir(r);
      if (norm.error) return { error: norm.error };
      normed.push(norm.path);
    }
    // 去重保序
    const unique = [...new Set(normed)];
    let act = active ? resolve(active) : unique[0];
    if (!unique.includes(act)) act = unique[0];
    const state = saveWorkspaceState(currentSessionId, { roots: unique, active: act });
    addRecentDir(act);
    __sessionsSig = ''; __sessionsCache = [];
    syncWorkspaceToAgent(currentSessionId, state);
    broadcastToClients('workdir:changed', state);
    return { success: true, roots: state.roots, active: state.active, sessionId: currentSessionId };
  } catch (err) { return { error: err.message }; }
});

/** 追加一个工作区根（不改变活跃根；初始默认根时自动把新目录设为活跃） */
registerRpc('workdir:addRoot', async ({ path } = {}) => {
  try {
    const norm = normalizeDir(path);
    if (norm.error) return { error: norm.error };
    const prev = getWorkspaceStateFor(currentSessionId);
    let roots = prev.roots.includes(norm.path) ? prev.roots : [...prev.roots, norm.path];
    let active = prev.active;
    // 初始状态（只有默认 ROOT 根且活跃未改）时把新目录设为活跃，让用户立即看到效果
    if (prev.roots.length === 1 && prev.active === ROOT) active = norm.path;
    const state = saveWorkspaceState(currentSessionId, { roots, active });
    addRecentDir(norm.path);
    __sessionsSig = ''; __sessionsCache = [];
    syncWorkspaceToAgent(currentSessionId, state);
    broadcastToClients('workdir:changed', state);
    return { success: true, roots: state.roots, active: state.active, sessionId: currentSessionId };
  } catch (err) { return { error: err.message }; }
});

/** 移除一个工作区根（活跃根被移除时切到剩余第一个；至少保留一个根） */
registerRpc('workdir:removeRoot', async ({ path } = {}) => {
  try {
    if (!path) return { error: '缺少 path' };
    const resolved = resolve(path);
    const prev = getWorkspaceStateFor(currentSessionId);
    let roots = prev.roots.filter(r => r !== resolved);
    if (roots.length === 0) roots = [ROOT];
    let active = prev.active;
    if (active === resolved) active = roots[0];
    const state = saveWorkspaceState(currentSessionId, { roots, active });
    __sessionsSig = ''; __sessionsCache = [];
    syncWorkspaceToAgent(currentSessionId, state);
    broadcastToClients('workdir:changed', state);
    return { success: true, roots: state.roots, active: state.active, sessionId: currentSessionId };
  } catch (err) { return { error: err.message }; }
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

registerRpc('workdir:getRecent', () => {
  return loadRecentDirs();
});

// ═════════════════════════════════════════════════════
// .env 配置读写（env:read / env:write，本地 IPC 与远程 RPC 共用）
// ═════════════════════════════════════════════════════

/** .env 文件路径（seek-agent 根目录 = electron/ 的上一级） */
const ENV_FILE = resolve(__dirname, '..', '.env');

/**
 * 解析 .env 文本 → 配置项数组 [{ key, value, line }]。
 * - 只包含 KEY=VALUE 形式的行（key 保留原始大小写；value 为 = 后内容，去除首尾空白，
 *   与 dotenv 语义一致，便于设置面板展示）
 * - 跳过注释行与空行；line 为 1 起始行号
 */
export function parseEnv(text) {
  const items = [];
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.trim()) continue; // 空行
    if (line.trim().startsWith('#')) continue; // 注释行
    const eq = line.indexOf('=');
    if (eq < 0) continue; // 非 KEY=VALUE 形式
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue; // 非法 key
    const value = line.slice(eq + 1).trim();
    items.push({ key, value, line: i + 1 });
  }
  return items;
}

/**
 * 合并 updates → 新 .env 文本。
 * - 逐行处理：命中的 KEY 替换该行 VALUE（保留行首缩进与 = 前后格式）；
 *   value 为空字符串时写 KEY= 保留该行（key 保持可见，与 dotenv 空值语义一致）
 * - 未命中的行原样保留（注释与顺序不破坏）
 * - updates 中文件里不存在的 KEY 追加到末尾（KEY=VALUE，前面补一个空行分隔）
 */
export function applyEnvUpdates(text, updates) {
  const updateMap = new Map();
  for (const u of updates || []) {
    if (u && typeof u.key === 'string' && u.key.trim()) {
      updateMap.set(u.key, String(u.value ?? ''));
    }
  }
  if (updateMap.size === 0) return String(text ?? '');
  const lines = String(text ?? '').split('\n');
  const out = [];
  const seen = new Set();
  const KEY_LINE_RE = /^([ \t]*)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)(.*)$/;
  for (const raw of lines) {
    const m = KEY_LINE_RE.exec(raw.replace(/\r$/, ''));
    if (m && updateMap.has(m[2])) {
      seen.add(m[2]);
      // 保留缩进与 = 前格式，替换 = 后 value；value 为空 → 写 KEY=
      out.push(`${m[1]}${m[2]}${m[3]}${updateMap.get(m[2])}`);
      continue;
    }
    out.push(raw); // 未命中行原样保留（含注释 / 空行 / 其他格式行）
  }
  // 追加 updates 中文件里不存在的 KEY（带一个空行分隔）
  const tail = [];
  for (const [key, value] of updateMap) {
    if (seen.has(key)) continue;
    tail.push(`${key}=${value}`);
  }
  let result = out.join('\n');
  if (tail.length) {
    const sep = result === '' ? '' : (result.endsWith('\n') ? '\n' : '\n\n');
    result += sep + tail.join('\n') + '\n';
  }
  return result;
}

/** env:read — 读取 .env 配置项（本地 IPC 与远程 RPC 共用） */
registerRpc('env:read', () => {
  try {
    if (!existsSync(ENV_FILE)) {
      return { ok: true, path: ENV_FILE, items: [] };
    }
    const text = readFileSync(ENV_FILE, 'utf8');
    return { ok: true, path: ENV_FILE, items: parseEnv(text) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** env:write — 更新 .env 配置项（payload: { updates: [{ key, value }] }） */
registerRpc('env:write', (payload = {}) => {
  try {
    // 兼容两种调用形态：{ updates: [...] }（preload 传参）或直接传 updates 数组（远程 RPC 兜底）
    const updates = Array.isArray(payload)
      ? payload
      : Array.isArray(payload && payload.updates) ? payload.updates : [];
    const text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
    const next = applyEnvUpdates(text, updates);
    writeFileSync(ENV_FILE, next, 'utf8');
    const written = updates
      .filter(u => u && typeof u.key === 'string' && u.key.trim())
      .map(u => u.key);
    return { ok: true, path: ENV_FILE, written };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── 渲染进程请求 ──

/**
 * 读取文件树（只读单层，文件夹展开时前端按需加载子层）。
 * 避免对包含 ai-ide/repos 等大目录的工作区做同步递归遍历而阻塞主进程。
 */
registerRpc('fs:readFileTree', async (dirPath) => {
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
      const node = { name: entry.name, path: relPath, absPath: fullPath, type: 'folder' };
      if (depth > 1) node.children = buildFileTree(fullPath, relPath, depth - 1);
      children.push(node);
    } else {
      const ext = entry.name.split('.').pop().toLowerCase();
      children.push({ name: entry.name, path: relPath, absPath: fullPath, type: 'file', ext });
    }
  }
  return children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** 读取 git 变更状态（异步 exec，避免阻塞主进程） */
registerRpc('fs:readGitStatus', () => {
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

registerRpc('fs:listSessions', async () => {
  const sessionsDir = join(ROOT, 'sessions');
  try {
    const entries = readdirSync(sessionsDir, { withFileTypes: true });
    // 会话候选：新结构 sessions/{sessionId}/session.json（文件夹）；旧结构 sessions/*.json 单文件（迁移前兼容）
    const candidates = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const sp = join(sessionsDir, entry.name, 'session.json');
        if (existsSync(sp)) candidates.push({ key: entry.name, path: sp });
      } else if (entry.name.endsWith('.json')) {
        candidates.push({ key: entry.name.replace(/\.json$/, ''), path: join(sessionsDir, entry.name) });
      }
    }
    // [缓存] 签名 = 名称:大小:mtime，无变化直接返回缓存（避免反复全量解析大文件）
    const sigParts = [];
    for (const c of candidates) {
      try {
        const st = statSync(c.path);
        sigParts.push(`${c.key}:${st.size}:${st.mtimeMs}`);
      } catch { /* 文件可能正被 agent 清理，跳过，不中断整个列表 */ }
    }
    const sig = sigParts.join('|');
    if (sig === __sessionsSig) return __sessionsCache;
    const sessions = [];
    for (const c of candidates) {
      try {
        const data = JSON.parse(readFileSync(c.path, 'utf8'));
        const msgCount = data.agentMessages ? data.agentMessages.length : 0;
        const lastMsg = msgCount > 0 ? data.agentMessages[msgCount - 1] : null;
        // lastMsg.content 可能是字符串（user）或 parts 数组（assistant），统一提取文本
        let previewText = '';
        if (lastMsg && lastMsg.content) {
          if (typeof lastMsg.content === 'string') {
            previewText = lastMsg.content;
          } else if (Array.isArray(lastMsg.content)) {
            previewText = lastMsg.content.map((p) => (p && p.type === 'text' ? p.text : '')).filter(Boolean).join(' ');
          }
        }
        const preview = previewText.replace(/<[^>]+>/g, '').slice(0, 80).replace(/\n/g, ' ');
        sessions.push({
          name: c.key,
          // 固定形态 sessionId：文件内身份优先，缺失或标题污染（历史文件）在此一次性迁移写回
          sessionId: ensureStableSessionId(data, c.path),
          // 纯标题（渲染层标签页/列表显示名用；历史文件可能无 title 字段）
          title: data.title || '',
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

registerRpc('skills:list', async () => {
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

registerRpc('sidebar:static', async () => {
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
registerRpc('sidebar:instruction', (kind, file) => {
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


app.whenReady().then(() => {
  // 迁移旧 session 数据到新文件夹结构（启动时一次，幂等）
  migrateLegacySessions();
  createWindow();
  // 启动会话：生成全新 session-xxxx-xxxx-xxxx 会话（不再固定 'default'，避免不同启动的聊天混入同一文件）
  currentSessionId = newSessionId();
  spawnAgent(currentSessionId);
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

// ── 远程接入（可选）：SEEK_RELAY_URL 存在则启动 RemoteBridge ──
if (process.env.SEEK_RELAY_URL) {
  global.remoteBridge = startRemoteBridge({
    routeToCurrent,
    restartCurrentAgent,
    invokeHandler: remoteInvokeHandler,
    broadcastEvent: broadcastToClients,
    trustedDevicesFile: TRUSTED_DEVICES_FILE,
  });
}




































































































































































