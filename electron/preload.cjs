/**
 * electron/preload.js — 安全的 IPC 桥接
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

  // ─── 发送 ───

  /** 发送用户输入到 agent */
  sendInput: (content) => {
    const id = ++requestId;
    ipcRenderer.send('renderer:input', { content, id });
    return id;
  },

  /** 发送命令到 agent */
  sendCommand: (cmd) => {
    const id = ++requestId;
    ipcRenderer.send('renderer:command', { cmd, id });
    return id;
  },

  /** 中断 agent 处理 */
  abort: () => {
    ipcRenderer.send('renderer:abort');
  },

  /** 重启 agent */
  restart: () => {
    ipcRenderer.send('renderer:restart');
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

  /** 读取 sessions 列表 */

  /** 读取可用技能列表 */
  getSkillsList: async () => {
    return ipcRenderer.invoke('skills:list');
  },
  listSessions: async () => {
    return ipcRenderer.invoke('fs:listSessions');
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


