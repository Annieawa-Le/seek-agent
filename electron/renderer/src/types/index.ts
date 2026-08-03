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
  /** 生成/更新会话身份卡（轻量模型总结当前对话） */
  generateIdentityCard: (sessionId?: string) => Promise<{ success?: boolean; error?: string }>;

  /** 监听会话身份卡生成完成 */
  onIdentityCard: (callback: (data: { sessionId: string; card?: IdentityCard; error?: string }) => void) => () => void;
  /** 监听跨会话协作事件（collab:event） */
  onCollabEvent: (callback: (data: { type: string }) => void) => () => void;
  /** 跨会话协作：会话列表（活跃 + 历史，含身份卡） */
  getCollabSessions: () => Promise<CollabSession[]>;
  /** 跨会话协作：通信记录（最新在前） */
  getCollabLog: () => Promise<CollabLogEntry[]>;
  getSkillsList: () => Promise<Array<{ name: string; description: string }>>;
  /** 切换到指定会话（已保存会话传 name，将自动拉起独立 Agent 进程） */
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

export interface IdentityCard {
  name?: string;
  focus?: string;
  summary?: string;
  conclusions?: string[];
  relatedSkills?: string[];
  generatedAt?: string;
  [key: string]: unknown;
}

/** 跨会话协作：会话条目（活跃 + 历史，含身份卡） */
export interface CollabSession {
  sessionId: string;
  name: string;
  active: boolean;
  messageCount?: number;
  preview?: string;
  mtime?: string;
  identity?: IdentityCard | null;
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
  resultHtml: string | null;
  fullOutput: string | null;
}




/* ─── Agent 连接状态（来自主进程 agent:status 事件） ─── */
export interface AgentStatus {
  connected: boolean;
  sessionId?: string;
  code?: number;
}
























