/**
 * seek-mobile remote transport 适配层核心
 *
 * （与 seek-mobile/mobile/src/transport/remote-electron-api.ts 同源，复制到 seek-agent renderer 工程维护；
 *   改动时请保持两端同步。）
 *
 * 功能：构造一个与 seek-agent preload `window.electronAPI` 同形状的对象，
 * 内部通过 WebSocket（经中继服务器）与 Windows 端 seek-agent 通信。
 * renderer 组件零改动：`window.electronAPI = await createRemoteElectronAPI({ relayUrl, code })`
 *
 * 中继协议（JSON over WebSocket，与 relay-server/server.js 一致）：
 *   - 连上后发  {type:'auth', role:'remote', code}（成功信号：peer-online；失败：auth-error）
 *   - 配对成功收 {type:'peer-online'}；对端断开收 {type:'peer-offline'}
 *   - 应用层保活：每 20s 发 {type:'ping'}，中继回 {type:'pong'}；75s 无 pong 判定死连接，主动 close 触发自动重连
 *   - 业务消息统一包在 {type:'data', seq, payload} 信封中（payload 为远程 RPC 协议 JSON）
 *
 * 远程 RPC 协议（payload 内）：
 *   - 请求  {type:'rpc', id, method, params}
 *   - 响应  {type:'rpc-result', id, ok, data?|error?}
 *   - 事件  {type:'event', channel, payload}
 *
 * 纯 TS、无框架依赖：浏览器用原生 WebSocket；Node>=22 也有原生 WebSocket，
 * 也可通过 config.createSocket 注入 ws 包实现。
 */

import type {
  ConnectionStatus,
  ElectronAPI,
  ListPatchesResult,
  UndoPatchResult,
  ReadFileResult,
  RemoteElectronAPIConfig,
  StatusInfo,
  StatusListener,
  TrustedCredential,
  TrustGrantedPayload,
  TrustRevokedPayload,
  Unsubscribe,
  WebSocketLike,
  WriteFileResult,
} from './types.ts';

/** WebSocket.OPEN */
const WS_OPEN = 1;

/** 应用层心跳间隔：每 20s 发 {type:'ping'} 保活（浏览器 WebSocket 无法主动发 ws 层 ping，需应用层维持 TCP 活跃） */
const HEARTBEAT_INTERVAL_MS = 20000;
/** 应用层心跳超时：75s（约 3 个周期）无 pong 判定连接死亡，主动 close 触发自动重连 */
const HEARTBEAT_TIMEOUT_MS = 75000;

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

/** 默认 socket 工厂：使用全局 WebSocket（浏览器 / Node>=22） */
function defaultCreateSocket(url: string): WebSocketLike {
  const g = globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike };
  if (typeof g.WebSocket !== 'function') {
    throw new Error(
      '[remote-electron-api] 全局 WebSocket 不可用；请通过 config.createSocket 注入实现（Node <22 可用 ws 包）'
    );
  }
  return new g.WebSocket(url);
}

/**
 * 创建远程 electronAPI 适配对象。
 * 返回的 Promise 在「配对成功（收到 peer-online）」后 resolve；
 * 若配对码无效/过期（收到 auth-error）则 reject，并触发 onStatusChange('need-repair')。
 */
export function createRemoteElectronAPI(config: RemoteElectronAPIConfig): Promise<ElectronAPI> {
  return new RemoteTransport(config).init();
}

class RemoteTransport {
  private readonly relayUrl: string;
  private readonly deviceId?: string;
  private readonly trusted?: TrustedCredential;
  private readonly remoteId?: string;
  private readonly onTrustGrantedCb?: (info: TrustGrantedPayload) => void;
  private readonly onTrustRevokedCb?: (info: TrustRevokedPayload) => void;
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly rpcTimeoutMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly onStatusCb?: StatusListener;
  private readonly heartbeatIntervalMs: number; // 心跳发 ping 间隔（默认 HEARTBEAT_INTERVAL_MS=20s，测试可注入短值）
  private readonly heartbeatTimeoutMs: number; // 心跳超时判定（默认 HEARTBEAT_TIMEOUT_MS=75s，测试可注入短值）

  private code: string;

  private ws: WebSocketLike | null = null;
  private status: ConnectionStatus = 'connecting';

  private rpcSeq = 0;
  private dataSeq = 0;
  private readonly pendingRpc = new Map<number, PendingRpc>();

  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private readonly statusListeners = new Set<StatusListener>();

  private authResolve: ((api: ElectronAPI) => void) | null = null;
  private authReject: ((err: Error) => void) | null = null;
  private authSettled = false;

  private manualClose = false;
  private retryAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0; // 最近一次收到 pong 的时间戳（心跳存活判定依据）

  private api!: ElectronAPI;

  constructor(config: RemoteElectronAPIConfig) {
    this.relayUrl = config.relayUrl;
    this.code = (config.code ?? '').trim().toUpperCase();
    this.trusted = config.trusted;
    this.remoteId = config.remoteId;
    this.deviceId = config.deviceId;
    this.createSocket = config.createSocket ?? defaultCreateSocket;
    this.rpcTimeoutMs = config.rpcTimeoutMs ?? 15000;
    this.backoffBaseMs = config.backoffBaseMs ?? 1000;
    this.backoffMaxMs = config.backoffMaxMs ?? 30000;
    this.onStatusCb = config.onStatusChange;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.onTrustGrantedCb = config.onTrustGranted;
    this.onTrustRevokedCb = config.onTrustRevoked;
  }

  /** 构建 api 对象并开始连接；配对成功后 resolve，auth 失败 reject */
  init(): Promise<ElectronAPI> {
    this.api = this.buildApi();
    this.connect();
    return new Promise<ElectronAPI>((resolve, reject) => {
      this.authResolve = resolve;
      this.authReject = reject;
    });
  }

  // ---------------- 生命周期 ----------------

  /** 手动（重）连接；内部自动带重试 + 指数退避（1s/2s/4s…上限 30s） */
  connect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // 断开已有 socket（若有），保证从干净状态重连
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try {
        old.close(1000, 'reconnect');
      } catch {
        /* ignore */
      }
    }
    this.manualClose = false;
    this.setStatus('connecting', { attempt: this.retryAttempt });
    let ws: WebSocketLike;
    try {
      ws = this.createSocket(this.relayUrl);
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : String(err));
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.handleOpen();
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = (ev) => this.handleClose(ev);
    ws.onerror = () => {
      /* 连接错误统一由 onclose 收尾（WebSocket 规范：error 后必 close） */
    };
  }

  /** 主动断开：不再自动重连，挂起的 RPC 全部拒绝 */
  disconnect(): void {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending(new Error('[remote-electron-api] disconnected'));
    this.stopHeartbeat(); // 主动断开：停止心跳定时器
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, 'manual disconnect');
      } catch {
        /* ignore */
      }
    }
    this.setStatus('disconnected');
  }

  /** 更新配对码（need-repair 后用户重新扫码时调用），随后调用 connect() 重连 */
  setCode(code: string): void {
    this.code = code.trim().toUpperCase();
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  /** 订阅连接状态变化，返回退订函数 */
  onStatusChange(cb: StatusListener): Unsubscribe {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  private setStatus(status: ConnectionStatus, info?: StatusInfo): void {
    if (this.status === status && status !== 'connecting') return;
    this.status = status;
    const emit = (cb: StatusListener) => {
      try {
        cb(status, info);
      } catch {
        /* 回调异常不影响 transport 自身 */
      }
    };
    if (this.onStatusCb) emit(this.onStatusCb);
    for (const cb of [...this.statusListeners]) emit(cb);
  }

  // ---------------- 连接内部 ----------------
  /** 启动应用层心跳：连接建立即开始（auth 前/后都保活），每 heartbeatIntervalMs 发 {type:'ping'}；
   *  超过 heartbeatTimeoutMs 无 pong 判定连接死亡，主动 close(4000) 触发 handleClose → 自动重连 */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      this.sendRaw({ type: 'ping' });
      if (Date.now() - this.lastPongAt > this.heartbeatTimeoutMs) {
        // 判定死连接：主动关闭，触发 handleClose → scheduleReconnect（trusted 重连免密自动恢复）
        const ws = this.ws;
        if (ws && ws.readyState === WS_OPEN) {
          try {
            ws.close(4000, 'heartbeat timeout');
          } catch {
            /* ignore */
          }
        }
      }
    }, this.heartbeatIntervalMs);
  }

  /** 停止心跳定时器（任何关闭/断开路径都调用，防止泄漏） */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }


  private handleOpen(): void {
    // 连接建立后立即 auth（重连场景：重新 auth，code 可能已失效）
    this.setStatus('connecting', { message: 'authing' });
    this.startHeartbeat(); // 应用层心跳：连接建立即启动保活（重连时也会重新启动）
    if (this.trusted) {
      // ---- 免密直连：trusted 凭证认证（中继校验通过后直接配对，免输码） ----
      this.sendRaw({
        type: 'auth',
        role: 'remote',
        trusted: {
          relayDeviceId: this.trusted.relayDeviceId,
          remoteId: this.trusted.remoteId,
          token: this.trusted.token,
        },
      });
      return;
    }
    // ---- 码认证：带 remoteId（中继用其做 trust-list online 判定） ----
    const auth: Record<string, unknown> = {
      type: 'auth',
      role: 'remote',
      code: this.code,
    };
    if (this.remoteId) auth.remoteId = this.remoteId;
    if (this.deviceId) auth.deviceId = this.deviceId;
    this.sendRaw(auth);
  }

  private handleClose(ev: { code?: number; reason?: string }): void {
    this.ws = null;
    this.stopHeartbeat(); // 任何关闭路径都停止心跳（心跳判定死连接 close(4000) 也走这里）
    if (this.manualClose) return; // disconnect() 已处理
    if (this.status === 'need-repair') return; // 认证失败：等待用户重新扫码，不自动重试
    this.scheduleReconnect(`socket closed (code=${ev?.code ?? '?'} reason=${ev?.reason ?? ''})`);
  }

  private scheduleReconnect(reason: string): void {
    if (this.manualClose || this.status === 'need-repair') return;
    const delay = Math.min(this.backoffBaseMs * Math.pow(2, this.retryAttempt), this.backoffMaxMs);
    this.retryAttempt += 1;
    this.setStatus('connecting', { message: `reconnecting: ${reason}`, attempt: this.retryAttempt });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  // ---------------- 收发消息 ----------------

  /** 直接向中继发一条 JSON 消息（信封层） */
  private sendRaw(obj: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return;
    ws.send(JSON.stringify(obj));
  }

  /** 业务消息统一包中继 data 信封后发出 */
  private sendPayload(payload: unknown): void {
    this.sendRaw({ type: 'data', seq: ++this.dataSeq, payload });
  }

  private handleMessage(data: unknown): void {
    let text: string;
    if (typeof data === 'string') {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(data);
    } else if (ArrayBuffer.isView(data)) {
      text = new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } else {
      text = String(data);
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    this.dispatchMessage(msg);
  }

  private dispatchMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'ping':
        // 对端/中继发来 ping：回 pong 保活（双向心跳）
        this.sendRaw({ type: 'pong' });
        return;
      case 'pong':
        // 收到中继 pong：刷新存活时间戳（死连接判定依据）
        this.lastPongAt = Date.now();
        return;
      case 'data': {
        // 中继 data 信封：payload 为远程 RPC 协议消息
        const payload = msg.payload;
        if (payload && typeof payload === 'object') {
          this.dispatchMessage(payload as Record<string, unknown>);
        }
        return;
      }
      case 'auth-ok':
        // 码模式中继不发 auth-ok；免密直连模式中继会回 auth-ok trusted:true（随后 peer-online）。
        // 带 trusted:true 视为配对成功（防御，仍以 peer-online 为准）
        if (msg.trusted === true) this.handlePeerOnline();
        return;
      case 'trust-granted':
        this.handleTrustGranted(msg);
        return;
      case 'trust-revoked':
        this.handleTrustRevoked(msg);
        return;
      case 'auth-error':
        this.handleAuthError(typeof msg.message === 'string' ? msg.message : 'auth failed');
        return;
      case 'peer-online':
        this.handlePeerOnline();
        return;
      case 'peer-offline':
        this.handlePeerOffline();
        return;
      case 'rpc-result':
        this.handleRpcResult(msg);
        return;
      case 'event':
        this.handleEventPush(msg);
        return;
      default:
        // 中继的 {type:'error'} 等服务端消息：忽略（RPC 由超时兜底）
        return;
    }
  }

  private handleAuthError(message: string): void {
    // need-repair 语义：绝不再自动重连——先清掉任何已排定的重连（防御，防止极端时序下残留 timer）
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setStatus('need-repair', this.repairInfo(message));
    if (!this.authSettled) {
      this.authSettled = true;
      this.authReject?.(new Error(`[remote-electron-api] auth failed: ${message}`));
      this.authResolve = null;
      this.authReject = null;
    }
    // 关闭当前 socket（handleClose 见 need-repair 不再重连）
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(4003, 'auth failed');
      } catch {
        /* ignore */
      }
    }
  }

  /** 把中继 auth-error 原文映射为面向用户的明确提示（原文留 rawMessage 供调试） */
  private repairInfo(relayMsg: string): { message: string; rawMessage: string } {
    const m = relayMsg.toLowerCase();
    let message: string;
    if (m.includes('missing code')) {
      message = '配对码缺失，请重新输入配对码';
    } else if (m.includes('invalid') || m.includes('expired')) {
      message = '配对码已失效或已过期，请重新输入配对码';
    } else if (m.includes('unavailable')) {
      message = '配对失败：对端暂不可用，请在 Windows 端重新生成配对码后重试';
    } else {
      message = '配对失败，请重新输入配对码';
    }
    return { message, rawMessage: relayMsg };
  }

  private handlePeerOnline(): void {
    this.retryAttempt = 0;
    this.setStatus('paired');
    if (!this.authSettled) {
      this.authSettled = true;
      this.authResolve?.(this.api);
      this.authResolve = null;
      this.authReject = null;
    }
  }

  private handlePeerOffline(): void {
    // 对端（Windows 端）离线：本端仍连着中继，等待用户重新扫码（setCode + connect）
    this.setStatus('peer-offline', { message: 'peer disconnected' });
  }

  /** 收到 trust-granted（信任授予）：转发给 onTrustGranted 回调（context 用它保存设备） */
  private handleTrustGranted(msg: Record<string, unknown>): void {
    const relayDeviceId = typeof msg.relayDeviceId === 'string' ? msg.relayDeviceId : '';
    const remoteId = typeof msg.remoteId === 'string' ? msg.remoteId : '';
    const token = typeof msg.token === 'string' ? msg.token : '';
    const label = typeof msg.label === 'string' ? msg.label : undefined;
    if (!relayDeviceId || !remoteId || !token) return; // 缺关键字段：忽略
    try {
      this.onTrustGrantedCb?.({ relayDeviceId, remoteId, token, label });
    } catch {
      /* 回调异常不影响 transport 自身 */
    }
  }

  /** 收到 trust-revoked（信任撤销）：转发给 onTrustRevoked 回调（context 用它更新设备列表） */
  private handleTrustRevoked(msg: Record<string, unknown>): void {
    const remoteId = typeof msg.remoteId === 'string' ? msg.remoteId : undefined;
    const relayDeviceId = typeof msg.relayDeviceId === 'string' ? msg.relayDeviceId : undefined;
    try {
      this.onTrustRevokedCb?.({ remoteId, relayDeviceId });
    } catch {
      /* 回调异常不影响 transport 自身 */
    }
  }

  private handleRpcResult(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
    const pending = this.pendingRpc.get(id);
    if (!pending) return;
    this.pendingRpc.delete(id);
    clearTimeout(pending.timer);
    if (msg.ok === true) {
      pending.resolve(msg.data);
    } else {
      const errText = typeof msg.error === 'string' ? msg.error : `rpc error (id=${id})`;
      pending.reject(new Error(`[remote-electron-api] ${pending.method}: ${errText}`));
    }
  }

  private handleEventPush(msg: Record<string, unknown>): void {
    const channel = typeof msg.channel === 'string' ? msg.channel : '';
    if (!channel) return;
    const set = this.listeners.get(channel);
    if (!set || set.size === 0) return;
    for (const cb of [...set]) {
      try {
        cb(msg.payload);
      } catch {
        /* 单个监听器异常不影响其他监听器 */
      }
    }
  }

  // ---------------- RPC ----------------

  private invoke<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.status !== 'paired' || !this.ws || this.ws.readyState !== WS_OPEN) {
        reject(
          new Error(
            `[remote-electron-api] not connected (status=${this.status}); cannot invoke ${method}`
          )
        );
        return;
      }
      const id = ++this.rpcSeq;
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(
          new Error(
            `[remote-electron-api] rpc timeout: ${method} (id=${id}) after ${this.rpcTimeoutMs}ms`
          )
        );
      }, this.rpcTimeoutMs);
      this.pendingRpc.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      this.sendPayload({ type: 'rpc', id, method, params });
    });
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pendingRpc) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pendingRpc.clear();
  }

  // ---------------- 事件订阅 ----------------

  private on<T = unknown>(channel: string, cb: (payload: T) => void): Unsubscribe {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(cb as (payload: unknown) => void);
    return () => {
      set!.delete(cb as (payload: unknown) => void);
    };
  }

  // ---------------- api 对象 ----------------

  private buildApi(): ElectronAPI {
    const invoke = <T = unknown>(method: string, params: unknown[] = []) =>
      this.invoke<T>(method, params);

    return {
      // ---- 事件订阅（6 个直通 + onAgentStderr 注册默认空转发 + onMaximizedChange no-op） ----
      onAgentMessage: (cb) => this.on('agent:message', cb),
      onAgentStatus: (cb) => this.on('agent:status', cb),
      onAgentStderr: (cb) => this.on('agent:stderr', cb),
      onWorkdirChanged: (cb) => this.on('workdir:changed', cb),
      onSessionError: (cb) => this.on('agent:session-error', cb),
      onCollabEvent: (cb) => this.on('collab:event', cb),
      onMaximizedChange: () => () => {},

      // ---- A 直通：发送 ----
      sendInput: (content: string) => invoke<number>('sendInput', [content]),
      sendCommand: (cmd: string) => invoke<number>('sendCommand', [cmd]),
      abort: () => invoke<void>('abort'),
      restart: () => invoke<void>('restart'),

      // ---- A 直通：查询 ----
      getAgentStatus: () => invoke('getAgentStatus'),

      // ---- A 直通：工作区 ----
      getWorkdir: () => invoke<{ roots: string[]; active: string }>('getWorkdir'),
      setWorkdir: (dirPath: string) => invoke('setWorkdir', [dirPath]),
      setWorkspaceRoots: (payload: { roots: string[]; active?: string }) => invoke('setWorkspaceRoots', [payload]),
      addWorkspaceRoot: (dirPath: string) => invoke('addWorkspaceRoot', [{ path: dirPath }]),
      removeWorkspaceRoot: (dirPath: string) => invoke('removeWorkspaceRoot', [{ path: dirPath }]),
      getRecentDirs: () => invoke<string[]>('getRecentDirs'),

      // ---- A 直通：文件系统 ----
      readFileTree: (dirPath?: string) =>
        invoke('readFileTree', dirPath === undefined ? [] : [dirPath]),
      readGitStatus: () => invoke('readGitStatus'),
      readFile: (filePath: string) => invoke<ReadFileResult>('readFile', [filePath]),
      writeFile: (payload: { path: string; content: string }) => invoke<WriteFileResult>('writeFile', [payload]),
      listPatches: (payload?: { since?: number; limit?: number }) =>
        invoke<ListPatchesResult>('listPatches', payload === undefined ? [] : [payload]),
      undoPatch: (payload?: { recordId?: string }) =>
        invoke<UndoPatchResult>('undoPatch', payload === undefined ? [] : [payload]),
      getSkillsList: () => invoke('getSkillsList'),

      // ---- A 直通：会话 / 协作 ----
      listSessions: () => invoke('listSessions'),
      getCollabLog: () => invoke('getCollabLog'),
      saveSubagentSession: (data: Record<string, unknown>) => invoke('saveSubagentSession', [data]),
      switchSession: (sessionId: string, name?: string) =>
        invoke('switchSession', name === undefined ? [sessionId] : [sessionId, name]),
      newSession: () => invoke('newSession'),
      closeSession: (sessionId: string) => invoke('closeSession', [sessionId]),
      getCurrentSession: () => invoke('getCurrentSession'),
      listActiveSessions: () => invoke('listActiveSessions'),
      getSidebarStatic: () => invoke('getSidebarStatic'),
      readInstruction: (kind: string, file: string) => invoke('readInstruction', [kind, file]),

      // ---- .env 配置（env:read / env:write；handler 为同步返回，invoke 按 RPC 透传） ----
      getEnvConfig: () => invoke('getEnvConfig'),
      saveEnvConfig: (updates: Array<{ key: string; value: string }>) => invoke('saveEnvConfig', [updates]),

      // ---- B 降级：移动端无桌面对话框，返回取消语义（renderer 判 canceled 后自行降级） ----
      selectFolder: async () => ({ canceled: true, path: '' }),
      openFileDialog: async () => ({ canceled: true, files: [] }),

      // ---- C 忽略：窗口控制空实现 ----
      minimizeWindow: async () => {},
      maximizeWindow: async () => {},
      closeWindow: async () => {},
      isMaximized: async () => false,

      // ---- transport 生命周期扩展（renderer 不使用，不破坏同形） ----
      connect: () => this.connect(),
      disconnect: () => this.disconnect(),
      setCode: (code: string) => this.setCode(code),
      getStatus: () => this.getStatus(),
      onStatusChange: (cb: StatusListener) => this.onStatusChange(cb),

      // ---- 信任（trust）扩展：配对后 remote 主动发起 / 撤销信任 ----
      sendTrustRequest: (relayDeviceId: string, remoteId: string, label?: string) =>
        this.sendRaw({
          type: 'trust-request',
          relayDeviceId,
          remoteId,
          ...(label ? { label } : {}),
        }),
      sendTrustRevoke: (relayDeviceId: string, remoteId: string) =>
        this.sendRaw({ type: 'trust-revoke', relayDeviceId, remoteId }),
      // ---- Windows 端信任设备（手机端无此数据源，降级返回；保持与桌面契约同形） ----
      getRemoteDevices: async () => [],
      revokeRemoteDevice: async () => ({ ok: false, error: 'remote 端不支持撤销 Windows 端信任设备' }),
      onRemoteDevices: () => () => {},

    };
  }
}
































