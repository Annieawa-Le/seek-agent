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

  // ── 跨会话协作请求：由主进程路由，不直接转发渲染层 ──
  if (msg.type === 'collab-request') {
    handleCollabRequest(msg, sessionId);
    return;
  }
  // ── 会话身份卡：agent 总结完成后上报，主进程写入附属目录 ──
  if (msg.type === 'identity-card') {
    handleIdentityCard(msg, sessionId);
    return;
  }
  // ── 回复自动回传：目标会话产生的 agent 回复送回发起方 ──
  if (msg.type === 'message' && msg.role === 'agent' && collabReplyWaiters.has(sessionId)) {
    const from = collabReplyWaiters.get(sessionId);
    collabReplyWaiters.delete(sessionId);
    logCollab(sessionId, from, msg.content, 'reply');
    sendToAgent(from, { type: 'collab-message', from: sessionDisplayName(sessionId), content: msg.content });
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 转发时附加 sessionId，渲染层据此区分会话
    mainWindow.webContents.send('agent:message', { ...msg, sessionId });
  }
}

// ═════════════════════════════════════════════════════
// 跨会话协作（collab）：身份卡 / 转发 / 回复回传
// ═════════════════════════════════════════════════════

/** 协作日志（最近 200 条，供 UI 展示通信记录） */
const collabLog = [];
function logCollab(from, to, content, direction) {
  collabLog.push({ from, to, content, direction, ts: Date.now() });
  if (collabLog.length > 200) collabLog.shift();
  // 通知渲染层刷新协作动态（collab Tab）
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('collab:event', { type: 'log' });
  }
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
const STABLE_SESSION_ID_RE = /^(new-[a-z0-9]+|[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/i;
function ensureStableSessionId(data, filePath) {
  const cur = data && typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  if (STABLE_SESSION_ID_RE.test(cur)) return cur;
  const fresh = `new-${Date.now().toString(36)}`;
  if (data && filePath) {
    try {
      data.sessionId = fresh;
      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch { /* 迁移写回失败不影响本次返回 */ }
  }
  return fresh;
}

/** 会话显示名：优先身份卡上报的标题（agent 侧 getSessionTitle），回退文件名标题 */
function sessionDisplayName(sessionId) {
  const identity = agentIdentityMap.get(sessionId);
  if (identity && identity.name) return identity.name;
  return sessionTitle(sessionId);
}


/** 读取 sessions/*.json 的历史会话身份卡列表（按 mtime 倒序） */
function listHistoryCards() {
  const sessionsDir = join(currentWorkDir, 'sessions');
  const cards = [];
  try {
    for (const file of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!file.name.endsWith('.json')) continue;
      const fullPath = join(sessionsDir, file.name);
      try {
        const data = JSON.parse(readFileSync(fullPath, 'utf8'));
        const msgCount = data.agentMessages ? data.agentMessages.length : 0;
        const lastMsg = msgCount > 0 ? data.agentMessages[msgCount - 1] : null;
        let previewText = '';
        if (lastMsg && lastMsg.content) {
          if (typeof lastMsg.content === 'string') {
            previewText = lastMsg.content;
          } else if (Array.isArray(lastMsg.content)) {
            previewText = lastMsg.content.map(p => (p && p.type === 'text' ? p.text : '')).filter(Boolean).join(' ');
          }
        }
        const st = statSync(fullPath);
        // 优先读附属身份卡（sessions/identity/ 同名文件）
        const identity = readIdentityCardFor(file.name);
        cards.push({
          // 固定形态 sessionId：优先文件内身份（历史标题污染文件在此一次性迁移写回）
          sessionId: ensureStableSessionId(data, fullPath),
          name: data.title || file.name.replace('.json', ''),
          messageCount: msgCount,
          preview: (identity?.focus) || previewText.replace(/<[^>]+>/g, '').slice(0, 80).replace(/\n/g, ' '),
          mtime: st.mtime.toISOString().slice(0, 16).replace('T', ' '),
          active: false,
          identity: identity || null,
        });
      } catch { /* 单个文件损坏跳过 */ }
    }
  } catch { /* sessions 目录不存在 */ }
  cards.sort((a, b) => String(b.mtime || '').localeCompare(String(a.mtime || '')));
  return cards;
}

/** 列出所有会话身份卡（活跃 + 历史，活跃在前） */
function listSessionCards() {
  const active = Array.from(agentProcs.keys()).map(sid => {
    const card = { sessionId: sid, name: sessionDisplayName(sid), active: true };
    const identity = agentIdentityMap.get(sid);
    if (identity) {
      Object.assign(card, {
        messageCount: identity.messageCount,
        preview: identity.focus || identity.summary || '',
        identity,
      });
    }
    const hist = findHistoryCard(sid);
    if (hist && !card.identity) Object.assign(card, { messageCount: hist.messageCount, mtime: hist.mtime, preview: hist.preview, identity: hist.identity });
    return card;
  });
  const history = listHistoryCards().filter(h => !agentProcs.has(h.sessionId));
  return [...active, ...history];
}
/** 按 sessionId 或标题模糊查找历史会话身份卡 */
function findHistoryCard(target) {
  const t = String(target || '').toLowerCase();
  if (!t) return null;
  return listHistoryCards().find(c =>
    c.sessionId.toLowerCase() === t ||
    c.name.toLowerCase() === t ||
    c.name.toLowerCase().includes(t) ||
    c.sessionId.toLowerCase().includes(t)
  ) || null;
}

/** 处理 agent 进程发来的跨会话协作请求（collab-request） */
function handleCollabRequest(msg, fromSessionId) {
  const reply = (data, error) => {
    sendToAgent(fromSessionId, { type: 'collab-result', requestId: msg.requestId, ok: !error, data, error });
  };
  if (msg.kind === 'sessions') {
    reply({ sessions: listSessionCards() });
    return;
  }
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
      // 目标未活跃：身份卡优先，不自动唤醒完整会话
      const card = findHistoryCard(to);
      if (card) {
        reply({ delivered: false, target: to, identityCard: card });
      } else {
        reply(null, `未找到会话「${to}」`);
      }
    }
    return;
  }
  reply(null, `未知的协作请求类型: ${msg.kind}`);
}

// ═════════════════════════════════════════════════════
// 会话身份卡：附属目录 sessions/identity/ 读写
// ═════════════════════════════════════════════════════

/** 活跃会话身份卡内存索引：sessionId → card */
const agentIdentityMap = new Map();

/** 会话身份卡目录（子目录，避免被会话列表扫描误判为会话文件） */
function identityDir() {
  return join(currentWorkDir, 'sessions', 'identity');
}

/** 清洗会话名，用于身份卡文件名 */
function sanitizeSessionName(name) {
  return String(name || '未命名会话').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || '未命名会话';
}

/** 读取某会话文件对应的身份卡（sessions/identity/{同名}.json） */
function readIdentityCardFor(sessionFileName) {
  try {
    const p = join(identityDir(), sessionFileName);
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** 处理 agent 上报的身份卡：写入附属目录并通知渲染层 */
function handleIdentityCard(msg, sessionId) {
  const card = msg.card || {};
  if (msg.error) {
    console.warn(`[main] identity-card failed for ${sessionId}:`, msg.error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:identity-card', { sessionId, error: msg.error });
    }
    return;
  }
  const title = sanitizeSessionName(card.name);
  const sessionFileName = `session-${title}.json`;
  const saved = {
    ...card,
    generatedAt: new Date().toISOString(),
  };
  try {
    mkdirSync(identityDir(), { recursive: true });
    writeFileSync(join(identityDir(), sessionFileName), JSON.stringify(saved, null, 2), 'utf8');
    agentIdentityMap.set(sessionId, saved);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:identity-card', { sessionId, card: saved });
    }
  } catch (e) {
    console.warn('[main] write identity card failed:', e.message);
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
 * - 会话进程已存在 → 立即切换路由，后台发 session:activate 重放 UI 消息
 * - 进程不存在（首次打开已保存会话）→ 立即切换路由，后台拉起新进程，init 后通过 /loadsession 恢复历史
 * 无论哪种情况，handler 不等待 Agent 就绪（避免阻塞渲染层），启动失败通过 agent:session-error 通知。
 */
ipcMain.handle('session:switch', async (_e, sessionId, name) => {
  try {
    if (!sessionId) return { error: '缺少 sessionId' };
    const existed = agentProcs.has(sessionId);
    if (!existed) spawnAgent(sessionId);
    currentSessionId = sessionId;
    // 后台拉起：就绪后下发激活/加载命令，失败则通知渲染层
    waitForReady(sessionId).then(() => {
      const entry = agentProcs.get(sessionId);
      if (entry?.ready) {
        if (!existed) {
          // 新拉起的进程：先静默同步当前工作区，再恢复会话
          if (currentWorkDir !== ROOT) sendWorkdirToAgent(sessionId);
          if (name) {
            sendToAgent(sessionId, { type: 'command', cmd: `/loadsession ${name}`, id: `load-${sessionId}` });
          } else {
            sendToAgent(sessionId, { type: 'command', cmd: 'session:new', id: `new-${sessionId}` });
          }
        } else {
          // 已有进程：重放显示（不打断其工作循环）
          sendToAgent(sessionId, { type: 'command', cmd: 'session:activate', id: `activate-${sessionId}` });
        }
      } else {
        notifySessionError(sessionId, 'Agent 进程启动失败或超时');
      }
    });
    return { success: true, sessionId, name: name || null, created: !existed };
  } catch (err) {
    return { error: err.message };
  }
});

/** 新建会话：立即切路由，Agent 进程在后台拉起（不阻塞渲染层） */
ipcMain.handle('session:new', async () => {
  const sessionId = `new-${Date.now().toString(36)}`;
  spawnAgent(sessionId);
  currentSessionId = sessionId;
  // 新进程初始即为空会话，无需下发 session:new（避免 clear-messages 清掉渲染层刚组装的初始气泡）
  // 后台等待就绪，仅做失败兜底
  waitForReady(sessionId).then(() => {
    const entry = agentProcs.get(sessionId);
    if (entry?.ready) {
      // 新会话继承当前工作区（静默同步，不产生气泡）
      if (currentWorkDir !== ROOT) sendWorkdirToAgent(sessionId);
    } else {
      notifySessionError(sessionId, 'Agent 进程启动失败或超时');
    }
  });
  return { success: true, sessionId };
});

/** 通知渲染层某会话的 Agent 后台拉起失败 */
function notifySessionError(sessionId, error) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('agent:session-error', { sessionId, error });
  }
}
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

/** 生成会话身份卡：通知目标 agent 用轻量模型总结当前对话 */
ipcMain.handle('session:generateIdentityCard', async (_e, sessionId) => {
  const sid = sessionId || currentSessionId;
  const entry = agentProcs.get(sid);
  if (!entry || !entry.ready) {
    return { error: '会话 Agent 未就绪，无法生成身份卡' };
  }
  sendToAgent(sid, { type: 'command', cmd: 'identity-card:generate', id: `idcard-${sid}` });
  return { success: true };
});

/** 跨会话协作：会话列表（活跃 + 历史，含身份卡，活跃在前） */
ipcMain.handle('collab:sessions', () => listSessionCards());

/** 跨会话协作：通信记录（最新在前，含展示名） */
ipcMain.handle('collab:log', () => collabLog.slice().reverse().map(e => ({
  ...e,
  fromName: sessionTitle(e.from),
  toName: sessionTitle(e.to),
  time: new Date(e.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
})));


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

/** 向指定会话的 agent 同步当前工作区（静默：只改状态，不产生气泡） */
function sendWorkdirToAgent(sessionId) {
  if (!sessionId || !currentWorkDir) return;
  sendToAgent(sessionId, { type: 'command', cmd: `workdir-global silent ${currentWorkDir}`, id: `workdir-sync-${sessionId}` });
}

/** 向所有存活会话同步当前工作区（切换工作区后广播，保证已存在的会话也一致） */
function syncWorkdirToAllAgents() {
  for (const sessionId of agentProcs.keys()) {
    sendWorkdirToAgent(sessionId);
  }
}


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
    // 会话列表/身份卡目录随工作区变化，重置签名缓存强制重新读取
    __sessionsSig = '';
    __sessionsCache = [];

    // 广播到所有存活会话（静默同步，不产生气泡；后续新建/拉起的会话由 session:new / session:switch 补发）
    syncWorkdirToAllAgents();

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
  const sessionsDir = join(currentWorkDir, 'sessions');
  try {
    const files = readdirSync(sessionsDir, { withFileTypes: true });
    // [缓存] 签名 = 文件名:大小:mtime，无变化直接返回缓存（避免反复全量解析大文件）
    const sig = files
      .filter(f => f.name.endsWith('.json'))
      .map(f => {
        try {
          const st = statSync(join(sessionsDir, f.name));
          return `${f.name}:${st.size}:${st.mtimeMs}`;
        } catch {
          // 文件可能正被 agent 清理（标题变更 unlink），跳过，不中断整个列表
          return null;
        }
      })
      .filter(Boolean)
      .join('|');
    // 身份卡子目录变化也纳入签名（生成身份卡后刷新列表预览）
    const idSig = (() => {
      try {
        return readdirSync(identityDir(), { withFileTypes: true })
          .filter(f => f.name.endsWith('.json'))
          .map(f => {
            try {
              const st = statSync(join(identityDir(), f.name));
              return `${f.name}:${st.mtimeMs}`;
            } catch { return null; }
          })
          .filter(Boolean)
          .join('|');
      } catch { return ''; }
    })();
    if (sig + '#' + idSig === __sessionsSig) return __sessionsCache;
    const sessions = [];
    for (const file of files) {
      if (!file.name.endsWith('.json')) continue;
      const fullPath = join(sessionsDir, file.name);
      try {
        const data = JSON.parse(readFileSync(fullPath, 'utf8'));
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
        // 有身份卡时用 focus 作预览（无则回退最后消息截断）
        const identity = readIdentityCardFor(file.name);
        const preview = (identity?.focus) || previewText.replace(/<[^>]+>/g, '').slice(0, 80).replace(/\n/g, ' ');
        sessions.push({
          name: file.name.replace('.json', ''),
          // 固定形态 sessionId：文件内身份优先，缺失或标题污染（历史文件）在此一次性迁移写回
          sessionId: ensureStableSessionId(data, fullPath),
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




















































































