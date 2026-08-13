/** Electron API 桥接类型 */
export interface ElectronAPI {
  onAgentMessage: (callback: (msg: AgentMessage) => void) => () => void;
  getAgentStatus: () => Promise<{ connected: boolean }>;
  onAgentStatus: (callback: (status: AgentStatus) => void) => () => void;
  onAgentStderr: (callback: (text: string) => void) => () => void;
  onWorkdirChanged: (callback: (path: string) => void) => () => void;
  /** 监听会话 Agent 后台拉起失败（session:new / session:switch 异步化后的兜底） */
  onSessionError: (callback: (data: { sessionId: string; error: string }) => void) => () => void;
  sendInput: (content: string) => number;
  sendCommand: (cmd: string) => number;
  abort: () => void;
  restart: () => void;
  getWorkdir: () => Promise<string>;
  setWorkdir: (dirPath: string) => Promise<{ success?: boolean; error?: string; path?: string }>;
  selectFolder: () => Promise<{ canceled: boolean; path?: string; error?: string }>;
  /** 打开系统对话框选择附件文件（支持多选） */
  openFileDialog: () => Promise<{ canceled: boolean; files: string[]; error?: string }>;
  getRecentDirs: () => Promise<string[]>;
  readFileTree: (dirPath: string) => Promise<FileTreeNode[]>;
  readGitStatus: () => Promise<GitChange[]>;
  listSessions: () => Promise<SessionInfo[]>;

  /** 监听跨会话协作事件（collab:event） */
  onCollabEvent: (callback: (data: { type: string }) => void) => () => void;
  /** 跨会话协作：通信记录（最新在前） */
  getCollabLog: () => Promise<CollabLogEntry[]>;
  /** 监听远程配对码（remote:pair-code，RemoteBridge 广播；桌面端显示配对码用） */
  onRemotePairCode?: (callback: (data: RemotePairCode) => void) => () => void;
  /** 监听远程连接状态（remote:status，RemoteBridge 广播） */
  onRemoteStatus?: (callback: (data: RemoteStatus) => void) => () => void;
  /** 查询信任设备列表（本地持久化 + 在线状态） */
  getRemoteDevices: () => Promise<RemoteDeviceInfo[] | { error?: string; devices?: RemoteDeviceInfo[] }>;
  /** 撤销对某设备的信任（发 trust-revoke + 本地删除） */
  revokeRemoteDevice: (remoteId: string) => Promise<{ ok?: boolean; sent?: boolean; error?: string }>;
  /** 监听信任设备列表变化（remote:devices 事件，设备面板实时刷新用） */
  onRemoteDevices?: (callback: (data: { devices: RemoteDeviceInfo[] }) => void) => () => void;
  getSkillsList: () => Promise<Array<{ name: string; description: string }>>;
  /** 把子 Agent 消息流保存为本地 json-session 文件（未完成的工具调用自动补 toolResult） */
  saveSubagentSession: (data: Record<string, unknown>) => Promise<{ ok: boolean; path?: string; error?: string }>;
  switchSession: (sessionId: string, name?: string) => Promise<{ success?: boolean; error?: string; sessionId?: string; name?: string | null; created?: boolean }>;
  /** 新建会话（拉起全新 Agent 进程并切换过去） */
  newSession: () => Promise<{ success?: boolean; error?: string; sessionId?: string }>;
  /** 关闭会话（杀掉对应 Agent 进程，不影响其他会话） */
  closeSession: (sessionId: string) => Promise<{ success?: boolean; error?: string }>;
  /** 查询当前活动会话 */
  getCurrentSession: () => Promise<{ sessionId: string }>;
  /** 查询存活的会话进程列表 */
  listActiveSessions: () => Promise<Array<{ sessionId: string; ready: boolean }>>;
  /** 获取侧边栏静态数据（Skills/Instructions/Agents/MCP 配置） */
  getSidebarStatic: () => Promise<SidebarStaticData>;
  /** 读取 Instruction / Agent 描述文件内容 */
  readInstruction: (kind: string, file: string) => Promise<{ content?: string; error?: string }>;
  minimizeWindow: () => void;
  /** 读取 .env 配置（设置面板用）：items 为解析后的配置项数组 [{ key, value, line }] */
  getEnvConfig: () => Promise<{ ok: boolean; path: string; items: Array<{ key: string; value: string; line: number }>; error?: string }>;
  /** 保存 .env 配置（updates: [{ key, value }] 数组，设置面板用） */
  saveEnvConfig: (updates: Array<{ key: string; value: string }>) => Promise<{ ok: boolean; path: string; written: string[]; error?: string }>;
  maximizeWindow: () => void;
  closeWindow: () => void;
  onMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void;
  isMaximized: () => Promise<boolean>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

/* ─── Agent 消息 ─── */

export type MessageRole = 'user' | 'agent' | 'tool' | 'system' | 'subagent' | 'instructor' | 'divider' | 'blank' | 'banner';

export interface ToolMeta {
  toolName: string;
  args?: Record<string, unknown>;
}

/** 会话重建消息（来自 replace-messages，与 agent 进程 BridgeMessage 结构对应） */
export type ReplayRole = 'user' | 'agent' | 'system' | 'tool' | 'divider' | 'banner' | 'blank' | 'subagent' | 'thinking';

export interface ReplayMessage {
  role: ReplayRole;
  content: string;
  createdAt?: number;
  subagentName?: string;
  collapsed?: boolean;
  toolMeta?: ToolMeta;
  toolCallHtml?: string;
  toolResultHtml?: string;
  fullOutput?: string;
}

export interface AgentMessage {
  type: 'message' | 'state' | 'context' | 'tool-call' | 'thinking' | 'thinking-bubble' | 'thinking-delta' | 'listen' | 'subagent' | 'instructor' | 'append' | 'kb-build' | 'input-state' | 'clear-messages' | 'sidebar-data' | 'replace-messages';
  /** 所属会话（主进程在转发时附加） */
  sessionId?: string;
  role?: MessageRole;
  content?: string;
  toolMeta?: ToolMeta;
  toolCallHtml?: string;
  toolResultHtml?: string;
  fullOutput?: string;
  subagentName?: string;
  processing?: boolean;
  active?: boolean;
  name?: string | null;
  chars?: number;
  tokens?: number;
  count?: number;
  phase?: 'building' | 'done' | 'failed';
  message?: string;
  /** input-state 消息负载：胶囊开关状态 + 处理中标志（供按会话同步发送按钮与胶囊） */
  kbEnabled?: boolean;
  smartSearch?: boolean;
  thinking?: boolean;
  msgId?: string;
  /** replace-messages 消息负载：重建后的完整消息列表 */
  messages?: ReplayMessage[];
  /** sidebar-data 消息的负载 */
  data?: SidebarRuntimeData;
}

/* ─── 侧边栏数据 ─── */

/** 主进程读取的静态数据（Skills/Instructions/Agents/MCP 配置） */
export interface SidebarStaticData {
  skills: Array<{ name: string; description: string; enabled: boolean }>;
  instructions: Array<{ name: string; kind: 'core' | 'addon' | 'platform'; file: string }>;
  addonAgents: Array<{ name: string; kind: string; file: string }>;
  mcpConfig: Array<{ name: string; command: string }>;
}

/** Agent 进程返回的运行时数据（hooks / 子 agent / MCP 状态） */
/** Agent 进程返回的运行时数据（hooks / 子 agent / MCP 状态） */
export interface SidebarRuntimeData {
  sessionId: string;
  hooks: Array<{ name: string; description?: string }>;
  subAgents: Array<{ name: string; mode?: string; status?: string }>;
  mcp: Array<{ name: string; initialized: boolean; error?: string }>;
  context: { messageCount: number };
  /** 当前激活模式（渲染层通讯录标签：manager=下属 / worker=帮手） */
  mode?: string[];
  /** 协作聊天 thread（通讯录 + 聊天视图数据源） */
  threads?: ChatThreadData[];
  /** 子 Agent 消息流（便条窗体数据源：以消息颗粒度追踪工作进度） */
  subagentStreams?: Record<string, SubagentStreamMsg[]>;
  /** Prompt 本地化开关（WebUI「记忆」面板可用性判断） */
  promptLocalization?: boolean;
  /** 最近一次 payload 快照（「记忆」面板数据源：system + 完整消息） */
  memory?: { system: string; messages: MemoryPayloadMsg[]; ts: string };
}

/** payload 中的模型消息（宽松结构：content 可为字符串或 parts 数组，tool 消息带调用信息） */
export interface MemoryPayloadMsg {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  name?: string;
}


/** 协作聊天：消息 */
export interface ChatMessageData {
  role: 'manager' | 'peer';
  content: string;
  ts: number;
}

/** 协作聊天：thread（与某个子模型/worker 的独立对话） */
export interface ChatThreadData {
  peerName: string;
  peerType: 'subagent' | 'worker';
  messages: ChatMessageData[];
  lastActiveAt: number;
}

/** 子 Agent 消息流：单条消息（便条窗体数据源，与 src/modes/subagent-stream.ts 对应） */
export interface SubagentStreamMsg {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolName?: string;
  toolCallId?: string;
  toolInput?: Record<string, unknown>;
  fullOutput?: string;
  ts: number;
}

export interface FileTreeNode {
  name: string;
  /** 相对工作区的路径（用于文件树展开/展示） */
  path: string;
  /** 绝对路径（用于拖拽附件等需要真实路径的场景） */
  absPath?: string;
  type: 'file' | 'folder';
  ext?: string;
  children?: FileTreeNode[];
}

export interface GitChange {
  status: string;
  file: string;
}

export interface SessionInfo {
  name: string;
  /** 自动保存文件内记录的 sessionId（运行中会话的关联键，与主进程活跃进程对齐） */
  sessionId: string | null;
  /** 会话纯标题（agent 副模型生成；渲染层标签页/列表显示名用，可能为空） */
  title?: string;
  timestamp: string | null;
  messageCount: number;
  preview: string;
}


/** 跨会话协作：通信记录条目 */
export interface CollabLogEntry {
  from: string;
  to: string;
  content: string;
  direction: 'out' | 'reply';
  ts: number;
  fromName?: string;
  toName?: string;
  time?: string;
}

/* ─── 面板状态 ─── */

export interface PanelState {
  totalMessages: number;
  userMessages: number;
  agentMessages: number;
  toolCallCount: number;
}

/* ─── 工具历史 ─── */

export interface ToolHistoryEntry {
  paramsHtml: string;
  toolName: string;
  /** 工具调用参数 JSON（供显示名占位符提取字段） */
  args?: Record<string, unknown>;
  resultHtml: string | null;
  fullOutput: string | null;
}




/* ─── Agent 连接状态（来自主进程 agent:status 事件） ─── */
export interface AgentStatus {
  connected: boolean;
  sessionId?: string;
  code?: number;
}

/* ─── 远程配对（RemoteBridge 广播，桌面端显示配对码/连接状态用） ─── */

/** 远程配对码（remote:pair-code 事件载荷） */
export interface RemotePairCode {
  code: string;
  expiresIn: number;
}

/** 远程连接状态（remote:status 事件载荷） */
export interface RemoteStatus {
  connected: boolean;
}

/** 远程信任设备（remote:devices 事件载荷 / remote:getDevices 返回条目；不含 token，避免凭证泄漏到渲染层） */
export interface RemoteDeviceInfo {
  remoteId: string;
  label: string;
  /** 在线状态（来自最近 trust-list 的 items 合并；未收到 trust-list 时默认离线） */
  online: boolean;
  /** 信任时间（ISO 字符串） */
  trustedAt?: string | null;
}










































