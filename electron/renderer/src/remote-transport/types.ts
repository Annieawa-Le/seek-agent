/**
 * seek-mobile remote transport 类型定义
 *
 * （与 seek-mobile/mobile/src/transport/types.ts 同源，复制到 seek-agent renderer 工程维护；
 *   改动时请保持两端同步。）
 *
 * 目标：与 seek-agent preload 暴露的 `window.electronAPI` 形状一致，
 * 使 renderer 组件零改动即可运行在浏览器 / WebView 中。
 * （形状依据：electron/preload.cjs 暴露面 + electron/renderer/src/types/index.ts 契约）
 */

// ---------- 通用 ----------

/** 退订函数（与 preload 的 onXxx 返回一致） */
export type Unsubscribe = () => void;

/** 任意 JSON 值（中继对 payload 不解析，transport 原样透传） */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// ---------- transport 连接状态 ----------

export type ConnectionStatus =
  | 'connecting' // 正在连接中继 / 等待配对
  | 'paired' // 已配对（peer-online），可收发 RPC
  | 'peer-offline' // 对端（Windows 端）离线，但本端仍连着中继
  | 'disconnected' // 主动断开（disconnect 后）
  | 'need-repair'; // 配对码失效 / 认证失败，需用户重新扫码

export interface StatusInfo {
  /** 面向用户的展示文案（need-repair 时为中文明确提示） */
  message?: string;
  /** 自动重连尝试次数（从 1 起） */
  attempt?: number;
  /** 当前使用的配对码 */
  code?: string;
  /** 中继原始消息原文（调试用，如 auth-error 的 message 字段） */
  rawMessage?: string;
}

export type StatusListener = (status: ConnectionStatus, info?: StatusInfo) => void;

// ---------- WebSocket 抽象（浏览器原生 WebSocket 与 Node ws 均可适配） ----------

export interface WSCloseEvent {
  code?: number;
  reason?: string;
}

export interface WSMessageEvent {
  data: string | ArrayBuffer | ArrayBufferView | Blob;
}

/** transport 只依赖这一小撮 WebSocket 能力 */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onclose: ((ev: WSCloseEvent) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: WSMessageEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

// ---------- transport config ----------

/** 免密直连凭证：trusted 模式 auth 载荷（中继校验通过后直接配对，免输码） */
export interface TrustedCredential {
  /** Windows 端设备 id（relay 认证时上报的 deviceId） */
  relayDeviceId: string;
  /** 本机（手机）持久 id */
  remoteId: string;
  /** 信任令牌（64 hex），配对后由 trust-granted 下发 */
  token: string;
}

/** trust-granted（信任授予）消息载荷：remote 收到后保存设备列表 */
export interface TrustGrantedPayload {
  relayDeviceId: string;
  remoteId: string;
  token: string;
  label?: string;
}

/** trust-revoked（信任撤销）消息载荷：中继回执带 relayDeviceId，对端通知不带 */
export interface TrustRevokedPayload {
  remoteId?: string;
  relayDeviceId?: string;
}

/** 手机端已保存设备（设备列表 localStorage 条目） */
export interface SavedDevice {
  /** 中继地址（ws://...） */
  relayUrl: string;
  /** Windows 端设备 id（免密直连必需；未知时为空串） */
  relayDeviceId: string;
  /** 本机（手机）持久 id */
  remoteId: string;
  /** 信任令牌（已信任时有效） */
  token: string;
  /** 设备显示名（缺省为中继地址） */
  label: string;
  /** 是否已互信（免密直连可用） */
  trusted: boolean;
  /** 上次连接时间（ISO 字符串） */
  lastConnected: string;
}

export interface RemoteElectronAPIConfig {
  /** 中继服务器 WebSocket 地址，如 ws://127.0.0.1:8080 */
  relayUrl: string;
  /** Windows 端生成的 6 位配对码（码认证模式；与 trusted 二选一） */
  code?: string;
  /** 免密直连凭证（trusted 模式；与 code 二选一） */
  trusted?: TrustedCredential;
  /** 本机（手机）持久 id，随 auth 上报（中继用其做 trust-list online 判定） */
  remoteId?: string;
  /** 本机（手机）标识，可选，随 auth 上报（兼容旧字段） */
  deviceId?: string;
  /** 自定义 socket 工厂；默认使用全局 WebSocket（浏览器 / Node>=22 均可用） */
  createSocket?: (url: string) => WebSocketLike;
  /** 连接状态变化回调 */
  onStatusChange?: StatusListener;
  /** 收到 trust-granted（信任授予）回调：触发方保存设备到列表 */
  onTrustGranted?: (info: TrustGrantedPayload) => void;
  /** 收到 trust-revoked（信任撤销）回调：触发方更新设备列表 */
  onTrustRevoked?: (info: TrustRevokedPayload) => void;
  /** RPC 超时，默认 15000ms */
  rpcTimeoutMs?: number;
  /** 重试退避起始延迟，默认 1000ms */
  backoffBaseMs?: number;
  /** 应用层心跳发 ping 间隔，默认 20000ms（20s）；测试可注入短值 */
  heartbeatIntervalMs?: number;
  /** 应用层心跳超时判定，默认 75000ms（75s，约 3 个周期无 pong）；测试可注入短值 */
  heartbeatTimeoutMs?: number;
  /** 重试退避上限，默认 30000ms */
  backoffMaxMs?: number;
}

// ---------- 业务 payload 类型（宽松定义；transport 不校验，仅透传） ----------

export interface AgentMessagePayload {
  type: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface AgentStatusPayload {
  connected: boolean;
  code?: number;
  sessionId?: string;
  [key: string]: unknown;
}

export interface WorkdirChangedPayload {
  path?: string;
  [key: string]: unknown;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  [key: string]: unknown;
}

export interface GitChange {
  status: string;
  path: string;
  [key: string]: unknown;
}

/** 读取文本文件结果（与 renderer types/index.ts 契约一致） */
export interface ReadFileResult {
  ok: boolean;
  path?: string;
  name?: string;
  content?: string;
  size?: number;
  mtime?: number;
  error?: string;
}

/** 写入文本文件结果 */
export interface WriteFileResult {
  ok: boolean;
  path?: string;
  size?: number;
  mtime?: number;
  error?: string;
}

/** AI 改动记录（.seek-agent/history/*.diff 解析结果；与 renderer types/index.ts 契约一致） */
export interface PatchRecord {
  id: string;
  filePath: string;
  timestamp: number;
  type: 'add' | 'del' | 'modify' | 'replace' | 'batch';
  description: string;
  diff: string;
}

/** 列出 AI 改动记录的结果 */
export interface ListPatchesResult {
  ok: boolean;
  entries: PatchRecord[];
  error?: string;
}

/** 回退一条 AI 改动记录的结果 */
export interface UndoPatchResult {
  ok: boolean;
  recordId?: string;
  filePath?: string;
  skipped?: number;
  error?: string;
}

export interface Skill {
  name: string;
  [key: string]: unknown;
}

export interface SessionInfo {
  sessionId: string;
  name?: string;
  mtime?: number;
  [key: string]: unknown;
}

export interface CollabLogEntry {
  ts?: number;
  [key: string]: unknown;
}

export interface SidebarStaticData {
  skills?: unknown[];
  agents?: unknown[];
  instructions?: unknown[];
  mcp?: unknown;
  [key: string]: unknown;
}

export interface ActiveSession {
  sessionId: string;
  ready: boolean;
}

export interface WorkdirResult {
  success: boolean;
  error?: string;
  path?: string;
  roots?: string[];
  active?: string;
}

export interface SwitchSessionResult {
  success: boolean;
  error?: string;
  sessionId?: string;
  created?: boolean;
}

export interface NewSessionResult {
  success: boolean;
  sessionId?: string;
  error?: string;
}

export interface CloseSessionResult {
  success: boolean;
  error?: string;
}

export interface CurrentSessionResult {
  sessionId?: string;
}


export interface InstructionResult {
  content?: string;
  error?: string;
}

/** B 类降级：移动端无桌面目录选择框 */
export interface SelectFolderResult {
  canceled: boolean;
  path?: string;
}

/** B 类降级：移动端无桌面文件选择框 */
export interface OpenFileDialogResult {
  canceled: boolean;
  files?: string[];
}

// ---------- electronAPI 同形接口（transport 返回对象） ----------

export interface ElectronAPI {
  // ---- 事件订阅（8 个，返回退订函数） ----
  onAgentMessage(cb: (payload: AgentMessagePayload) => void): Unsubscribe;
  onAgentStatus(cb: (payload: AgentStatusPayload) => void): Unsubscribe;
  onAgentStderr(cb: (payload: unknown) => void): Unsubscribe;
  onWorkdirChanged(cb: (payload: WorkdirChangedPayload) => void): Unsubscribe;
  onSessionError(cb: (payload: unknown) => void): Unsubscribe;
  onSessionError(cb: (payload: unknown) => void): Unsubscribe;
  onCollabEvent(cb: (payload: unknown) => void): Unsubscribe;
  onRemotePairCode?(cb: (payload: { code: string; expiresIn: number }) => void): Unsubscribe;
  onRemoteStatus?(cb: (payload: { connected: boolean }) => void): Unsubscribe;
  onRemoteDevices?(cb: (payload: { devices: unknown[] }) => void): Unsubscribe;
  onMaximizedChange(cb: (payload: unknown) => void): Unsubscribe;

  // ---- 发送（A 直通，经 RPC） ----
  sendInput(content: string): Promise<number>;
  sendCommand(cmd: string): Promise<number>;
  abort(): Promise<void>;
  restart(): Promise<void>;

  // ---- 查询（A 直通） ----
  getAgentStatus(): Promise<AgentStatusPayload>;

  // ---- 工作区（A 直通 + B 降级 1 个） ----
  getWorkdir(): Promise<{ roots: string[]; active: string }>;
  setWorkdir(dirPath: string): Promise<WorkdirResult>;
  setWorkspaceRoots(payload: { roots: string[]; active?: string }): Promise<WorkdirResult>;
  addWorkspaceRoot(dirPath: string): Promise<WorkdirResult>;
  removeWorkspaceRoot(dirPath: string): Promise<WorkdirResult>;
  selectFolder(): Promise<SelectFolderResult>;
  getRecentDirs(): Promise<string[]>;

  // ---- 文件系统（A 直通 3 个 + B 降级 1 个） ----
  readFileTree(dirPath?: string): Promise<FileTreeNode[]>;
  readGitStatus(): Promise<GitChange[]>;
  readFile(filePath: string): Promise<ReadFileResult>;
  writeFile(payload: { path: string; content: string }): Promise<WriteFileResult>;
  listPatches(payload?: { since?: number; limit?: number }): Promise<ListPatchesResult>;
  undoPatch(payload?: { recordId?: string }): Promise<UndoPatchResult>;
  openFileDialog(): Promise<OpenFileDialogResult>;
  getSkillsList(): Promise<Skill[]>;

  // ---- 会话 / 协作（A 直通 9 个） ----
  listSessions(): Promise<SessionInfo[]>;
  getCollabLog(): Promise<CollabLogEntry[]>;
  saveSubagentSession(data: Record<string, unknown>): Promise<{ ok: boolean; path?: string; error?: string }>;
  switchSession(sessionId: string, name?: string): Promise<SwitchSessionResult>;
  newSession(): Promise<NewSessionResult>;
  closeSession(sessionId: string): Promise<CloseSessionResult>;
  getCurrentSession(): Promise<CurrentSessionResult>;
  listActiveSessions(): Promise<ActiveSession[]>;
  getSidebarStatic(): Promise<SidebarStaticData>;
  readInstruction(kind: string, file: string): Promise<InstructionResult>;
  getEnvConfig(): Promise<{ ok: boolean; path: string; items: Array<{ key: string; value: string; line: number }>; error?: string }>;
  saveEnvConfig(updates: Array<{ key: string; value: string }>): Promise<{ ok: boolean; path: string; written: string[]; error?: string }>;
  // ---- 窗口控制（C 忽略，空实现） ----
  minimizeWindow(): Promise<void>;
  maximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  isMaximized(): Promise<boolean>;

  // ---- transport 生命周期扩展（renderer 不使用，不破坏同形） ----
  connect(): void;
  disconnect(): void;
  setCode(code: string): void;
  getStatus(): ConnectionStatus;
  onStatusChange(cb: StatusListener): Unsubscribe;
  // ---- 信任（trust）扩展：配对后 remote 主动发起 / 撤销信任 ----
  getRemoteDevices(): Promise<unknown[] | { error?: string; devices?: unknown[] }>;
  revokeRemoteDevice(remoteId: string): Promise<{ ok?: boolean; sent?: boolean; error?: string }>;
  sendTrustRequest(relayDeviceId: string, remoteId: string, label?: string): void;
  sendTrustRevoke(relayDeviceId: string, remoteId: string): void;
}





















