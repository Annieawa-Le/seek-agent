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
});

