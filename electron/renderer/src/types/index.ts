/** Electron API 桥接类型 */
export interface ElectronAPI {
  onAgentMessage: (callback: (msg: AgentMessage) => void) => () => void;
  getAgentStatus: () => Promise<{ connected: boolean }>;
  onAgentStatus: (callback: (status: AgentStatus) => void) => () => void;
  onAgentStderr: (callback: (text: string) => void) => () => void;
  onWorkdirChanged: (callback: (path: string) => void) => () => void;
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

export type MessageRole = 'user' | 'agent' | 'tool' | 'system' | 'subagent' | 'divider' | 'blank' | 'banner';

export interface ToolMeta {
  toolName: string;
  args?: Record<string, unknown>;
}

export interface AgentMessage {
  type: 'message' | 'state' | 'context' | 'tool-call' | 'thinking' | 'thinking-bubble' | 'thinking-delta' | 'listen' | 'subagent' | 'append' | 'kb-build' | 'clear-messages' | 'sidebar-data';
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
  msgId?: string;
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
}

export interface FileTreeNode {
  name: string;
  path: string;
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
  timestamp: string | null;
  messageCount: number;
  preview: string;
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
