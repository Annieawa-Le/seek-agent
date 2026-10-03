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

  /** 监听会话 Agent 后台拉起失败（session:new / session:switch 异步化后的兜底） */
  onSessionError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('agent:session-error', handler);
    return () => ipcRenderer.removeListener('agent:session-error', handler);
  },

  /** 监听跨会话协作事件（collab:event） */
  onCollabEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('collab:event', handler);
    return () => ipcRenderer.removeListener('collab:event', handler);
  },

  /** 监听远程配对码（remote:pair-code，RemoteBridge 广播；桌面端显示配对码用） */
  onRemotePairCode: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('remote:pair-code', handler);
    return () => ipcRenderer.removeListener('remote:pair-code', handler);
  },

  /** 监听远程连接状态（remote:status，RemoteBridge 广播） */
  onRemoteStatus: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('remote:status', handler);
    return () => ipcRenderer.removeListener('remote:status', handler);
  },

  /** 监听信任设备列表变化（remote:devices，RemoteBridge 广播；设备面板实时刷新用） */
  onRemoteDevices: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('remote:devices', handler);
    return () => ipcRenderer.removeListener('remote:devices', handler);
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

  /** 查询信任设备列表（本地持久化 + 在线状态） */
  getRemoteDevices: async () => {
    return ipcRenderer.invoke('remote:getDevices');
  },

  /** 撤销对某设备的信任（发 trust-revoke + 本地删除） */
  revokeRemoteDevice: async (remoteId) => {
    return ipcRenderer.invoke('remote:revokeDevice', remoteId);
  },

  // ─── 工作区目录管理 ───

  /** 获取当前会话工作区状态 { roots, active } */
  getWorkdir: async () => {
    return ipcRenderer.invoke('workdir:get');
  },

  /** 设置工作目录（单路径语义：替换为单个根） */
  setWorkdir: async (dirPath) => {
    return ipcRenderer.invoke('workdir:set', dirPath);
  },

  /** 整体设置多工作区根列表（{ roots, active? }） */
  setWorkspaceRoots: async (payload) => {
    return ipcRenderer.invoke('workdir:setRoots', payload);
  },

  /** 追加一个工作区根 */
  addWorkspaceRoot: async (dirPath) => {
    return ipcRenderer.invoke('workdir:addRoot', { path: dirPath });
  },

  /** 移除一个工作区根 */
  removeWorkspaceRoot: async (dirPath) => {
    return ipcRenderer.invoke('workdir:removeRoot', { path: dirPath });
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

  /** 读取文本文件内容（内嵌编辑器；返回 { ok, content } 或 { ok:false, error }） */
  readFile: async (filePath) => {
    return ipcRenderer.invoke('fs:readFile', filePath);
  },

  /** 写入文本文件（内嵌编辑器保存；payload: { path, content }） */
  writeFile: async (payload) => {
    return ipcRenderer.invoke('fs:writeFile', payload);
  },

  /** 列出 AI 的文件改动记录（编辑器「审查」用；payload: { since?, limit? }） */
  listPatches: async (payload) => {
    return ipcRenderer.invoke('fs:listPatches', payload);
  },

  /** 回退一条 AI 改动记录（审查面板「回退」；省略 recordId 即回退最近一条） */
  undoPatch: async (payload) => {
    return ipcRenderer.invoke('history:undo', payload);
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

  /** 读取 .env 配置（设置面板用） */
  getEnvConfig: async () => {
    return ipcRenderer.invoke('env:read');
  },

  /** 保存 .env 配置（updates: [{key, value}]，设置面板用） */
  saveEnvConfig: async (updates) => {
    return ipcRenderer.invoke('env:write', { updates });
  },

  /** 读取挂件插件清单（设置面板「插件」板块用） */
  getPlugins: async () => {
    return ipcRenderer.invoke('plugins:list');
  },

  /** 启用/禁用某挂件插件（写回其 enable.json；重启后生效） */
  setPluginEnabled: async (name, enabled) => {
    return ipcRenderer.invoke('plugins:setEnabled', name, enabled);
  },

  /** 改写某插件的次级选项（如 dsh-raw-html 的可信模式；重启后生效） */
  setPluginOption: async (name, key, value) => {
    return ipcRenderer.invoke('plugins:setOption', name, key, value);
  },

  /** 读桌宠配置（含可调项 schema，设置面板「插件」板块用） */
  getPetConfig: async () => {
    return ipcRenderer.invoke('pet:getConfig');
  },

  /** 写桌宠配置（增量 patch），保存后立即下发给运行中的桌宠窗 */
  setPetConfig: async (patch) => {
    return ipcRenderer.invoke('pet:setConfig', patch);
  },



  /** 跨会话协作：通信记录（最新在前） */
  getCollabLog: async () => {
    return ipcRenderer.invoke('collab:log');
  },

  /** 把子 Agent 消息流保存为本地 json-session 文件 */
  saveSubagentSession: async (data) => {
    return ipcRenderer.invoke('session:saveSubagent', data);
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
























