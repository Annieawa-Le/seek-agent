/**
 * electron/preload.cjs — 安全的 IPC 桥接
 *
 * 使用 contextBridge 向渲染进程暴露有限 API：
 *   1. onAgentMessage(callback)    — 接收 agent 消息
 *   2. onAgentStatus(callback)     — 接收连接状态
 *   3. onAgentStderr(callback)     — 接收 stderr 日志
 *   4. sendInput(content)          — 发送用户输入
 *   5. sendCommand(cmd)            — 发送快捷键命令
 *   6. abort()                     — 中断 AI 处理
 *   7. restart()                   — 重启 agent
 *   8. workdir 相关                — 工作区目录管理
 *   9. 多会话控制                  — switchSession / newSession / closeSession 等
 *   10. 侧边栏数据                 — getSidebarStatic / readInstruction
 */

const { contextBridge, ipcRenderer } = require('electron');

// 计数器（用于请求追踪）
let requestId = 0;

contextBridge.exposeInMainWorld('electronAPI', {
  // ─── 接收 ───

  /** 监听 agent 发来的消息 */
  onAgentMessage: (callback) => {
    const handler = (_event, msg) => callback(msg);
    ipcRenderer.on('agent:message', handler);
    return () => ipcRenderer.removeListener('agent:message', handler);
  },

  /** 监听 agent 连接状态变化 */
  onAgentStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('agent:status', handler);
    return () => ipcRenderer.removeListener('agent:status', handler);
  },

  /** 监听 agent stderr 日志 */
  onAgentStderr: (callback) => {
    const handler = (_event, text) => callback(text);
    ipcRenderer.on('agent:stderr', handler);
    return () => ipcRenderer.removeListener('agent:stderr', handler);
  },

  /** 监听工作目录变更 */
  onWorkdirChanged: (callback) => {
    const handler = (_event, path) => callback(path);
    ipcRenderer.on('workdir:changed', handler);
    return () => ipcRenderer.removeListener('workdir:changed', handler);
  },

  /** 监听会话身份卡生成完成（agent:identity-card 事件） */
  onIdentityCard: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('agent:identity-card', handler);
    return () => ipcRenderer.removeListener('agent:identity-card', handler);
  },

  /** 监听跨会话协作事件（collab:event） */
  /** 监听会话 Agent 后台拉起失败（session:new / session:switch 异步化后的兜底） */
  onSessionError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('agent:session-error', handler);
    return () => ipcRenderer.removeListener('agent:session-error', handler);
  },

  onCollabEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('collab:event', handler);
    return () => ipcRenderer.removeListener('collab:event', handler);
  },

  // ─── 发送 ───

  /** 发送用户输入到 agent（主进程路由到当前活动会话） */
  sendInput: (content) => {
    const id = ++requestId;
    ipcRenderer.send('renderer:input', { content, id });
    return id;
  },

  /** 发送命令到 agent（主进程路由到当前活动会话） */
  sendCommand: (cmd) => {
    const id = ++requestId;
    ipcRenderer.send('renderer:command', { cmd, id });
    return id;
  },

  /** 中断当前活动会话的 agent 处理 */
  abort: () => {
    ipcRenderer.send('renderer:abort');
  },

  /** 重启当前活动会话的 agent */
  restart: () => {
    ipcRenderer.send('renderer:restart');
  },

  // ─── 查询 ───

  /** 查询当前 agent 连接状态 */
  getAgentStatus: async () => {
    return ipcRenderer.invoke('agent:status:request');
  },

  // ─── 工作区目录管理 ───

  /** 获取当前工作目录 */
  getWorkdir: async () => {
    return ipcRenderer.invoke('workdir:get');
  },

  /** 设置工作目录 */
  setWorkdir: async (dirPath) => {
    return ipcRenderer.invoke('workdir:set', dirPath);
  },

  /** 打开系统对话框选择文件夹 */
  selectFolder: async () => {
    return ipcRenderer.invoke('workdir:select');
  },

  /** 获取最近目录列表 */
  getRecentDirs: async () => {
    return ipcRenderer.invoke('workdir:getRecent');
  },

  // ─── 文件系统 API ───

  /** 读取项目文件树 */
  readFileTree: async (dirPath) => {
    return ipcRenderer.invoke('fs:readFileTree', dirPath);
  },

  /** 读取 git 变更状态 */
  readGitStatus: async () => {
    return ipcRenderer.invoke('fs:readGitStatus');
  },
  /** 打开系统对话框选择附件文件（支持多选） */
  openFileDialog: async () => {
    return ipcRenderer.invoke('dialog:openFiles');
  },

  /** 读取可用技能列表 */
  getSkillsList: async () => {
    return ipcRenderer.invoke('skills:list');
  },

  /** 读取 sessions 列表 */
  listSessions: async () => {
    return ipcRenderer.invoke('fs:listSessions');
  },

  /** 生成/更新会话身份卡（轻量模型总结当前对话） */
  generateIdentityCard: async (sessionId) => {
    return ipcRenderer.invoke('session:generateIdentityCard', sessionId);
  },

  /** 跨会话协作：会话列表（活跃 + 历史，含身份卡） */
  getCollabSessions: async () => {
    return ipcRenderer.invoke('collab:sessions');
  },

  /** 跨会话协作：通信记录（最新在前） */
  getCollabLog: async () => {
    return ipcRenderer.invoke('collab:log');
  },

  // ─── 多会话控制 ───

  /** 切换到指定会话（已保存会话传 name，将自动拉起独立 Agent 进程） */
  switchSession: async (sessionId, name) => {
    return ipcRenderer.invoke('session:switch', sessionId, name);
  },

  /** 新建会话（拉起全新 Agent 进程并切换过去） */
  newSession: async () => {
    return ipcRenderer.invoke('session:new');
  },

  /** 关闭会话（杀掉对应 Agent 进程，不影响其他会话） */
  closeSession: async (sessionId) => {
    return ipcRenderer.invoke('session:close', sessionId);
  },

  /** 查询当前活动会话 */
  getCurrentSession: async () => {
    return ipcRenderer.invoke('session:current');
  },

  /** 查询存活的会话进程列表 */
  listActiveSessions: async () => {
    return ipcRenderer.invoke('session:list');
  },

  // ─── 侧边栏数据 ───

  /** 获取侧边栏静态数据（Skills/Instructions/Agents/MCP 配置） */
  getSidebarStatic: async () => {
    return ipcRenderer.invoke('sidebar:static');
  },

  /** 读取 Instruction / Agent 描述文件内容 */
  readInstruction: async (kind, file) => {
    return ipcRenderer.invoke('sidebar:instruction', kind, file);
  },

  // ─── 窗口控制 ───

  /** 最小化窗口 */
  minimizeWindow: () => {
    ipcRenderer.send('window:minimize');
  },

  /** 最大化/还原窗口 */
  maximizeWindow: () => {
    ipcRenderer.send('window:maximize');
  },

  /** 关闭窗口 */
  closeWindow: () => {
    ipcRenderer.send('window:close');
  },

  /** 监听最大化状态变化 */
  onMaximizedChange: (callback) => {
    const handler = (_event, isMaximized) => callback(isMaximized);
    ipcRenderer.on('window:maximized', handler);
    return () => ipcRenderer.removeListener('window:maximized', handler);
  },

  /** 查询窗口是否最大化 */
  isMaximized: async () => {
    return ipcRenderer.invoke('window:isMaximized');
  },
});





