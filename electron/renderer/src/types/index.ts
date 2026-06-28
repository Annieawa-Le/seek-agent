/** Electron API 桥接类型 */
export interface ElectronAPI {
  onAgentMessage: (callback: (msg: AgentMessage) => void) => () => void;
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
  getRecentDirs: () => Promise<string[]>;
  readFileTree: (dirPath: string) => Promise<FileTreeNode[]>;
  readGitStatus: () => Promise<GitChange[]>;
  listSessions: () => Promise<SessionInfo[]>;
  getSkillsList: () => Promise<Array<{ name: string; description: string }>>;
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
  type: 'message' | 'state' | 'context' | 'tool-call' | 'thinking' | 'listen' | 'subagent' | 'append' | 'kb-build';
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







