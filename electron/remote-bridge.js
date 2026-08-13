/**
 * electron/remote-bridge.js — Windows 端 RemoteBridge（远程接入层，ESM）
 *
 * 桥接 seek-agent（relay 端）↔ 腾讯云中继（relay-server）↔ Android 手机（remote 端）。
 * Windows 端是 WS 客户端（主动出站连接中继），只做薄桥：
 *   - 连中继 → auth(relay) → pair-request → 拿到配对码后广播给桌面 UI（remote:pair-code）；
 *   - 手机端用码连入后收 peer-online，断开收 peer-offline（广播 remote:status）；
 *   - 手机端 RPC 请求（type:'rpc'）→ 路由到 main.js 注入的 routeToCurrent / restartCurrentAgent /
 *     invokeHandler，统一回 {type:'rpc-result', id, ok, data|error}；
 *   - main.js 事件推送（agent:message / agent:status / …）→ 经 sendEvent 原样转发（薄桥，不解析内容）；
 *   - 断线自动重连（指数退避 1s/2s/4s/… 上限 30s），重连后重新 auth；若中继侧原 remote 仍在线，
 *     收 relink-restored 自动恢复配对（不发 pair-request），否则正常 auth-ok → pair-request。
 *
 * 中继信封：{ type:'data', seq, payload }，payload 为业务消息（rpc / rpc-result / event），
 * 中继不解析 payload，原样转发。
 *
 * 环境变量：SEEK_RELAY_URL（ws://host:port，不设则不启动）、SEEK_DEVICE_ID（默认 seek-windows-001）。
 *
 * 设计为可独立实例化测试：startRemoteBridge 注入的依赖（routeToCurrent / restartCurrentAgent /
 * invokeHandler / broadcastEvent）在测试中用 mock 实现，不起 Electron 即可验证核心逻辑。
 */

import { WebSocket } from 'ws';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RECONNECT_BASE_MS = 1000; // 指数退避基数
const RECONNECT_MAX_MS = 30000; // 退避上限
const KEEPALIVE_INTERVAL_MS = 25000; // 客户端主动 ping 间隔（服务端 15s ping，此处双保险）

/** 业务 RPC 的「路由类」方法名 → main.js 注入的动作 */
const ROUTE_METHODS = new Set(['sendInput', 'sendCommand', 'abort', 'restart']);

/** 默认信任设备持久化文件（相对 electron/ 目录；main.js 可注入更合适的路径） */
function defaultTrustedDevicesFile() {
  return join(__dirname, 'trusted-devices.json');
}

export class RemoteBridge {
  /**
   * @param {object} opts
   * @param {string} opts.relayUrl  中继地址，如 ws://localhost:8080
   * @param {string} [opts.deviceId]  设备标识，默认 seek-windows-001
   * @param {Function} opts.routeToCurrent  输入路由：(msg) => void，msg 为 {type:'input'|'command'|'abort',...}
   * @param {Function} opts.restartCurrentAgent  重启当前 agent：() => void
   * @param {Function} opts.invokeHandler  查询分发：(method, params) => Promise<any>，返回查询结果
   * @param {Function} opts.broadcastEvent  桌面事件广播：(channel, payload) => void（main.js 注入 broadcastToClients）
   * @param {string} [opts.trustedDevicesFile]  信任设备持久化文件路径（默认 electron/trusted-devices.json）
   * @param {Function} [opts.log]  日志（默认 console.log）
   * @param {Function} [opts.warn]  告警（默认 console.warn）
   */
  constructor({ relayUrl, deviceId = 'seek-windows-001', routeToCurrent, restartCurrentAgent, invokeHandler, broadcastEvent, trustedDevicesFile, log = (...a) => console.log('[remote]', ...a), warn = (...a) => console.warn('[remote]', ...a) }) {
    if (!relayUrl) throw new Error('RemoteBridge: relayUrl is required');
    this.relayUrl = relayUrl;
    this.deviceId = deviceId;
    this.routeToCurrent = routeToCurrent;
    this.restartCurrentAgent = restartCurrentAgent;
    this.invokeHandler = invokeHandler;
    this.broadcastEvent = broadcastEvent;
    this.log = log;
    this.warn = warn;

    // 信任设备（本地持久化）：devices 为 [{remoteId, label, token, trustedAt}]，onlineMap 为最近 trust-list 的在线状态
    this.trustedDevicesFile = trustedDevicesFile || defaultTrustedDevicesFile();
    this.devices = [];
    this.onlineMap = {};
    this.loadTrustedDevices();

    this.ws = null;
    this.stopped = false;        // 主动 stop 标记（不再重连）
    this.connected = false;      // 与中继的 TCP/WS 连接是否建立
    this.peerOnline = false;     // 是否已与手机端配对成功
    this.pairCode = null;        // 最近一次拿到的配对码
    this.seq = 0;                // data 信封 seq 计数
    this.reconnectAttempt = 0;   // 连续重连次数（用于退避）
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
  }

  /** 启动：连接中继并开始 auth/pair 流程 */
  start() {
    this.stopped = false;
    this.connect();
    return this;
  }

  /** 停止：关闭连接并取消重连（main.js 退出时调用） */
  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    this.peerOnline = false;
    try {
      if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'bridge stopped');
    } catch { /* ignore */ }
  }

  /** 建立 WS 连接 */
  connect() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new WebSocket(this.relayUrl);
    } catch (err) {
      this.warn(`connect failed: ${err.message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => this.handleOpen());
    ws.on('message', (data) => this.handleMessage(data));
    ws.on('close', (code, reason) => this.handleClose(code, reason));
    ws.on('error', (err) => this.warn(`ws error: ${err.message}`));
  }

  handleOpen() {
    this.connected = true;
    this.reconnectAttempt = 0;
    this.log(`connected to relay ${this.relayUrl} (device=${this.deviceId})`);
    // 1. 认证为 relay 端
    this.sendRaw({ type: 'auth', role: 'relay', deviceId: this.deviceId, token: process.env.SEEK_RELAY_TOKEN || '' });
    // 客户端主动 ping，保持连接活跃（服务端每 30s ping，此处兜底防代理超时）
    this.keepaliveTimer = setInterval(() => {
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.ping();
      } catch { /* ignore */ }
    }, KEEPALIVE_INTERVAL_MS);
    if (this.keepaliveTimer.unref) this.keepaliveTimer.unref();
  }

  handleClose(code, reason) {
    const wasPeerOnline = this.peerOnline;
    const wasConnected = this.connected;
    this.connected = false;
    this.peerOnline = false;
    this.pairCode = null;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    if (wasConnected || wasPeerOnline) {
      this.log(`disconnected (code=${code}${reason ? ' ' + reason : ''})`);
    }
    // 配对中掉线 → 通知桌面 UI 断开
    if (wasPeerOnline) this.broadcastEvent('remote:status', { connected: false });
    if (!this.stopped) this.scheduleReconnect();
  }

  /** 指数退避重连：1s / 2s / 4s / … 上限 30s */
  scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    this.log(`reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  /** 发送中继信封外消息（auth / pair-request / data） */
  sendRaw(obj) {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(obj));
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  /** 发送 data 信封（payload 为业务消息），返回是否发送成功 */
  sendData(payload) {
    if (!this.peerOnline) return false;
    const seq = ++this.seq;
    return this.sendRaw({ type: 'data', seq, payload });
  }

  /**
   * Windows → 手机事件推送：把 main.js 事件（agent:message / agent:status / …）原样转发。
   * 薄桥：不解析、不修改 payload 内容。
   * 仅配对成功后发送；未配对时静默丢弃。
   */
  sendEvent(channel, payload) {
    if (!this.peerOnline) return false;
    return this.sendData({ type: 'event', channel, payload });
  }

  handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this.warn('invalid json from relay');
      return;
    }
    switch (msg.type) {
      case 'auth-ok':
        this.log(`auth ok as relay (device=${this.deviceId})`);
        // 2. 申请配对码
        this.sendRaw({ type: 'pair-request', deviceId: this.deviceId });
        break;
      case 'auth-error':
        this.warn(`auth error: ${msg.message}`);
        break;
      case 'pair-code':
        this.pairCode = msg.code;
        this.log(`pair code: ${msg.code} (expiresIn=${msg.expiresIn}s)`);
        // 3. 广播给桌面 UI 显示配对码（渲染层暂无监听也没关系，先广播 + 日志）
        this.broadcastEvent('remote:pair-code', { code: msg.code, expiresIn: msg.expiresIn });
        break;
      case 'relink-restored':
        // 中继侧恢复配对成功：直接回到 peer-online 状态，不再申请新配对码
        this.peerOnline = true;
        this.pairCode = msg.code || this.pairCode;
        this.log(`relink restored (code=${msg.code})`);
        this.broadcastEvent('remote:status', { connected: true });
        break;
      case 'peer-online':
        this.peerOnline = true;
        this.log(`peer online (code=${msg.code})`);
        this.broadcastEvent('remote:status', { connected: true });
        break;
      case 'peer-offline':
        this.peerOnline = false;
        this.log(`peer offline (${msg.reason || 'peer disconnected'})`);
        this.broadcastEvent('remote:status', { connected: false });
        break;
      case 'data':
        this.handleDataPayload(msg.payload);
        break;
      case 'trust-list':
        this.handleTrustList(msg);
        break;
      case 'trust-updated':
      case 'trust-granted':
        // trust-updated：remote 发起信任时中继通知 relay（含 token）；trust-granted：relay 主动信任方向（兜底，字段同构）
        this.handleTrustUpdated(msg);
        break;
      case 'trust-revoked':
        this.handleTrustRevoked(msg);
        break;
      case 'error':
        this.warn(`relay error: ${msg.message}`);
        break;
      default:
        this.warn(`unhandled relay message: ${msg.type}`);
    }
  }

  // ═════════════════════════════════════════════════════════
  // 信任设备管理（trust-list / trust-updated / trust-revoked / trust-revoke）
  // ═════════════════════════════════════════════════════════

  /** 读取本地信任设备 JSON（不存在或损坏 → 空列表） */
  loadTrustedDevices() {
    try {
      if (existsSync(this.trustedDevicesFile)) {
        const parsed = JSON.parse(readFileSync(this.trustedDevicesFile, 'utf8'));
        if (parsed && Array.isArray(parsed.devices)) {
          this.devices = parsed.devices
            .filter(d => d && typeof d.remoteId === 'string' && d.remoteId)
            .map(d => ({
              remoteId: d.remoteId,
              label: typeof d.label === 'string' ? d.label : '',
              token: typeof d.token === 'string' ? d.token : '',
              trustedAt: typeof d.trustedAt === 'string' ? d.trustedAt : null,
            }));
        }
      }
    } catch (err) {
      this.warn(`failed to load trusted devices: ${err.message}`);
      this.devices = [];
    }
  }

  /** 写入本地信任设备 JSON（自动建目录） */
  saveTrustedDevices() {
    try {
      const dir = dirname(this.trustedDevicesFile);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.trustedDevicesFile, JSON.stringify({ devices: this.devices }, null, 2), 'utf8');
    } catch (err) {
      this.warn(`failed to save trusted devices: ${err.message}`);
    }
  }

  /** 把当前设备列表广播给桌面 UI（remote:devices，不含 token） */
  broadcastDevices() {
    try {
      this.broadcastEvent('remote:devices', { devices: this.getTrustedDevices() });
    } catch (err) {
      this.warn(`broadcast devices failed: ${err.message}`);
    }
  }

  /**
   * 返回本地信任设备列表（含 online 状态，不含 token，避免凭证泄漏给渲染层）。
   * online 来自最近一次 trust-list 的 items 合并；未收到过 trust-list 时默认离线。
   * @returns {Array<{remoteId:string, label:string, online:boolean, trustedAt:string|null}>}
   */
  getTrustedDevices() {
    return this.devices.map(d => ({
      remoteId: d.remoteId,
      label: d.label || '',
      online: !!this.onlineMap[d.remoteId],
      trustedAt: d.trustedAt || null,
    }));
  }

  /**
   * 撤销对某设备的信任：发 trust-revoke（中继删除凭证）+ 本地立即删除并广播。
   * 中继会回 trust-revoked 回执，本地删除幂等（双保险）。
   * @param {string} remoteId
   * @returns {{ok:boolean, sent:boolean}}
   */
  revokeTrustedDevice(remoteId) {
    const id = typeof remoteId === 'string' ? remoteId.trim() : '';
    if (!id) return { ok: false, error: 'missing remoteId' };
    const sent = this.sendRaw({ type: 'trust-revoke', relayDeviceId: this.deviceId, remoteId: id });
    const before = this.devices.length;
    this.devices = this.devices.filter(d => d.remoteId !== id);
    delete this.onlineMap[id];
    if (this.devices.length !== before) this.saveTrustedDevices();
    this.broadcastDevices();
    this.log(`revoke trusted device ${id} (sent=${sent})`);
    return { ok: true, sent };
  }

  /**
   * relay 主动信任某 remote（可选）：发 trust-request，中继生成 token 并通知对端。
   * 当前协议 relay 发起时不回执，本地设备列表由后续 trust-list 推送同步。
   * @param {string} remoteId
   * @param {string} [label]
   * @returns {{ok:boolean, sent:boolean}}
   */
  sendTrustRequest(remoteId, label) {
    const id = typeof remoteId === 'string' ? remoteId.trim() : '';
    if (!id) return { ok: false, error: 'missing remoteId' };
    const sent = this.sendRaw({ type: 'trust-request', remoteId: id, label: typeof label === 'string' ? label : '' });
    return { ok: true, sent };
  }

  /** 主动向中继拉取最新信任列表（收到 trust-list 后自动更新本地 + 广播） */
  refreshTrustDevices() {
    return this.sendRaw({ type: 'trust-list' });
  }

  /** trust-list：合并本地设备（label/createdAt，trust-list 不含 token）→ online 状态 → 广播；中继侧已删除的设备同步移除 */
  handleTrustList(msg) {
    const items = Array.isArray(msg.items) ? msg.items : [];
    const online = {};
    const seen = new Set();
    for (const it of items) {
      const remoteId = it && typeof it.remoteId === 'string' ? it.remoteId.trim() : '';
      if (!remoteId) continue;
      seen.add(remoteId);
      online[remoteId] = !!it.online;
      const existing = this.devices.find(d => d.remoteId === remoteId);
      if (existing) {
        if (typeof it.label === 'string' && it.label) existing.label = it.label;
        if (typeof it.createdAt === 'string' && it.createdAt && !existing.trustedAt) existing.trustedAt = it.createdAt;
      } else {
        // trust-list 不含 token：仅记录设备信息，token 待 trust-updated 补充
        this.devices.push({
          remoteId,
          label: it && typeof it.label === 'string' ? it.label : '',
          token: '',
          trustedAt: it && typeof it.createdAt === 'string' ? it.createdAt : new Date().toISOString(),
        });
      }
    }
    const before = this.devices.length;
    this.devices = this.devices.filter(d => seen.has(d.remoteId));
    if (this.devices.length !== before) this.saveTrustedDevices();
    this.onlineMap = online;
    this.broadcastDevices();
  }

  /** trust-updated / trust-granted：保存或更新本地设备（含 token）并广播 */
  handleTrustUpdated(msg) {
    const remoteId = msg && typeof msg.remoteId === 'string' ? msg.remoteId.trim() : '';
    if (!remoteId) return;
    const existing = this.devices.find(d => d.remoteId === remoteId);
    if (existing) {
      if (typeof msg.label === 'string' && msg.label) existing.label = msg.label;
      if (typeof msg.token === 'string' && msg.token) existing.token = msg.token;
    } else {
      this.devices.push({
        remoteId,
        label: msg && typeof msg.label === 'string' ? msg.label : '',
        token: msg && typeof msg.token === 'string' ? msg.token : '',
        trustedAt: new Date().toISOString(),
      });
    }
    this.saveTrustedDevices();
    this.broadcastDevices();
  }

  /** trust-revoked：本地删除该设备并广播（幂等；撤销回执也走此路径） */
  handleTrustRevoked(msg) {
    const remoteId = msg && typeof msg.remoteId === 'string' ? msg.remoteId.trim() : '';
    if (!remoteId) return;
    const before = this.devices.length;
    this.devices = this.devices.filter(d => d.remoteId !== remoteId);
    delete this.onlineMap[remoteId];
    if (this.devices.length !== before) this.saveTrustedDevices();
    this.broadcastDevices();
  }

  handleDataPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'rpc') {
      this.handleRpc(payload);
    }
    // rpc-result / event 是 Windows 主动发出的，relay 端收到后忽略（对端不会发来）
  }

  async handleRpc(msg) {
    const id = msg.id;
    const method = msg.method;
    const params = Array.isArray(msg.params) ? msg.params : [];
    try {
      let data;
      if (method === 'sendInput' || method === 'sendCommand') {
        // params: [content, id] / [cmd, id]
        const [arg, msgId] = params;
        this.routeToCurrent({
          type: method === 'sendInput' ? 'input' : 'command',
          ...(method === 'sendInput' ? { content: arg } : { cmd: arg }),
          ...(msgId !== undefined ? { id: msgId } : {}),
        });
        data = { success: true };
      } else if (method === 'abort') {
        this.routeToCurrent({ type: 'abort' });
        data = { success: true };
      } else if (method === 'restart') {
        this.restartCurrentAgent();
        data = { success: true };
      } else if (typeof this.invokeHandler === 'function') {
        // 查询类：main.js 分发到抽出的业务函数（可能返回 Promise）
        data = await this.invokeHandler(method, params);
      } else {
        throw new Error(`unknown rpc method: ${method}`);
      }
      this.sendData({ type: 'rpc-result', id, ok: true, data });
    } catch (err) {
      this.sendData({ type: 'rpc-result', id, ok: false, error: String((err && err.message) || err) });
    }
  }
}

/**
 * 启动 RemoteBridge（由 main.js 调用）。
 * 注入依赖：routeToCurrent / restartCurrentAgent / invokeHandler / broadcastEvent / trustedDevicesFile。
 * relayUrl / deviceId 可显式传入，缺省回退到环境变量 SEEK_RELAY_URL / SEEK_DEVICE_ID。
 * SEEK_RELAY_URL 未设置时返回 null（RemoteBridge 不启动，main.js 行为完全不变）。
 *
 * @returns {RemoteBridge|null}
 */
export function startRemoteBridge({ relayUrl, deviceId, routeToCurrent, restartCurrentAgent, invokeHandler, broadcastEvent, trustedDevicesFile, log, warn } = {}) {
  const url = relayUrl || process.env.SEEK_RELAY_URL;
  if (!url) return null;
  const devId = deviceId || process.env.SEEK_DEVICE_ID || 'seek-windows-001';
  const bridge = new RemoteBridge({
    relayUrl: url,
    deviceId: devId,
    routeToCurrent,
    restartCurrentAgent,
    invokeHandler,
    broadcastEvent,
    trustedDevicesFile,
    log,
    warn,
  });
  bridge.start();
  return bridge;
}

export default RemoteBridge;










