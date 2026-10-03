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

import { app, BrowserWindow, ipcMain, dialog, session, screen } from 'electron';
import { spawn, exec } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve, join, isAbsolute, basename } from 'path';
import { watch } from 'fs';
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { readFile } from 'fs/promises';
import { startRemoteBridge } from './remote-bridge.js';
import { extractPatchBody, parsePatchMeta, truncatePatchBody } from './patch-history.js';
import { revertContent, RevertError } from './patch-revert.js';
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
  readFile: 'fs:readFile',
  writeFile: 'fs:writeFile',
  listPatches: 'fs:listPatches',
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
  getPlugins: 'plugins:list',
  setPluginEnabled: 'plugins:setEnabled',
  setPluginOption: 'plugins:setOption',
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


// ═════════════════════════════════════════════════════
// 鲸鱼娘挂件（dsh-whale-widget 移植）：假 DSH 宿主托管
//
// 这是 inner_skill（src/tools/inner_skills/dsh-whale-widget）的「宿主半区」：
// skill 目录里放着 dsh-whale-widget 原包（widget/）与假 DSH 壳（shim.mjs），
// 但把挂件注入渲染层只有主进程能做，所以由这里读取 enable.json 按开关托管。
// ═════════════════════════════════════════════════════
const WHALE_SKILL_DIR = join(__dirname, '..', 'src', 'tools', 'inner_skills', 'dsh-whale-widget');
let whaleHost = null;
/** 把 seek-agent 的累计用量换算成插件要的单步增量（模块：skill 目录 usage-cursor.mjs） */
let whaleUsageCursor = null;
let whaleTurn = 1;
let whaleTurnOpen = false;

/**
 * 挂件发往本地宿主的请求会被判为「跨站」（file:// 页面 → 127.0.0.1）而 403：
 * 鲸鱼娘是插件自带的 Sec-Fetch-Site 校验，表情包宿主则是 CORS。
 * Electron 允许在请求发出前改写请求头，这里抹掉 Sec-Fetch-Site / Origin 一次性解决两者。
 *
 * 注意：webRequest.onBeforeSendHeaders 是「单监听器」语义，后注册会覆盖先注册。
 * 所以这里只装一次，URL 模式覆盖全部挂件端口，而不是每个挂件各装一次。
 */
const localHostRewritePorts = new Set();
let localHostRewriteInstalled = false;
function installLocalHostRequestRewrite(port) {
  localHostRewritePorts.add(port);
  if (localHostRewriteInstalled) return;
  localHostRewriteInstalled = true;
  try {
    // match pattern 里写不了端口，且 onBeforeSendHeaders 只认一条监听器——按 host 通配
    // 一次装全，后起的挂件端口才不会被漏掉（早期按端口枚举是在安装那一刻快照的，
    // 排在后面的挂件端口永远进不了过滤器）。
    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: ['http://127.0.0.1/*'] },
      (details, callback) => {
        const headers = details.requestHeaders;
        delete headers['Sec-Fetch-Site'];
        delete headers['sec-fetch-site'];
        delete headers['Origin'];
        delete headers['origin'];
        callback({ requestHeaders: headers });
      },
    );
    console.log('[widgets] 已安装请求头改写（抹掉 Sec-Fetch-Site/Origin，绕过跨站自校验）');
  } catch (err) {
    console.error('[widgets] 请求头改写安装失败：', err);
  }
}

/** 按 skill 的 enable.json 开关启动鲸鱼娘宿主；返回是否启动。 */
async function startWhaleWidget() {
  try {
    const enablePath = join(WHALE_SKILL_DIR, 'enable.json');
    if (!existsSync(enablePath)) return false;
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(enablePath, 'utf8')); } catch { /* 配置损坏按默认处理 */ }
    if (cfg.enable === false) {
      console.log('[whale] 挂件已禁用（enable.json: enable=false）');
      return false;
    }
    // 依 seek-agent 的 provider 配置预置凭据名，供 shim 的 credentials 回退读取。
    // 余额只有对得上「同一个 key 的厂商接口」才有意义，因此按 base_url 判定，不盲塞。
    const baseUrl = String(process.env.OPENAI_BASE_URL || '').toLowerCase();
    if (process.env.OPENAI_API_KEY) {
      if (baseUrl.includes('opencode') && !process.env.OPENCODE_GO_API_KEY) process.env.OPENCODE_GO_API_KEY = process.env.OPENAI_API_KEY;
      if (baseUrl.includes('deepseek') && !process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = process.env.OPENAI_API_KEY;
    }

    const { createWhaleHost } = await import(pathToFileURL(join(WHALE_SKILL_DIR, 'shim.mjs')).href);
    const { createUsageCursor } = await import(pathToFileURL(join(WHALE_SKILL_DIR, 'usage-cursor.mjs')).href);
    whaleUsageCursor = createUsageCursor();
    whaleHost = createWhaleHost({
      widgetDir: join(WHALE_SKILL_DIR, 'widget'),
      dataDir: join(app.getPath('userData'), 'whale'),
    });
    await whaleHost.loadPlugin();
    const { port } = await whaleHost.start();
    installLocalHostRequestRewrite(port);
    console.log(`[whale] 鲸鱼娘宿主已启动：http://127.0.0.1:${port}`);
    return true;
  } catch (err) {
    console.error('[whale] 启动失败：', err);
    whaleHost = null;
    return false;
  }
}

/** 把前端挂件注入渲染层（URL 重写到宿主端口，浏览器按绝对地址访问本地宿主）。 */
async function injectWhaleWidget(win) {
  if (!whaleHost || !win || win.isDestroyed()) return;
  try {
    const port = whaleHost.getPort();
    let code = await readFile(join(WHALE_SKILL_DIR, 'widget', 'assets', 'whale-widget.js'), 'utf8');
    code = code.split('/dsh-whale/').join(`http://127.0.0.1:${port}/dsh-whale/`);
    await win.webContents.executeJavaScript(code, true);
    console.log('[whale] 前端挂件已注入');
  } catch (err) {
    console.error('[whale] 注入失败：', err);
  }
}

/** 把 seek-agent 的模型名映射到鲸鱼娘价目表的 id（认不了就原样返回，插件用默认价）。 */
function whaleModelName() {
  const m = String(process.env.OPENAI_MODEL || '').toLowerCase();
  if (m.includes('pro')) return 'deepseek-v4-pro';
  if (m.includes('flash')) return 'deepseek-flash';
  return m;
}

// ═════════════════════════════════════════════════════
// 表情包挂件（dsh-meme 移植）：web 半区托管
//
// 与鲸鱼娘不同：dsh-meme 的后端要 tools/attachments/llm 一堆服务，跑不动原插件，
// 所以 host.mjs 只重写它对外暴露的东西（图片路由 + 图库索引接口），
// 前端 client.dom.js 走 DOM 装饰（不进 React、不依赖宿主 slot API）。
// ═════════════════════════════════════════════════════
const MEME_SKILL_DIR = join(__dirname, '..', 'src', 'tools', 'inner_skills', 'dsh-meme');
let memeHost = null;

/** 按 skill 的 enable.json 开关启动表情包宿主；返回是否启动。 */
async function startMemeWidget() {
  try {
    const enablePath = join(MEME_SKILL_DIR, 'enable.json');
    if (!existsSync(enablePath)) return false;
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(enablePath, 'utf8')); } catch { /* 配置损坏按默认处理 */ }
    if (cfg.enable === false) {
      console.log('[meme] 挂件已禁用（enable.json: enable=false）');
      return false;
    }
    const { createMemeHost } = await import(pathToFileURL(join(MEME_SKILL_DIR, 'host.mjs')).href);
    memeHost = createMemeHost({ skillDir: MEME_SKILL_DIR });
    const { port } = await memeHost.start();
    installLocalHostRequestRewrite(port);
    console.log(`[meme] 表情包宿主已启动：http://127.0.0.1:${port}`);
    return true;
  } catch (err) {
    console.error('[meme] 启动失败：', err);
    memeHost = null;
    return false;
  }
}

/** 把前端脚本注入渲染层（先塞宿主地址，再跑 client.dom.js）。 */
async function injectMemeWidget(win) {
  if (!memeHost || !win || win.isDestroyed()) return;
  try {
    const port = memeHost.getPort();
    const code = await readFile(join(MEME_SKILL_DIR, 'client.dom.js'), 'utf8');
    const prelude = `window.__MEME_HOST = 'http://127.0.0.1:${port}';\n`;
    await win.webContents.executeJavaScript(prelude + code, true);
    console.log('[meme] 前端挂件已注入');
  } catch (err) {
    console.error('[meme] 注入失败：', err);
  }
}

// ═════════════════════════════════════════════════════
// 工作台（dsh-worktable 移植）：宿主半区托管
//
// 与鲸鱼娘/表情包同一套约定：宿主逻辑全在 skill 目录（host.mjs），这里只做
// 「读 enable.json → 动态 import → 起本地服务 → 注入前端」。删掉该目录 = 整体卸载，
// 主进程不会崩（enable.json 不存在即不启用，import 失败被 catch 掉）。
// ═════════════════════════════════════════════════════
const WORKTABLE_SKILL_DIR = join(__dirname, '..', 'src', 'tools', 'inner_skills', 'dsh-worktable');
let worktableHost = null;

/** 按 skill 的 enable.json 开关启动工作台宿主；返回是否启动。 */
async function startWorktable() {
  try {
    const enablePath = join(WORKTABLE_SKILL_DIR, 'enable.json');
    if (!existsSync(enablePath)) return false;
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(enablePath, 'utf8')); } catch { /* 配置损坏按默认处理 */ }
    if (cfg.enable === false) {
      console.log('[worktable] 已禁用（enable.json: enable=false）');
      return false;
    }
    const { createWorktableHost } = await import(pathToFileURL(join(WORKTABLE_SKILL_DIR, 'host.mjs')).href);
    worktableHost = createWorktableHost({ skillDir: WORKTABLE_SKILL_DIR });
    const { port } = await worktableHost.start();
    installLocalHostRequestRewrite(port);
    console.log(`[worktable] 宿主已启动：http://127.0.0.1:${port}`);
    return true;
  } catch (err) {
    console.error('[worktable] 启动失败：', err);
    worktableHost = null;
    return false;
  }
}

/** 把前端脚本注入渲染层（先塞宿主地址，再跑 worktable.js）。 */
async function injectWorktable(win) {
  if (!worktableHost || !win || win.isDestroyed()) return;
  try {
    const port = worktableHost.getPort();
    const code = await readFile(join(WORKTABLE_SKILL_DIR, 'client', 'worktable.js'), 'utf8');
    const prelude = `window.__WT_HOST = 'http://127.0.0.1:${port}';\n`;
    await win.webContents.executeJavaScript(prelude + code, true);
    console.log('[worktable] 前端已注入');
  } catch (err) {
    console.error('[worktable] 注入失败：', err);
  }
}


// ═════════════════════════════════════════════════════
// 视觉卡片（dsh-raw-html 移植）：宿主半区托管
//
// 与工作台同一套约定：宿主逻辑全在 skill 目录（host.mjs），这里只做
// 「读 enable.json → 动态 import → 起本地服务 → 注入前端」。删掉该目录 = 整体卸载，
// 主进程不会崩（enable.json 不存在即不启用，import 失败被 catch 掉）。
//
// 与其它挂件的差别：本插件的前端不挂 DOM，而是注册到渲染层的中立内容扩展点
// （electron/renderer/src/utils/content-extension.ts）——渲染层不认识卡片协议，
// 只有插件注册了渲染器才会接管助手正文；插件缺席时渲染层走原 markdown 路径。
// ═════════════════════════════════════════════════════
const RAWTML_SKILL_DIR = join(__dirname, '..', 'src', 'tools', 'inner_skills', 'dsh-raw-html');
let rawHtmlHost = null;

/** 按 skill 的 enable.json 开关启动视觉卡片宿主；返回是否启动。 */
async function startRawHtml() {
  try {
    const enablePath = join(RAWTML_SKILL_DIR, 'enable.json');
    if (!existsSync(enablePath)) return false;
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(enablePath, 'utf8')); } catch { /* 配置损坏按默认处理 */ }
    if (cfg.enable === false) {
      console.log('[raw-html] 已禁用（enable.json: enable=false）');
      return false;
    }
    const trusted = cfg.trusted === true;
    const { createRawHtmlHost } = await import(pathToFileURL(join(RAWTML_SKILL_DIR, 'host.mjs')).href);
    rawHtmlHost = createRawHtmlHost({ skillDir: RAWTML_SKILL_DIR, trusted });
    const { port } = await rawHtmlHost.start();
    installLocalHostRequestRewrite(port);
    console.log(`[raw-html] 宿主已启动：http://127.0.0.1:${port}${trusted ? '（可信模式：卡内脚本在 iframe 沙箱内执行）' : '（安全模式：卡内脚本不执行）'}`);
    return true;
  } catch (err) {
    console.error('[raw-html] 启动失败：', err);
    rawHtmlHost = null;
    return false;
  }
}

/**
 * 把前端脚本注入渲染层。
 * 渲染层需要三样东西才能接管正文，这里一次给全：
 *   __SEEK_EXT_HOST           宿主地址（资源走它）
 *   __seekReact               React 本体（引擎的 f 注入与 shim 都要）
 *   __SEEK_CONTENT_EXTENSION  渲染层提名的注册接口（register / renderMarkdown）
 * 任一缺失插件就静默退出，渲染层不受影响。
 */
async function injectRawHtml(win) {
  if (!rawHtmlHost || !win || win.isDestroyed()) return;
  try {
    const port = rawHtmlHost.getPort();
    const code = await readFile(join(RAWTML_SKILL_DIR, 'client', 'raw-html.js'), 'utf8');
    let trusted = false;
    try {
      trusted = JSON.parse(readFileSync(join(RAWTML_SKILL_DIR, 'enable.json'), 'utf8')).trusted === true;
    } catch { /* 读不到按安全模式 */ }
    const prelude = [
      `window.__SEEK_EXT_HOST = 'http://127.0.0.1:${port}';`,
      `window.__SEEK_RAW_HTML_TRUSTED = ${trusted};`,
      ';(function(){',
      '  try {',
      // 从渲染层提名的扩展点里取 React 与 markdown（渲染层主动挂出，非插件私有约定）
      '    var ext = window.__SEEK_CONTENT_EXTENSION;',
      '    if (ext && ext.react) window.__seekReact = ext.react;',
      '  } catch (e) {}',
      '})();',
      '',
    ].join('\n');
    await win.webContents.executeJavaScript(prelude + code, true);
    console.log('[raw-html] 前端已注入');
  } catch (err) {
    console.error('[raw-html] 注入失败：', err);
  }
}

/**
 * 等渲染层就绪再注入视觉卡片前端。
 *
 * 注入的前提是渲染层的 `__SEEK_CONTENT_EXTENSION` 已经挂出（插件要拿它的 React 与 markdown），
 * 而那是渲染层模块执行的结果，主进程无从直接观测——此前只能硬等一个固定延迟，
 * 短了名单还没挂上（注入静默失败）、长了每次开窗白等。
 *
 * 现在渲染层在挂出名单的同时广播事件 + 立一次性标志，这里两条路都走：
 *   · 标志已在 → 名单早已就绪，立即注入；
 *   · 否则挂事件监听，等广播到达；事件超时兜底重试，避免脚本异常时不注入。
 */
async function injectRawHtmlWhenReady(win) {
  if (!rawHtmlHost || !win || win.isDestroyed()) return;
  const READY_FLAG = 'window.__SEEK_CONTENT_EXTENSION_READY === true';
  try {
    if (await win.webContents.executeJavaScript(READY_FLAG, true)) {
      await injectRawHtml(win);
      return;
    }
    await win.webContents.executeJavaScript(
      `new Promise(function (resolve) {
         var done = false;
         function fire() { if (!done) { done = true; resolve(true); } }
         window.addEventListener('seek:content-extension-ready', fire, { once: true });
         // 兜底：脚本异常导致事件永不到达时，轮询标志（上限 5s），仍不就绪则放弃本轮
         var waited = 0;
         var timer = setInterval(function () {
           waited += 100;
           if (window.__SEEK_CONTENT_EXTENSION_READY === true || waited >= 5000) {
             clearInterval(timer); fire();
           }
         }, 100);
       })`,
      true,
    );
    if (!win.isDestroyed()) await injectRawHtml(win);
  } catch (err) {
    console.error('[raw-html] 等待渲染层就绪失败，改用直接注入：', err);
    void injectRawHtml(win);
  }
}



// ═════════════════════════════════════════════════════
// 主题皮肤（dsh-theme 移植）：DSH 皮肤加载器
//
// 把为 DSH（DeepSeek Harness）编写的第三方皮肤包原样加载进 seek-agent。
// 皮肤 CSS 依赖 DSH 的 DOM 契约（CSS Modules 局部名子串 + data-slot/data-* 钩子
// + --dsw-* 令牌），而 seek-agent 的 DOM 是另一套 id 体系——中间那层翻译由插件
// 的转义层（client/escape-layer.js + client/tokens.js）负责，皮肤本身一行不改。
//
// 与其它挂件同一套约定：宿主逻辑全在 skill 目录（host.mjs），这里只做
// 「读 enable.json → 动态 import → 起本地服务 → 注入前端」。删目录 = 整体卸载。
// ═════════════════════════════════════════════════════
const THEME_SKILL_DIR = join(__dirname, '..', 'src', 'tools', 'inner_skills', 'dsh-theme');
let themeHost = null;

/** 按 skill 的 enable.json 开关启动皮肤宿主；返回是否启动。 */
async function startDshTheme() {
  try {
    const enablePath = join(THEME_SKILL_DIR, 'enable.json');
    if (!existsSync(enablePath)) return false;
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(enablePath, 'utf8')); } catch { /* 配置损坏按默认处理 */ }
    if (cfg.enable === false) {
      console.log('[dsh-theme] 已禁用（enable.json: enable=false）');
      return false;
    }
    const { createDshThemeHost } = await import(pathToFileURL(join(THEME_SKILL_DIR, 'host.mjs')).href);
    themeHost = createDshThemeHost({ skillDir: THEME_SKILL_DIR, autoActivate: cfg.theme || '' });
    const { port } = await themeHost.start();
    installLocalHostRequestRewrite(port);
    const skins = await themeHost.listSkins();
    console.log(`[dsh-theme] 宿主已启动：http://127.0.0.1:${port}（皮肤 ${skins.length} 套：${skins.map(s => s.id).join(', ') || '无'}）`);
    return true;
  } catch (err) {
    console.error('[dsh-theme] 启动失败：', err);
    themeHost = null;
    return false;
  }
}

/**
 * 把皮肤加载器注入渲染层。
 * 渲染层需要两样东西：宿主地址（取皮肤包）与要激活的皮肤 id。
 * 加载器自身会装令牌层 + 转义层，因此注入时机须晚于渲染层首帧——
 * 否则打标目标还不存在（由 injectDshThemeWhenReady 负责等待）。
 */
async function injectDshTheme(win) {
  if (!themeHost || !win || win.isDestroyed()) return;
  try {
    const port = themeHost.getPort();
    let wanted = '';
    try {
      wanted = JSON.parse(readFileSync(join(THEME_SKILL_DIR, 'enable.json'), 'utf8')).theme || '';
    } catch { /* 读不到则不指定，加载器自选第一套 */ }
    const prelude = [
      // 专职变量，不复用共享的 __SEEK_EXT_HOST：那是「最后注入者胜」的槽，
      // 视觉卡片宿主（dsh-raw-html）也往里写自己的端口，谁晚注入谁把对方顶掉，
      // 皮肤加载器就会拿着卡片端口去要 /skins（404）。
      `window.__SEEK_THEME_HOST = 'http://127.0.0.1:${port}';`,
      `window.__SEEK_THEME_BOOT = ${JSON.stringify(wanted)};`,
    ].join('\n');
    await win.webContents.executeJavaScript(prelude, true);
    // 加载器是 ESM 模块图（theme-loader → escape-layer/tokens 互相 import），
    // 不能用 executeJavaScript 直接跑源码（非模块上下文里 import 会抛 SyntaxError）。
    // 宿主已把 client/ 目录挂成 /client/*，这里用动态 import 从宿主地址加载整个模块图。
    const handler = await win.webContents.executeJavaScript(
      `import('http://127.0.0.1:${port}/client/theme-loader.js')
         .then(function (mod) {
           window.__seekTheme = {
             list: mod.listSkins,
             activate: mod.activateSkin,
             deactivate: mod.deactivateSkin,
             current: mod.currentSkin,
             boot: mod.boot
           };
           return mod.boot();
         })
         .catch(function (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; })`,
      true);
    const result = handler;
    // 皮肤加载链路的运行时可观测性：把宿主地址、要激活的 id、加载结果一并落日志，
    // 免得「404 / 未就绪」这类失败只剩一句无头无尾的报错。
    console.log('[dsh-theme] 注入完成', {
      host: `http://127.0.0.1:${port}`,
      wanted,
      result,
    });
    // 设置面板「主题」栏目：注册到渲染层的设置扩展点（与皮肤加载解耦，失败不影响皮肤）
    try {
      const panelCode = await readFile(join(THEME_SKILL_DIR, 'client', 'settings-panel.js'), 'utf8');
      // 脚本自带「等扩展点就绪再注册」逻辑（幂等）；这里执行完再回读状态做自检，
      // 把「到底注没注上」变成可观测事实，而不是靠一句无条件的「已注册」日志。
      await win.webContents.executeJavaScript(panelCode, true);
      const probe = await win.webContents.executeJavaScript(
        `(function () {
           var ext = window.__SEEK_SETTINGS_EXTENSION;
           var registered = !!window.__seekThemePanelUnregister;
           var ready = !!(ext && typeof ext.register === 'function' && ext.react);
           var list = [];
           try { list = ext && ext.list ? ext.list().map(function (s) { return s.id; }) : []; } catch (e) {}
           return { registered: registered, ready: ready, sections: list };
         })()`, true);
      if (probe && probe.registered) {
        console.log(`[dsh-theme] 设置栏目「主题」已注册（当前栏目：${(probe.sections || []).join(', ') || '无'}）`);
      } else if (probe && probe.ready) {
        console.warn('[dsh-theme] 设置扩展点就绪但栏目未注册——请检查 settings-panel.js 是否报错');
      } else {
        console.warn('[dsh-theme] 设置扩展点尚未就绪，栏目待其就绪后自行补注册（ready=' + (probe && probe.ready) + '）');
      }
    } catch (err) {
      console.warn('[dsh-theme] 设置栏目注入失败（皮肤仍正常）：', err);
    }
    if (result && result.ok) {
      console.log(`[dsh-theme] 皮肤已激活：${result.name}（打标 ${result.stats ? result.stats.marked : 0} 处）`);
    } else {
      console.warn('[dsh-theme] 皮肤激活失败：', result && result.error);
    }
  } catch (err) {
    console.error('[dsh-theme] 注入失败：', err);
  }
}

/**
 * 等渲染层首帧就绪再注入皮肤。
 * 打标目标是 React 渲染出来的 DOM（#app / #left-sidebar / .input-bar-body …），
 * 过早注入会打到空容器上。这里轮询 #app 出现（上限 5s），就绪后立即注入。
 */
async function injectDshThemeWhenReady(win) {
  if (!themeHost || !win || win.isDestroyed()) return;
  try {
    await win.webContents.executeJavaScript(
      `new Promise(function (resolve) {
         if (document.getElementById('app')) return resolve(true);
         var waited = 0;
         var timer = setInterval(function () {
           waited += 100;
           if (document.getElementById('app') || waited >= 5000) {
             clearInterval(timer); resolve(true);
           }
         }, 100);
       })`,
      true,
    );
    if (!win.isDestroyed()) await injectDshTheme(win);
  } catch (err) {
    console.error('[dsh-theme] 等待渲染层就绪失败，改用直接注入：', err);
    void injectDshTheme(win);
  }
}


// ═════════════════════════════════════════════════════
// 大肥鱼桌宠（dsh-dafeiyu 移植）：桌面窗口型插件
//
// 与前两个挂件不同，桌宠不开 HTTP 宿主，而是直接开一个透明置顶窗。
// 状态来源是 agent 事件流：agent:message 里的消息喂给事件桥，
// 桥跑 DSH 版 CompanionReducer，产出的协议消息推给桌宠窗。
// ═════════════════════════════════════════════════════
const PET_SKILL_DIR = join(__dirname, '..', 'src', 'tools', 'inner_skills', 'dsh-dafeiyu');
let petHost = null;
let petStatus = null;

/** 按 skill 的 enable.json 开关启动桌宠；返回是否启动。 */
async function startPetWidget() {
  try {
    const enablePath = join(PET_SKILL_DIR, 'enable.json');
    if (!existsSync(enablePath)) return false;
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(enablePath, 'utf8')); } catch { /* 配置损坏按默认处理 */ }
    if (cfg.enable === false) {
      console.log('[dafeiyu] 桌宠已禁用（enable.json: enable=false）');
      return false;
    }
    const { createPetHost } = await import(pathToFileURL(join(PET_SKILL_DIR, 'pet-window.js')).href);
    const { createPetStatus } = await import(pathToFileURL(join(PET_SKILL_DIR, 'pet-status.js')).href);
    petStatus = createPetStatus();
    petHost = createPetHost({
      BrowserWindow,
      screen,
      reducedMotion: cfg.reducedMotion === true,
      status: petStatus,
    });
    await petHost.initBridge();
    const ok = await petHost.open();
    if (!ok) { petHost = null; return false; }
    petHost.applyConfig(cfg);
    console.log('[dafeiyu] 大肥鱼桌宠已启动');
    return true;
  } catch (err) {
    console.error('[dafeiyu] 启动失败：', err);
    petHost = null;
    return false;
  }
}

/**
 * 关闭桌宠窗。
 *
 * 桌宠是独立置顶窗，不属于主窗口的子窗：只关主窗的话它仍挂在桌面上，
 * BrowserWindow 列表非空 → window-all-closed 永不触发 → 应用退不出去，
 * 表现为「UI 没了、任务栏也没了，桌上还剩一条鱼」。所以关主窗时必须连带收它。
 * 宿主对象保留（含已加载的事件桥），macOS 重新拉起主窗时可再 open()。
 */
function closePetWidget() {
  if (!petHost) return;
  try {
    petHost.close();
  } catch (err) {
    console.error('[dafeiyu] 桌宠关闭失败：', err);
  }
}

// 桌宠窗发回的消息（素材就绪 / 桌面交互），仅用于状态记录与日志
ipcMain.on('dafeiyu:loaded', () => {
  console.log('[dafeiyu] 窗内素材已就绪');
});
ipcMain.on('dafeiyu:ready', () => {
  console.log('[dafeiyu] 窗内脚本已就绪');
});
ipcMain.on('dafeiyu:interact', (_e, kind) => {
  console.log(`[dafeiyu] 桌面交互：${kind}`);
});
// 拖拽：窗内上报增量位移，主进程移窗（避免 app-region 的延迟与吃点击问题）
ipcMain.on('dafeiyu:drag-move', (_e, payload) => {
  if (!petHost) return;
  petHost.dragMove(payload?.dx, payload?.dy);
});
ipcMain.on('dafeiyu:drag-end', () => {
  if (!petHost) return;
  petHost.dragEnd();
});

/** 把 seek-agent 的事件喂给桌宠事件桥。 */
let petLastLoggedState = '';
function bridgePetEvent(msg, sessionId) {
  if (!petHost) return;
  const bridge = petHost.getBridge();
  if (!bridge) return;
  try {
    bridge.handle({ ...msg, sessionId, sessionName: sessionDisplayName(sessionId) });
    // 状态变化打一行日志（同一状态不重复刷屏），便于排查桌宠为何不动
    const snap = petStatus ? petStatus.snapshot() : null;
    if (snap && snap.lastState && snap.lastState !== petLastLoggedState) {
      petLastLoggedState = snap.lastState;
      console.log(`[dafeiyu] 状态 → ${snap.lastState}：${snap.lastMessage || ''}`);
    }
  } catch (err) {
    console.error('[dafeiyu] 事件桥处理失败：', err);
  }
}

/**
 * 把 seek-agent 的 usage 转成 DSH 会话事件喂给插件算账。
 *
 * seek-agent 推的是「会话累计四桶」，插件按「每条 assistant/message = 一次调用」自己累加，
 * 口径差一层 —— 换算（取增量）在 skill 目录的 usage-cursor.mjs，缘由与边界见该文件。
 */
function bridgeWhaleUsage(sessionId, msg) {
  if (!whaleHost) return;
  try {
    const session = { id: sessionId, name: sessionDisplayName(sessionId) };
    if (msg.type === 'usage') {
      // 累计 → 增量的口径换算（详见 usage-cursor.mjs）
      const step = whaleUsageCursor ? whaleUsageCursor.take(sessionId, msg) : null;
      // 没有增量（例如同一轮里数值没变）就不发事件，免得给本轮掺入空步
      if (!step) return;
      whaleHost.emitSessionEvent(session, {
        type: 'assistant/message',
        data: {
          turn: whaleTurn,
          usage: step,
          message: { source: { model: whaleModelName() } },
        },
      });
      whaleTurnOpen = true;
    } else if (msg.type === 'state' && msg.processing === false && whaleTurnOpen) {
      whaleHost.emitSessionEvent(session, { type: 'turn/end', data: { turn: whaleTurn } });
      whaleTurnOpen = false;
      whaleTurn += 1;
    }
  } catch (err) {
    console.error('[whale] usage 桥接失败：', err);
  }
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
  // 鲸鱼娘：把每轮 usage 转发给假 DSH 宿主算账
  bridgeWhaleUsage(sessionId, msg);
  // 大肥鱼：把状态事件喂给桌宠事件桥
  bridgePetEvent(msg, sessionId);
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
      // 开发模式、或启用了本地挂件（需从 file:// 页面访问本地宿主 127.0.0.1）时放开跨源限制
      webSecurity: !isDev && !whaleHost && !memeHost,
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

  // ── 本地挂件：页面加载完成后注入前端 ──
  mainWindow.webContents.on('did-finish-load', () => {
    void injectWhaleWidget(mainWindow);
    void injectMemeWidget(mainWindow);
    void injectWorktable(mainWindow);
    // 视觉卡片：等渲染层广播「扩展点已提名」再注入（内容扩展点注册表就绪是硬前置）
    void injectRawHtmlWhenReady(mainWindow);
    // 主题皮肤：等首帧 DOM 渲染出来再注入（打标目标是 React 产出的真实节点）
    void injectDshThemeWhenReady(mainWindow);
  });
  // dev.mjs 用 vite build --watch，其 emptyOutDir 会瞬时清空 dist；首帧可能撞上而 ERR_FILE_NOT_FOUND。
  // 这里对 index.html 做有限重试，避免开发时白屏。
  let whaleLoadRetry = 0;
  mainWindow.webContents.on('did-fail-load', (_e, _code, _desc, validatedURL) => {
    if (whaleLoadRetry < 6 && String(validatedURL || '').includes('index.html')) {
      whaleLoadRetry += 1;
      setTimeout(() => { if (!mainWindow.isDestroyed()) mainWindow.loadFile(RENDERER_HTML); }, 400);
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    // 桌宠是独立窗口，不跟着主窗销毁；这里显式收掉，window-all-closed 才会如期触发
    closePetWidget();
  });
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
 * dirPath 支持两种形态：绝对路径（浏览任意挂载工作区，右侧文件面板用）；
 * 相对路径（相对当前活跃工作区根，旧语义兼容）。
 */
registerRpc('fs:readFileTree', async (dirPath) => {
  let targetDir;
  if (!dirPath) {
    targetDir = currentWorkDir;
  } else if (isAbsolute(dirPath)) {
    targetDir = dirPath;
  } else {
    targetDir = resolve(currentWorkDir, dirPath);
  }
  try {
    return buildFileTree(targetDir, '', 1);
  } catch (err) {
    return { error: err.message };
  }
});

/** 文本文件读写上限（2MB）：超出直接拒绝，避免大文件撑爆渲染层编辑器 */
const MAX_TEXT_FILE_SIZE = 2 * 1024 * 1024;

/** 解析编辑器目标文件：绝对路径直接用，相对路径按当前活跃工作区根解析 */
function resolveEditorPath(filePath) {
  if (!filePath || typeof filePath !== 'string') throw new Error('路径为空');
  return isAbsolute(filePath) ? filePath : resolve(currentWorkDir, filePath);
}

/** 二进制探测：前 8KB 出现 NUL 字节即视为二进制 */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * 读取文本文件内容（内嵌编辑器用）。
 * 返回 { ok, path, name, content, size, mtime } 或 { ok:false, error }，
 * 前端据此区分「加载失败」与「不支持的类型」，不必再做一层错误解析。
 */
registerRpc('fs:readFile', async (filePath) => {
  try {
    const target = resolveEditorPath(filePath);
    const st = statSync(target);
    if (st.isDirectory()) return { ok: false, error: '这是一个目录' };
    if (st.size > MAX_TEXT_FILE_SIZE) {
      return { ok: false, error: `文件过大（${(st.size / 1024 / 1024).toFixed(1)}MB），编辑器上限 2MB` };
    }
    const buf = readFileSync(target);
    if (looksBinary(buf)) return { ok: false, error: '二进制文件，暂不支持预览' };
    return {
      ok: true,
      path: target,
      name: basename(target),
      content: buf.toString('utf8'),
      size: st.size,
      mtime: st.mtimeMs,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** 写入文本文件（编辑器 Ctrl+S 保存；仅允许覆盖已存在文件，不做新建） */
registerRpc('fs:writeFile', async (payload = {}) => {
  try {
    const { path: filePath, content } = payload;
    const target = resolveEditorPath(filePath);
    if (typeof content !== 'string') return { ok: false, error: '内容格式错误' };
    if (!existsSync(target)) return { ok: false, error: '文件已不存在（暂不支持新建文件）' };
    if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_FILE_SIZE) {
      return { ok: false, error: '内容超出 2MB 上限' };
    }
    writeFileSync(target, content, 'utf8');
    const st = statSync(target);
    return { ok: true, path: target, size: st.size, mtime: st.mtimeMs };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * 回退一条改动记录（编辑器审查面板的「回退」按钮）。
 *
 * 与 agent 进程内的 undo_patch 工具不同：那条路径依赖内存撤销栈，跨进程不可达。
 * 这里直接读工作区的 .seek-agent/history/*.diff，按逆向 diff 还原文件内容，
 * 然后把该记录归档为 .reverted（.diff 后缀消失即不再出现在改动列表里）。
 *
 * payload.recordId 省略时取最近一条记录。
 */
registerRpc('history:undo', async (payload = {}) => {
  try {
    const historyDir = join(currentWorkDir, '.seek-agent', 'history');
    if (!existsSync(historyDir)) return { ok: false, error: '没有改动历史' };

    let names = readdirSync(historyDir).filter(n => n.endsWith('.diff')).sort();
    if (names.length === 0) return { ok: false, error: '没有可回退的改动' };
    const recordId = typeof payload?.recordId === 'string' ? payload.recordId : '';
    if (recordId) {
      const hit = names.find(n => n.replace(/\.diff$/, '') === recordId);
      if (!hit) return { ok: false, error: '指定的改动记录不存在（可能已被回退）' };
      names = [hit];
    }

    // 从最近往回找第一条能成功还原的记录：定位失败的（内容已被后续改动覆盖）跳过
    const skipped = [];
    for (let i = names.length - 1; i >= 0; i--) {
      const name = names[i];
      const full = join(historyDir, name);
      let raw;
      try { raw = readFileSync(full, 'utf8'); } catch { continue; }
      const meta = parsePatchMeta(raw);
      const diff = extractPatchBody(raw) ?? '';
      if (!meta?.filePath || !diff.trim()) { skipped.push(name); continue; }

      // 只动工作区内的文件（同编辑器 fs:writeFile 的沙箱口径）
      let target;
      try { target = resolveEditorPath(meta.filePath); } catch { skipped.push(name); continue; }
      if (!existsSync(target)) { skipped.push(name); continue; }

      let current;
      try { current = readFileSync(target, 'utf8'); } catch { skipped.push(name); continue; }
      // 编辑器内部统一 LF，还原后再按原文件行尾写回
      const eol = current.includes('\r\n') ? '\r\n' : current.includes('\r') ? '\r' : '\n';
      const normalized = current.replace(/\r\n?/g, '\n');

      let reverted;
      try {
        reverted = revertContent(normalized, diff);
      } catch (err) {
        if (err instanceof RevertError) { skipped.push(name); continue; }
        throw err;
      }

      writeFileSync(target, eol === '\n' ? reverted : reverted.replace(/\n/g, eol), 'utf8');
      // 归档：改后缀而非删除，保留痕迹便于人工恢复
      try { renameSync(full, `${full}.reverted`); } catch { /* 归档失败不影响回退结果 */ }

      return {
        ok: true,
        recordId: name.replace(/\.diff$/, ''),
        filePath: meta.filePath,
        skipped: skipped.length,
      };
    }

    return { ok: false, error: '找到的改动记录都无法对应当前文件内容，无法回退' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** 单条 diff 记录的正文上限（超出截断，避免整段历史撑爆 IPC 负载） */
const MAX_PATCH_DIFF_CHARS = 20000;

/** 单次查询的 diff 正文总预算：超出后只返回元信息（列表仍完整，差异视图降级为「无行级差异」） */
const MAX_PATCH_DIFF_BUDGET = 400 * 1024;

/** 历史文件名形如 20260628T173951-0buy.diff，前缀即时间戳；解析失败返回 0 */
function parseHistoryTs(name) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

/**
 * 列出 AI 的文件改动记录（读取活跃工作区根的 .seek-agent/history/*.diff）。
 * payload.since：毫秒时间戳，只返回其后的记录（「距上次审查」语义）；
 * payload.limit：条数上限。历史文件名按时间倒序排列，扫到早于 since 的即可停止。
 */
registerRpc('fs:listPatches', async (payload = {}) => {
  try {
    const since = Number(payload?.since) || 0;
    const limit = Math.min(Math.max(Number(payload?.limit) || 200, 1), 500);
    const historyDir = join(currentWorkDir, '.seek-agent', 'history');
    if (!existsSync(historyDir)) return { ok: true, entries: [] };

    const names = readdirSync(historyDir).filter(n => n.endsWith('.diff')).sort().reverse();
    const entries = [];
    let diffBudget = MAX_PATCH_DIFF_BUDGET;
    for (const name of names) {
      if (entries.length >= limit) break;
      const ts = parseHistoryTs(name);
      if (since && ts && ts <= since) break; // 倒序扫描：更早的都不必再读
      let raw;
      try { raw = readFileSync(join(historyDir, name), 'utf8'); } catch { continue; }
      // .diff 文件 = 元信息 JSON 头 + 分隔线 + unified diff 正文（见 patch-history.js）
      const meta = parsePatchMeta(raw);
      if (!meta || typeof meta.filePath !== 'string') continue;
      const body = extractPatchBody(raw) ?? '';
      const diff = diffBudget > 0 ? truncatePatchBody(body, Math.min(MAX_PATCH_DIFF_CHARS, diffBudget)) : '';
      diffBudget -= diff.length;
      entries.push({
        id: name.replace(/\.diff$/, ''),
        filePath: meta.filePath,
        timestamp: meta.timestamp || ts,
        type: meta.type || 'modify',
        description: meta.description || '',
        diff,
      });
    }
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, entries: [], error: err.message };
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
// ── 挂件插件管理（设置面板「插件」板块）──

/** 挂件插件清单：只列带 host.mjs 的 inner_skill（即需要主进程托管的插件）。 */
const WIDGET_PREFIXES = ['dsh-whale-widget', 'dsh-meme', 'dsh-dafeiyu', 'dsh-worktable', 'dsh-raw-html', 'dsh-theme'];
function listWidgetPlugins() {
  const skillsDir = join(ROOT, isPackaged ? 'agent' : 'src', 'tools', 'inner_skills');
  const out = [];
  for (const name of WIDGET_PREFIXES) {
    const dir = join(skillsDir, name);
    const enablePath = join(dir, 'enable.json');
    if (!existsSync(enablePath)) continue;
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(enablePath, 'utf8')); } catch { /* 配置损坏按默认处理 */ }
    // 配置值：剔除保留键（enable / label / description / configSchema / always_detectable）
    const RESERVED = new Set(['enable', 'label', 'description', 'configSchema', 'always_detectable']);
    const config = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (!RESERVED.has(k)) config[k] = v;
    }
    out.push({
      name,
      label: cfg.label || name,
      description: cfg.description || '',
      // 插件自声明的配置项 schema（enable.json 的 configSchema）；无声明则为空数组
      configSchema: Array.isArray(cfg.configSchema) ? cfg.configSchema : [],
      config,
      enabled: cfg.enable !== false,
      running: name === 'dsh-meme' ? !!memeHost
        : name === 'dsh-dafeiyu' ? !!(petHost && petHost.isOpen())
        : name === 'dsh-worktable' ? !!worktableHost
        : name === 'dsh-raw-html' ? !!rawHtmlHost
        : name === 'dsh-theme' ? !!themeHost
        : !!whaleHost,
      port: name === 'dsh-meme' ? (memeHost ? memeHost.getPort() : 0)
        : name === 'dsh-worktable' ? (worktableHost ? worktableHost.getPort() : 0)
        : name === 'dsh-raw-html' ? (rawHtmlHost ? rawHtmlHost.getPort() : 0)
        : name === 'dsh-theme' ? (themeHost ? themeHost.getPort() : 0)
        : name === 'dsh-dafeiyu' ? 0
        : (whaleHost ? whaleHost.getPort() : 0),
    });
  }
  return out;
}

/** 写回某插件的 enable 开关。 */
function setWidgetEnabled(name, enabled) {
  const skillsDir = join(ROOT, isPackaged ? 'agent' : 'src', 'tools', 'inner_skills');
  const enablePath = join(skillsDir, name, 'enable.json');
  if (!existsSync(enablePath)) throw new Error('插件不存在: ' + name);
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(enablePath, 'utf8')); } catch { /* 配置损坏则重建 */ }
  cfg.enable = !!enabled;
  writeFileSync(enablePath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return listWidgetPlugins();
}

// 桌宠自检：没有视觉检查手段时用来确认「窗口起来了 / 素材加载了 / 收到过状态」
registerRpc('pet:status', async () => ({
  ok: true,
  open: !!(petHost && petHost.isOpen()),
  ...(petStatus ? petStatus.snapshot() : {}),
}));

registerRpc('plugins:list', async () => ({ ok: true, plugins: listWidgetPlugins() }));

/**
 * 开关某插件的次级选项（现用于 dsh-raw-html 的 trusted）。
 * 只允许写入该插件自己声明的白名单键，避免前端传入任意键污染配置。
 */
const PLUGIN_OPTIONS = {
  'dsh-raw-html': {
    trusted: { type: 'boolean', label: '可信模式', hint: '允许卡片内 <script> 在隔离沙箱中执行（默认关）' },
  },
};

function setPluginOption(name, key, value) {
  const skillsDir = join(ROOT, isPackaged ? 'agent' : 'src', 'tools', 'inner_skills');
  const enablePath = join(skillsDir, name, 'enable.json');
  if (!existsSync(enablePath)) throw new Error('插件不存在: ' + name);
  const spec = PLUGIN_OPTIONS[name] && PLUGIN_OPTIONS[name][key];
  if (!spec) throw new Error('该插件无此选项: ' + key);
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(enablePath, 'utf8')); } catch { /* 配置损坏则重建 */ }
  cfg[key] = spec.type === 'boolean' ? (value === true || value === 'true') : value;
  writeFileSync(enablePath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return cfg;
}

registerRpc('plugins:setOption', async (name, key, value) => {
  try {
    const cfg = setPluginOption(String(name || ''), String(key || ''), value);
    // 次级选项改变效力需要重启宿主：直接提示前端刷新（不做热重启，避免半途状态）
    return { ok: true, config: cfg, restartRequired: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * 动态选项提供者：类型为 'skin' / 'enum' 等的字段，其候选值可能在运行时才可知
 * （如主题皮肤列表由 host 扫描得出）。这里按 key 给出候选项，前端据此渲染下拉。
 */
async function resolveFieldOptions(name, field) {
  if (field.type === 'skin') {
    if (!themeHost) return [];
    try {
      const skins = await themeHost.listSkins();
      return skins.map(s => ({ value: s.id, label: s.name || s.id }));
    } catch { return []; }
  }
  if (field.type === 'enum' && Array.isArray(field.values)) {
    return field.values.map(v => ({ value: v, label: v }));
  }
  return [];
}

/**
 * 统一插件配置写入。
 *
 * 校验只认插件自己声明的 configSchema：键必须在 schema 里、且按声明的类型/范围夹取，
 * 避免前端传入任意键污染 enable.json。返回值含 restartRequired 供前端提示。
 *
 * 副作用分发：某些插件的配置改动需要即时下发（桌宠改大小、主题换皮肤），
 * 这些「热应用」由本函数按插件名分派，写盘与生效是一体的，不给调用方留半吊子状态。
 */
async function applyPluginConfig(name, patch) {
  const skillsDir = join(ROOT, isPackaged ? 'agent' : 'src', 'tools', 'inner_skills');
  const enablePath = join(skillsDir, name, 'enable.json');
  if (!existsSync(enablePath)) throw new Error('插件不存在: ' + name);
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(enablePath, 'utf8')); } catch { /* 配置损坏则重建 */ }
  const schema = Array.isArray(cfg.configSchema) ? cfg.configSchema : [];
  const byKey = new Map(schema.map(f => [f.key, f]));

  for (const [key, raw] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
    const field = byKey.get(key);
    if (!field) throw new Error(`插件「${name}」无此配置项: ${key}`);
    if (field.type === 'boolean') {
      cfg[key] = raw === true || raw === 'true';
    } else if (field.type === 'number') {
      let n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`配置项 ${key} 需要数字`);
      if (typeof field.min === 'number') n = Math.max(field.min, n);
      if (typeof field.max === 'number') n = Math.min(field.max, n);
      cfg[key] = n;
    } else {
      cfg[key] = raw === null || raw === undefined ? '' : String(raw);
    }
  }
  writeFileSync(enablePath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

  // ── 热应用分派 ──
  let restartRequired = false;
  if (name === 'dsh-dafeiyu' && petHost) {
    // applyConfig 会在 scale 变化时一并重算窗口尺寸
    try { petHost.applyConfig(readPetConfig()); } catch { /* 窗口未起时无碍 */ }
  } else if (name === 'dsh-theme' && typeof patch?.theme === 'string') {
    // 皮肤是纯前端资源：直接驱动渲染层加载器热切换，无需重启宿主
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        await mainWindow.webContents.executeJavaScript(
          patch.theme
            ? `window.__seekTheme ? window.__seekTheme.activate(${JSON.stringify(patch.theme)}) : {ok:false,error:'加载器未就绪'}`
            : `window.__seekTheme ? window.__seekTheme.deactivate() : {ok:true}`,
          true);
      } catch { restartRequired = true; }
    } else {
      restartRequired = true;
    }
  } else {
    // 其余插件的配置在宿主启动时读取，需重启才会生效
    restartRequired = true;
  }
  return { config: cfg, restartRequired };
}

registerRpc('plugins:setConfig', async (name, patch) => {
  try {
    const res = await applyPluginConfig(String(name || ''), patch);
    return { ok: true, config: res.config, restartRequired: res.restartRequired, plugins: listWidgetPlugins() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** 取某插件的动态字段候选项（如主题皮肤列表）；前端渲染下拉前调用。 */
registerRpc('plugins:fieldOptions', async (name, key) => {
  try {
    const skillsDir = join(ROOT, isPackaged ? 'agent' : 'src', 'tools', 'inner_skills');
    const enablePath = join(skillsDir, String(name || ''), 'enable.json');
    const cfg = JSON.parse(readFileSync(enablePath, 'utf8'));
    const field = (cfg.configSchema || []).find(f => f.key === String(key || ''));
    if (!field) return { ok: false, error: '字段不存在' };
    return { ok: true, options: await resolveFieldOptions(String(name || ''), field) };
  } catch (err) {
    return { ok: false, error: err.message, options: [] };
  }
});

registerRpc('plugins:setEnabled', async (name, enabled) => {
  try {
    const plugins = setWidgetEnabled(String(name || ''), !!enabled);
    return { ok: true, plugins };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});


// ── 主题皮肤（dsh-theme）──
// 提供给设置面板「主题」栏：列皮肤、切皮肤。
// 切换写回 enable.json 并热切换渲染层皮肤（无需重启——皮肤是纯前端资源）。

registerRpc('theme:list', async () => {
  try {
    if (!themeHost) return { ok: true, enabled: false, skins: [], active: null };
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(join(THEME_SKILL_DIR, 'enable.json'), 'utf8')); } catch { /* 配置缺失 */ }
    const skins = await themeHost.listSkins();
    return { ok: true, enabled: cfg.enable !== false, skins, active: cfg.theme || null };
  } catch (err) {
    return { ok: false, error: err.message, skins: [] };
  }
});

registerRpc('theme:activate', async (id) => {
  try {
    const skinId = String(id || '');
    if (!themeHost) return { ok: false, error: '主题宿主未启动（检查 dsh-theme 是否启用）' };
    const skins = await themeHost.listSkins();
    if (skinId && !skins.some(s => s.id === skinId)) return { ok: false, error: '皮肤不存在: ' + skinId };
    // 写回 enable.json（下次启动仍生效）
    const enablePath = join(THEME_SKILL_DIR, 'enable.json');
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(enablePath, 'utf8')); } catch { /* 重建 */ }
    cfg.theme = skinId;
    writeFileSync(enablePath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    // 热切换：直接驱动渲染层加载器（皮肤全在前端，不需要重启宿主）
    if (skinId) {
      const result = await mainWindow.webContents.executeJavaScript(
        `window.__seekTheme ? window.__seekTheme.activate(${JSON.stringify(skinId)}) : {ok:false,error:'加载器未就绪'}`,
        true);
      if (!result || !result.ok) {
        return { ok: false, error: (result && result.error) || '皮肤激活失败', saved: true };
      }
      return { ok: true, active: skinId, name: result.name, stats: result.stats };
    }
    // 空 id = 卸载皮肤，恢复默认外观
    const off = await mainWindow.webContents.executeJavaScript(
      `window.__seekTheme ? window.__seekTheme.deactivate() : {ok:true}`
      , true);
    return { ok: true, active: '', deactivated: !!(off && off.ok) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** 桌宠可调项的白名单与范围，读写共用，避免前端传入越界值 */
const PET_CONFIG_SCHEMA = {
  scale:         { type: 'number', min: 0.3, max: 1.6, step: 0.05, label: '大小', hint: '桌宠显示比例' },
  speed:         { type: 'number', min: 0.25, max: 3, step: 0.05,  label: '动作速度', hint: '动画播放倍率：1 为素材原速（42ms/帧），2 为快一倍' },
  playbackFps:   { type: 'number', min: 24,  max: 144, step: 1,    label: '刷新帧率', hint: '换帧时机的精度上限；只影响画面顺滑度，不影响动作快慢（快慢请调「动作速度」）' },
  bubbleScale:   { type: 'number', min: 0.6, max: 1.6, step: 0.05, label: '气泡大小', hint: '对话气泡的缩放' },
  activityLevel: { type: 'enum', values: ['quiet', 'normal', 'lively'], label: '活跃度', hint: '空闲时做小动作的频率' },
  bubbleMode:    { type: 'enum', values: ['always', 'custom', 'hidden'], label: '气泡模式', hint: 'always 始终显示 / custom 仅特定状态 / hidden 不显示' },
  reducedMotion: { type: 'boolean', label: '减少动态', hint: '关闭拖拽、摸头等交互动画' },
  soundEnabled:  { type: 'boolean', label: '提示音', hint: '交互时是否发声' },
};

function petConfigPath() {
  return join(PET_SKILL_DIR, 'enable.json');
}

function readPetConfig() {
  try {
    return JSON.parse(readFileSync(petConfigPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writePetConfig(patch) {
  const cfg = readPetConfig();
  for (const [key, spec] of Object.entries(PET_CONFIG_SCHEMA)) {
    if (!(key in patch)) continue;
    const raw = patch[key];
    if (spec.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      cfg[key] = Math.min(spec.max, Math.max(spec.min, n));
    } else if (spec.type === 'boolean') {
      cfg[key] = raw === true || raw === 'true';
    } else if (spec.type === 'enum') {
      if (spec.values.includes(String(raw))) cfg[key] = String(raw);
    }
  }
  writeFileSync(petConfigPath(), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return cfg;
}

// 桌宠配置读写：保存后立即下发给运行中的窗口，不必重启
registerRpc('pet:getConfig', async () => {
  const cfg = readPetConfig();
  return { ok: true, config: cfg, schema: PET_CONFIG_SCHEMA, skillDir: PET_SKILL_DIR };
});

registerRpc('pet:setConfig', async (patch) => {
  try {
    const cfg = writePetConfig(patch && typeof patch === 'object' ? patch : {});
    if (petHost) {
      // applyConfig 内部会在 scale 变化时一并重算窗口尺寸，无需额外处理
      petHost.applyConfig(cfg);
    }
    return { ok: true, config: cfg };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

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


app.whenReady().then(async () => {
  // 迁移旧 session 数据到新文件夹结构（启动时一次，幂等）
  migrateLegacySessions();
  // 挂件宿主：按各 skill 的开关启动（须在 createWindow 之前，webSecurity 依赖它们）
  await startWhaleWidget();
  await startMemeWidget();
  await startWorktable();
  await startRawHtml();
  await startDshTheme();
  createWindow();
  // 桌宠是独立窗口，须在主窗口之后拉起（不依赖 webSecurity 放宽）
  await startPetWidget();
  // 启动会话：生成全新 session-xxxx-xxxx-xxxx 会话（不再固定 'default'，避免不同启动的聊天混入同一文件）
  currentSessionId = newSessionId();
  spawnAgent(currentSessionId);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      // 关主窗时已把桌宠一并收掉，重新拉起窗口时唤醒它（macOS 走这条路径）
      if (petHost && !petHost.isOpen()) void petHost.open();
    }
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










