// 桌宠窗的 preload：把主进程的协议消息暴露成 window.petBridge。
// 与主窗口 preload 隔离，桌宠窗只有这一条窄通道。

const { contextBridge, ipcRenderer } = require('electron');

let dragHandlers = null;

contextBridge.exposeInMainWorld('petBridge', {
  /** 渲染页就绪 */
  ready() {
    ipcRenderer.send('dafeiyu:ready');
  },

  /** 素材加载完成 */
  loaded() {
    ipcRenderer.send('dafeiyu:loaded');
  },

  /** 接收协议消息（state / pulse / hello / config…） */
  onMessage(handler) {
    if (typeof handler !== 'function') return;
    ipcRenderer.on('dafeiyu:message', (_event, msg) => handler(msg));
  },

  /** 多任务气泡列表 */
  onTasks(handler) {
    if (typeof handler !== 'function') return;
    ipcRenderer.on('dafeiyu:tasks', (_event, tasks) => handler(tasks));
  },

  /** 配置下发 */
  onConfig(handler) {
    if (typeof handler !== 'function') return;
    ipcRenderer.on('dafeiyu:config', (_event, cfg) => handler(cfg));
  },

  /** 拖拽视觉反馈：start / release */
  onDrag(handlers) {
    if (!handlers || typeof handlers !== 'object') return;
    dragHandlers = handlers;
    ipcRenderer.on('dafeiyu:drag', (_event, payload) => {
      const fn = dragHandlers?.[payload?.phase];
      if (typeof fn === 'function') fn(payload.force || 0);
    });
  },

  /** 上报一次桌面交互（点击/摸头/尾巴），供未来埋点或提示音使用 */
  interact(kind) {
    ipcRenderer.send('dafeiyu:interact', kind);
  },

  /** 拖拽中：上报增量位移，由主进程移动窗口 */
  dragMove(dx, dy) {
    ipcRenderer.send('dafeiyu:drag-move', { dx, dy });
  },

  /** 拖拽结束：主进程落盘位置 */
  dragEnd() {
    ipcRenderer.send('dafeiyu:drag-end');
  },
});
