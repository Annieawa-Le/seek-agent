/**
 * electron/renderer/renderer.js — WebUI 前端逻辑
 *
 * Electron 主进程通过 preload.js 暴露的 window.electronAPI 通信。
 * 负责：
 *   1. 接收 agent 消息并渲染
 *   2. 用户输入发送
 *   3. 滚动控制
 *   4. 快捷键
 *   5. Markdown 渲染
 */

// ════════════════════════════════════════════════════════
// DOM 引用
// ════════════════════════════════════════════════════════
const messageList = document.getElementById('message-list');
const messageArea = document.getElementById('message-area');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const statusText = document.getElementById('status-text');
const statusDot = document.getElementById('status-dot');
const ctxDisplay = document.getElementById('ctx-display');
const toolsBadge = document.getElementById('tools-badge');
const thinkingSpinner = document.getElementById('thinking-spinner');

// ════════════════════════════════════════════════════════
// 状态
// ════════════════════════════════════════════════════════
let connected = false;
let processing = false;
let thinkingActive = false;
let listenActive = false;
let streamingAgent = false; // 正在流式输出 agent 消息

// ── 信息面板数据追踪 ──
const panelState = {
  totalMessages: 0,
  userMessages: 0,
  agentMessages: 0,
  toolCallCount: 0,
  contextChars: 0,
  contextTokens: 0,
};

// 工具调用批次追踪
let _toolCallCurrent = 0;
let _toolCallTotal = 0;

// 用于跟踪是否在流式追加中，避免误触自动滚动
// 用于跟踪是否在流式追加中，避免误触自动滚动
let userScrolledUp = false;

// 用于在每轮首次输出前插入空气泡
let _pendingAirBubble = false;

// 消息历史 ID 计数器
let msgIdCounter = 0;

// 缓存的消息字典（id -> DOM 元素）
const messageElements = new Map();

// ════════════════════════════════════════════════════════
// API 检查
// ════════════════════════════════════════════════════════
const api = window.electronAPI;
if (!api) {
  document.body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#666;font-family:sans-serif;">
      <p>未检测到 Electron API，请在 Electron 环境中运行此应用。</p>
    </div>
  `;
}

// ════════════════════════════════════════════════════════
// 工具函数
// ════════════════════════════════════════════════════════
function formatTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** 简单的 Markdown 转 HTML 渲染 */
function renderMarkdown(text) {
  if (!text) return '';

  let html = escapeHtml(text);

  // 代码块（必须优先处理，避免内部被 Markdown 语法破坏）
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
    return `<pre${langAttr}><code>${code}</code></pre>`;
  });

  // 行内代码
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // 标题
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // 引用
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

  // 无序列表
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

  // 有序列表
  html = html.replace(/^(\d+)\. (.+)$/gm, '<li value="$1">$2</li>');

  // 粗体
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // 斜体
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // 链接
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  // 分割线
  html = html.replace(/^-{3,}$/gm, '<hr>');

  // 换行（段落）
  html = html.split('\n').filter(line => line.trim()).map(line => `<p>${line}</p>`).join('\n');

  return html;
}

/** ANSI 转 HTML（支持 TUI 颜色码）
 * 先做纯字符串 HTML 转义（避免 DOM textContent 吞掉控制字符），
 * 再将 ANSI 颜色码转为 HTML 标签。 */
function renderAnsi(text) {
  // 手动 HTML 转义，保留控制字符不被 DOM 破坏
  var escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return escaped
    .replace(/\x1b\[94m/g, '<span style="color:#3b82f6">')
    .replace(/\x1b\[35m/g, '<span style="color:#a855f7">')
    .replace(/\x1b\[32m/g, '<span style="color:#16a34a">')
    .replace(/\x1b\[31m/g, '<span style="color:#dc2626">')
    .replace(/\x1b\[33m/g, '<span style="color:#ca8a04">')
    .replace(/\x1b\[30m/g, '<span style="color:#374151">')
    .replace(/\x1b\[1m/g, '<span style="font-weight:600">')
    .replace(/\x1b\[4m/g, '<span style="text-decoration:underline">')
    .replace(/\x1b\[0m/g, '</span>')
    .replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '')
    .replace(/(<\/span>)+/g, '</span>');
}

/** 渲染普通消息内容（纯文本，如工具消息） */
function renderPlainText(text) {
  return escapeHtml(text);
}

// ════════════════════════════════════════════════════════
// 消息渲染
// ════════════════════════════════════════════════════════
let lastMsgId = null;

function createMessageElement(msg) {
  const el = document.createElement('div');
  const id = ++msgIdCounter;
  el.dataset.msgId = id;
  el.dataset.role = msg.role;
  messageElements.set(id, el);

  const ts = msg.createdAt || Date.now();

  switch (msg.role) {
    case 'user': {
      el.className = 'message user';
      // <div class="message-user-header">
      //    <span>祝景玥</span>
      //    <span class="time">${formatTime(ts)}</span>
      //  </div>
      el.innerHTML = `
        <div class="content">${renderMarkdown(msg.content)}</div>
      `;
      break;
    }

    case 'agent': {
      el.className = 'message agent';
      el.innerHTML = `
        <div class="message-agent-header">
          <span>小鲸鱼Deepseek</span>
        </div>
        <div class="content"></div>
      `;
      const contentEl = el.querySelector('.content');
      if (msg.content) {
        contentEl.dataset.raw = msg.content;
        contentEl.innerHTML = renderMarkdown(msg.content);
      }
      break;
    }

    case 'tool': {
      if (msg.doNotRender) {
        el.style.display = 'none';
        return el;
      }

      if (msg.collapsed && msg.toolMeta) {
        el.className = 'message tool collapsed';
        const argsStr = Object.entries(msg.toolMeta.args || {})
          .map(([k, v]) => {
            const vStr = typeof v === 'string' ? v : JSON.stringify(v);
            return vStr.length > 40 ? `${k}=${vStr.slice(0, 40)}...` : `${k}=${vStr}`;
          })
          .join(', ');
        el.innerHTML = `
          <div class="content">
            <span class="tool-collapse-icon"></span>
            <span class="tool-name">${escapeHtml(msg.toolMeta.toolName)}</span>
            <span class="tool-args">${escapeHtml(argsStr)}</span>
          </div>
        `;
      } else {
        el.className = 'message tool' + (msg.toolMeta ? ' call' : ' result');
        el.innerHTML = `<div class="content">${renderPlainText(msg.content)}</div>`;
      }
      break;
    }

    case 'subagent': {
      el.className = 'message subagent';
      el.innerHTML = `
        <div class="message-subagent-header">💬 ${escapeHtml(msg.subagentName || '子模型')}</div>
        <div class="content">${renderMarkdown(msg.content)}</div>
      `;
      break;
    }

    case 'system': {
      el.className = 'message system';
      el.innerHTML = `<div class="content">${escapeHtml(msg.content)}</div>`;
      break;
    }

    case 'divider': {
      el.className = 'message divider';
      break;
    }

    case 'blank': {
      el.className = 'message blank';
      break;
    }

    case 'banner': {
      el.className = 'message banner';
      el.innerHTML = `<div class="content" style="user-select:none;">${escapeHtml(msg.content)}</div>`;
      break;
    }
  }

  return el;
}

function appendMessage(msg) {
  // 跳过空气泡：无内容的 agent 消息不渲染
  if (msg.role === 'agent' && !msg.content) return;
  const el = createMessageElement(msg);
  if (!el) return;
  messageList.appendChild(el);
  console.log("[INFO](message list:)" + el);
  lastMsgId = msg.msgId;

  // 更新面板统计
  panelState.totalMessages++;
  if (msg.role === 'user') panelState.userMessages++;
  else if (msg.role === 'agent') panelState.agentMessages++;
  updateInfoPanel();

  // agent 消息进来即视为流式开始
  if (msg.role === 'agent') {
    el.classList.add('streaming');
    streamingAgent = true;
  }

  scrollToBottom();
  return el;
}


/** 工具调用合并到前一个文本气泡，连续工具在同一气泡更新 */
function updateToolInline(msg) {
  // ── 工具调用（有 toolMeta） ──
  if (msg.toolMeta) {
    _toolCallCurrent++;

    const agentMsgs = messageList.querySelectorAll('.message.agent');
    let lastAgent = agentMsgs.length > 0 ? agentMsgs[agentMsgs.length - 1] : null;

    // 没有气泡，或最后一个已结束 → 创建新气泡
    if (!lastAgent || lastAgent.classList.contains('round-ended')) {
      const el = createMessageElement({ role: 'agent', content: '', createdAt: Date.now() });
      messageList.appendChild(el);
      lastAgent = el;
      lastAgent.classList.add('streaming');
      streamingAgent = true;
      panelState.agentMessages++;
    }

    const contentEl = lastAgent.querySelector('.content');
    if (!contentEl) return;

    // 初始化工具历史
    if (!contentEl._toolHistory) {
      contentEl._toolHistory = [];
      contentEl._toolHistoryIndex = -1;
    }

    // 追加到历史
    contentEl._toolHistory.push({
      paramsHtml: msg.toolCallHtml || renderAnsi(msg.content),
      toolName: msg.toolMeta.toolName,
      resultHtml: null,
    });
    contentEl._toolHistoryIndex = contentEl._toolHistory.length - 1;

    // 参数区
    var paramsEl = contentEl.querySelector('.agent-tool-params');
    if (!paramsEl) {
      paramsEl = document.createElement('div');
      paramsEl.className = 'agent-tool-params';
      contentEl.appendChild(paramsEl);
    }

    // 工具容器
    var toolContainer = contentEl.querySelector('.agent-tool-container');
    if (!toolContainer) {
      toolContainer = document.createElement('div');
      toolContainer.className = 'agent-tool-container';
      contentEl.appendChild(toolContainer);
    }
    var toolCallDiv = document.createElement('div');
    toolCallDiv.className = 'agent-tool-call';
    toolCallDiv.textContent = msg.toolMeta.toolName;
    var toolResultDiv = document.createElement('div');
    toolResultDiv.className = 'agent-tool-result';
    toolResultDiv.style.opacity = '0.6';
    toolResultDiv.textContent = '执行中...';
    toolContainer.innerHTML = '';
    toolContainer.appendChild(toolCallDiv);
    toolContainer.appendChild(toolResultDiv);

    renderToolCounter(contentEl);

  // ── 工具结果（无 toolMeta） ──
  } else {
    const agentMsgs = messageList.querySelectorAll('.message.agent');
    var target = null;
    for (var i = agentMsgs.length - 1; i >= 0; i--) {
      if (agentMsgs[i].querySelector('.agent-tool-container') && !agentMsgs[i].classList.contains('round-ended')) {
        target = agentMsgs[i];
        break;
      }
    }
    if (!target) return;

    const contentEl = target.querySelector('.content');
    if (!contentEl) return;

    // 更新最新一条历史的结果
    if (contentEl._toolHistory && contentEl._toolHistory.length > 0) {
      var lastEntry = contentEl._toolHistory[contentEl._toolHistory.length - 1];
      lastEntry.resultHtml = msg.toolResultHtml || renderAnsi(msg.content);
      lastEntry.fullOutput = msg.fullOutput;
      // 如果当前正在看最新一条，刷新显示
      if (contentEl._toolHistoryIndex === contentEl._toolHistory.length - 1) {
        renderToolDisplay(contentEl);
      }
    }
  }
  scrollToBottom();
}

/** 根据 contentEl._toolHistoryIndex 渲染当前参数 + 结果 + 计数器 */
function renderToolDisplay(contentEl) {
  var history = contentEl._toolHistory;
  if (!history || history.length === 0) return;
  var idx = contentEl._toolHistoryIndex;
  if (idx < 0 || idx >= history.length) return;
  var entry = history[idx];

  var paramsEl = contentEl.querySelector('.agent-tool-params');
  if (paramsEl) {
    paramsEl.innerHTML = entry.paramsHtml;
  }

  var toolContainer = contentEl.querySelector('.agent-tool-container');
  if (toolContainer) {
    var callEl = toolContainer.querySelector('.agent-tool-call');
    if (callEl) callEl.textContent = entry.toolName;
    var resultEl = toolContainer.querySelector('.agent-tool-result');
    if (resultEl) {
      if (entry.fullOutput) {
        // 有完整原始输出 → 直接渲染可滚动容器
        resultEl.style.opacity = '1';
        addToolResultExpand(resultEl, entry);
      } else if (entry.resultHtml) {
        resultEl.innerHTML = entry.resultHtml;
        resultEl.style.opacity = '1';
      } else {
        resultEl.textContent = '执行中...';
        resultEl.style.opacity = '0.6';
      }
    }
  }

  renderToolCounter(contentEl);
}

/** 渲染计数器导航（◀ 1/3 ▶） */
function renderToolCounter(contentEl) {
  var history = contentEl._toolHistory;
  if (!history || history.length === 0) return;
  var idx = contentEl._toolHistoryIndex;

  var counterEl = contentEl.querySelector('.agent-tool-counter');
  if (!counterEl) {
    counterEl = document.createElement('div');
    counterEl.className = 'agent-tool-counter';
    contentEl.appendChild(counterEl);
  }

  var total = _toolCallTotal > 0 ? _toolCallTotal : '?';
  var displayTotal = total !== '?' && total < history.length ? history.length : total;

  var prevDisabled = idx <= 0 ? ' disabled' : '';
  var nextDisabled = idx >= history.length - 1 ? ' disabled' : '';

  counterEl.innerHTML = ''
    + '<span class="tool-counter-arrow' + prevDisabled + '" data-dir="prev">◀</span>'
    + '<span class="tool-counter-text">' + (idx + 1) + '/' + displayTotal + '</span>'
    + '<span class="tool-counter-arrow' + nextDisabled + '" data-dir="next">▶</span>';

  // 绑定箭头点击
  var arrows = counterEl.querySelectorAll('.tool-counter-arrow');
  for (var a = 0; a < arrows.length; a++) {
    arrows[a].addEventListener('click', function(e) {
      var dir = this.getAttribute('data-dir');
      if (this.classList.contains('disabled')) return;
      if (dir === 'prev' && contentEl._toolHistoryIndex > 0) {
        contentEl._toolHistoryIndex--;
        renderToolDisplay(contentEl);
      } else if (dir === 'next' && contentEl._toolHistoryIndex < contentEl._toolHistory.length - 1) {
        contentEl._toolHistoryIndex++;
        renderToolDisplay(contentEl);
      }
    });
  }

/** 清理所有残留的「执行中...」工具结果 */
function clearPendingToolResults() {
  document.querySelectorAll('.agent-tool-result').forEach(function(el) {
    if (el.textContent === '执行中...') {
      // 找到对应的气泡，移除 tool-history 中的未完成条目
      var contentEl = el.closest('.content');
      if (contentEl && contentEl._toolHistory && contentEl._toolHistory.length > 0) {
        var lastEntry = contentEl._toolHistory[contentEl._toolHistory.length - 1];
        if (lastEntry && !lastEntry.resultHtml && !lastEntry.fullOutput) {
          contentEl._toolHistory.pop();
          contentEl._toolHistoryIndex = contentEl._toolHistory.length - 1;
        }
      }
      // 移除 tool-container（连同工具调用名一起消失）
      var toolContainer = el.closest('.agent-tool-container');
      if (toolContainer) toolContainer.remove();
      // 重渲染计数器
      if (contentEl) renderToolCounter(contentEl);
    }
  });
}
}

/**
 * 为工具结果添加「展开完整内容」功能。
 * 检测 .agent-tool-result 中的内容行数，超过阈值时折叠为限定高度并增加展开/收缩按钮。
 */
function addToolResultExpand(resultEl, entry) {
  // 计算内容行数
  var fullText = entry.fullOutput || '';
  var lines = fullText.split('\n').length;

  var wrapper = document.createElement('div');
  wrapper.className = 'tool-result-scroll-wrap';

  var scrollContainer = document.createElement('div');
  scrollContainer.className = 'tool-result-scroll-container';
  var pre = document.createElement('pre');
  pre.className = 'tool-result-pre';
  pre.textContent = fullText;
  scrollContainer.appendChild(pre);
  wrapper.appendChild(scrollContainer);

  if (lines > 8) {
    wrapper.classList.add('collapsed');
    // 浮动展开按钮
    var toggleBtn = document.createElement('button');
    toggleBtn.className = 'tool-result-toggle';
    toggleBtn.textContent = '▼';
    toggleBtn.title = '展开全部 (' + lines + ' 行)';
    toggleBtn.addEventListener('click', function() {
      var isCollapsed = wrapper.classList.contains('collapsed');
      if (isCollapsed) {
        wrapper.classList.remove('collapsed');
        wrapper.classList.add('expanded');
        toggleBtn.textContent = '▲';
        toggleBtn.title = '收起';
      } else {
        wrapper.classList.remove('expanded');
        wrapper.classList.add('collapsed');
        toggleBtn.textContent = '▼';
        toggleBtn.title = '展开全部 (' + lines + ' 行)';
      }
    });
    wrapper.appendChild(toggleBtn);
  }

  resultEl.innerHTML = '';
  resultEl.style.opacity = '1';
  resultEl.appendChild(wrapper);
}
/** 移除最后一条 agent 消息 */
function removeLastAgent() {
  console.log("[INFO] Remove called.")
  const agentMsgs = messageList.querySelectorAll('.message.agent');
  const lastAgent = agentMsgs[agentMsgs.length - 1];
  if (lastAgent) {
    lastAgent.remove();
  }
  streamingAgent = false;
}

/** 清空所有消息 */
function clearMessages() {
  messageList.innerHTML = '';
  messageElements.clear();
  streamingAgent = false;
  panelState.totalMessages = 0;
  panelState.userMessages = 0;
  panelState.agentMessages = 0;
  panelState.toolCallCount = 0;
  _toolCallCurrent = 0;
  _toolCallTotal = 0;
  updateInfoPanel();
}

/** 折叠工具消息 */
function collapseToolMessages(entries) {
  for (const entry of entries) {
    const toolMsgs = messageList.querySelectorAll('.message.tool');
    const target = toolMsgs[entry.msgIndex];
    if (!target) continue;

    target.className = 'message tool collapsed';
    const argsStr = Object.entries(entry.args || {})
      .map(([k, v]) => {
        const vStr = typeof v === 'string' ? v : JSON.stringify(v);
        return vStr.length > 40 ? `${k}=${vStr.slice(0, 40)}...` : `${k}=${vStr}`;
      })
      .join(', ');
    target.innerHTML = `
      <div class="content">
        <span class="tool-collapse-icon"></span>
        <span class="tool-name">${escapeHtml(entry.toolName)}</span>
        <span class="tool-args">${escapeHtml(argsStr)}</span>
      </div>
    `;

    // 隐藏前面的「调用中」消息
    const callMsg = toolMsgs[entry.msgIndex - 1];
    if (callMsg && !callMsg.classList.contains('collapsed') && !callMsg.querySelector('.tool-name')) {
      callMsg.style.display = 'none';
    }
  }
}

// ════════════════════════════════════════════════════════
// 滚动控制
// ════════════════════════════════════════════════════════
function scrollToBottom() {
  if (userScrolledUp) return;
  requestAnimationFrame(() => {
    messageArea.scrollTop = messageArea.scrollHeight;
  });
}

messageArea.addEventListener('scroll', () => {
  const threshold = 100;
  const atBottom = messageArea.scrollHeight - messageArea.scrollTop - messageArea.clientHeight < threshold;
  userScrolledUp = !atBottom;
});


// ════════════════════════════════════════════════════════
// 按钮双模式切换
// ════════════════════════════════════════════════════════
function switchToStopMode() {
  sendBtn.disabled = false;
  sendBtn.classList.add('stop-mode');
  sendBtn.title = '终止';
  document.getElementById('send-icon').style.display = 'none';
  document.getElementById('stop-icon').style.display = 'block';
}
function switchToSendMode() {
  sendBtn.disabled = false;
  sendBtn.classList.remove('stop-mode');
  sendBtn.title = '发送';
  document.getElementById('send-icon').style.display = 'block';
  document.getElementById('stop-icon').style.display = 'none';
}

// 发送按钮点击 —— 空闲时发送，处理中时终止
sendBtn.addEventListener('click', () => {
  if (processing) {
    api.abort();
    switchToSendMode();
    streamingAgent = false;
    document.querySelectorAll('.message.agent.streaming').forEach(el => {
      el.classList.remove('streaming');
      el.classList.add('round-ended');
    });
    sendBtn.disabled = true;
    statusText.textContent = '已终止';
  } else {
    sendMessage();
  }
});

// ════════════════════════════════════════════════════════
// 输入处理
// ════════════════════════════════════════════════════════
function sendMessage() {
  const text = messageInput.value.trim();
  if (!text) return;

  messageInput.value = '';
  resetInputHeight();
  sendBtn.disabled = true;

  // 本地立即显示
  appendMessage({ role: 'user', content: text, createdAt: Date.now() });

  // 标记本轮需要插入空气泡
  _pendingAirBubble = true;

  // 发送到 agent
  api.sendInput(text);
}


function resetInputHeight() {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.max(36, messageInput.scrollHeight) + 'px';
}

// 自动调整高度
messageInput.addEventListener('input', resetInputHeight);

// Enter 发送，Shift+Enter 换行
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// 发送按钮

// Ctrl+Enter 也发送
messageInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    sendMessage();
  }
});

// 焦点快捷
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    messageInput.blur();
  }
  // Tab 中断所有子 agent
  // Ctrl+Shift+C 终止
  if (e.ctrlKey && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
    e.preventDefault();
    api.abort();
    switchToSendMode();
    streamingAgent = false;
    document.querySelectorAll('.message.agent.streaming').forEach(el => {
      el.classList.remove('streaming');
      el.classList.add('round-ended');
    });
    statusText.textContent = '已终止';
  }
  if (e.ctrlKey && e.key === 'q') {
    e.preventDefault();
    api.sendCommand('memory_shorten');
  }
  // Ctrl+W 折叠
  if (e.ctrlKey && e.key === 'w') {
    e.preventDefault();
    api.sendCommand('memory_focus');
  }
  // Ctrl+Shift+C 终止
  if (e.ctrlKey && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
    e.preventDefault();
    api.abort();
    switchToSendMode();
    streamingAgent = false;
    document.querySelectorAll('.message.agent.streaming').forEach(el => {
      el.classList.remove('streaming');
      el.classList.add('round-ended');
    });
    statusText.textContent = '已终止';
  }
});

// ════════════════════════════════════════════════════════
// Agent 消息处理
// ════════════════════════════════════════════════════════
function handleAgentMessage(msg) {
  switch (msg.type) {
    case 'message': {
      switch (msg.role) {
        case 'user':
          // 用户消息（来自 agent 的 echo），无需额外处理
          break;
        case 'agent':
          appendMessage({ role: 'agent', content: msg.content, createdAt: Date.now() });
          break;
        case 'tool':
          updateToolInline({ content: msg.content, toolMeta: msg.toolMeta, toolCallHtml: msg.toolCallHtml, toolResultHtml: msg.toolResultHtml, fullOutput: msg.fullOutput });
          break;
        case 'system':
          appendMessage({ role: 'system', content: msg.content, createdAt: Date.now() });
          break;
        case 'divider':
          appendMessage({ role: 'divider', content: '' });
          break;
        case 'blank':
          appendMessage({ role: 'blank', content: '' });
          break;
      }
      break;
    }

    case 'subagent': {
      appendMessage({ role: 'subagent', content: msg.content, subagentName: msg.name, createdAt: Date.now() });
      break;
    }

    case 'append': {
      if (msg.content) {
        const agentMsgs = messageList.querySelectorAll('.message.agent');
        const lastAgent = agentMsgs.length > 0 ? agentMsgs[agentMsgs.length - 1] : null;
        // 没有活跃的流式气泡 → 开新气泡；否则追加到当前气泡
        if (!lastAgent || !lastAgent.classList.contains('streaming') || lastAgent.querySelector('.agent-tool-container')) {
          appendMessage({ role: 'agent', content: msg.content, createdAt: Date.now() });
        } else {
          // 追加到当前流式气泡
          const contentEl = lastAgent.querySelector('.content');
          if (contentEl) {
            var _tbParams = contentEl.querySelector('.agent-tool-params');
            var _tbParamsHTML = _tbParams ? _tbParams.outerHTML : '';
            var _tbContainer = contentEl.querySelector('.agent-tool-container');
            var _tbContainerHTML = _tbContainer ? _tbContainer.outerHTML : '';
            var _tbCounter = contentEl.querySelector('.agent-tool-counter');
            var _tbCounterHTML = _tbCounter ? _tbCounter.outerHTML : '';
            if (_tbParams) _tbParams.remove();
            if (_tbContainer) _tbContainer.remove();
            if (_tbCounter) _tbCounter.remove();

            const raw = contentEl.dataset.raw || contentEl.textContent;
            const newRaw = raw + msg.content;
            contentEl.dataset.raw = newRaw;
            contentEl.innerHTML = renderMarkdown(newRaw);

            if (_tbParamsHTML) contentEl.insertAdjacentHTML('beforeend', _tbParamsHTML);
            if (_tbContainerHTML) contentEl.insertAdjacentHTML('beforeend', _tbContainerHTML);
            if (_tbCounterHTML) contentEl.insertAdjacentHTML('beforeend', _tbCounterHTML);
          }
          scrollToBottom();
        }
      }
      break;
    }

    case 'state': {
      processing = msg.processing;
      if (processing) {
        // 新轮次开始，重置工具计数
        _toolCallCurrent = 0;
        _toolCallTotal = 0;
        switchToStopMode();
        // 清理上一轮残留的「执行中...」结果
        clearPendingToolResults();
      } else {
        switchToSendMode();
        streamingAgent = false;
        // 移除所有 agent 消息的 streaming 标记
        document.querySelectorAll('.message.agent.streaming').forEach(el => {
          el.classList.remove('streaming');
          el.classList.add('round-ended');
        });
      }
      updateStatus();
      updateInfoPanel();
      break;
    }

    case 'context': {
      const chars = msg.chars;
      const tokens = msg.tokens;
      if (tokens > 0) {
        ctxDisplay.textContent = `ctx: ${tokens}t`;
        ctxDisplay.title = `字符 ${chars.toLocaleString()}，Token ${tokens.toLocaleString()}`;
      } else {
        ctxDisplay.textContent = `ctx: ${chars >= 10000 ? (chars / 1000).toFixed(1) + 'k' : chars}ch`;
      }
      break;
    }

    case 'tool-call': {
      _toolCallTotal = msg.count;
      toolsBadge.style.display = 'inline';
      toolsBadge.textContent = `工具 ${msg.count}`;
      panelState.toolCallCount = msg.count;
      // 更新有 tool-container 的气泡中的计数器
      var _agEls = document.querySelectorAll('.message.agent');
      for (var _ti = _agEls.length - 1; _ti >= 0; _ti--) {
        var _cntEl = _agEls[_ti].querySelector('.content');
        if (_cntEl && _cntEl._toolHistory) {
          renderToolCounter(_cntEl);
          break;
        }
      }
      updateInfoPanel();
      break;
    }

    case 'thinking': {
      thinkingActive = msg.active;
      if (msg.active) {
        thinkingSpinner.style.display = 'block';
      } else {
        thinkingSpinner.style.display = 'none';
      }
      updateStatus();
      break;
    }

    case 'listen': {
      listenActive = msg.name !== null;
      updateStatus();
      break;
    }
  }
}

// ════════════════════════════════════════════════════════
// 信息面板 — 仅更新面板数据，不再覆盖 #panel-content
// ════════════════════════════════════════════════════════
function updateInfoPanel() {
  // 数据已由各调用点追踪，保留函数签名兼容调用
  // DOM 渲染交由右侧面板标签切换管理
  // 可通过 statusText 展示关键信息
  const el = document.getElementById('status-text');
  if (el && panelState.totalMessages > 0) {
    // 可选：状态栏显示消息统计
  }
}

// ════════════════════════════════════════════════════════
// 右侧面板 — 标签切换 & 文件树 / Git 变更
// ════════════════════════════════════════════════════════

let currentTab = 'files';

/** 初始化右侧面板：绑定标签点击，加载默认标签 */
function initRightPanel() {
  const tabs = document.querySelectorAll('.panel-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      if (targetTab === currentTab) return;
      // 更新标签样式
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentTab = targetTab;
      loadTabContent(targetTab);
    });
  });
  // 加载默认标签（Files）
  loadTabContent('files');
}

/** 根据标签名称加载内容 */
function loadTabContent(tab) {
  const container = document.getElementById('panel-content');
  if (!container) return;
  if (tab === 'files') {
    container.innerHTML = '<div class="file-tree-loading">加载中…</div>';
    loadFileTree(container);
  } else if (tab === 'changes') {
    container.innerHTML = '<div class="file-tree-loading">加载中…</div>';
    loadGitChanges(container);
  }
}

/** 加载项目文件树 */
async function loadFileTree(container) {
  try {
    const tree = await api.readFileTree('');
    if (tree && tree.error) {
      container.innerHTML = '<div class="panel-empty">' + escapeHtml(tree.error) + '</div>';
      return;
    }
    if (!tree || tree.length === 0) {
      container.innerHTML = '<div class="panel-empty">项目为空</div>';
      return;
    }
    const html = renderTreeNodes(tree, 0);
    container.innerHTML = '<div class="file-tree">' + html + '</div>';
    bindTreeEvents(container);
  } catch (err) {
    container.innerHTML = '<div class="panel-empty">加载失败: ' + escapeHtml(err.message) + '</div>';
  }
}

/** 递归渲染文件树节点 */
function renderTreeNodes(nodes, depth) {
  let html = '';
  for (const node of nodes) {
    if (node.type === 'folder') {
      html += '<div class="tree-item folder" data-path="' + escapeHtml(node.path) + '">';
      html += '  <span class="tree-toggle">▶</span>';
      html += '  <span class="tree-folder-icon">📁</span>';
      html += '  <span class="tree-name">' + escapeHtml(node.name) + '</span>';
      html += '</div>';
      if (node.children && node.children.length > 0) {
        html += '<div class="tree-children" style="display:none">';
        html += renderTreeNodes(node.children, depth + 1);
        html += '</div>';
      }
    } else {
      const tagMap = { js: 'tag-yellow', ts: 'tag-blue', json: 'tag-yellow', npm: 'tag-red', mjs: 'tag-yellow', cjs: 'tag-yellow' };
      const tagClass = tagMap[node.ext] || '';
      const tagLabel = node.ext === 'json' ? '{}' : node.ext === 'npmrc' ? 'npm' : node.ext;
      const showTag = ['js','ts','json','npmrc','mjs','cjs'].includes(node.ext) ? 'tag-yellow' : '';
      html += '<div class="tree-item file" data-path="' + escapeHtml(node.path) + '">';
      if (tagClass) {
        html += '  <span class="tree-tag ' + tagClass + '">' + tagLabel.toUpperCase() + '</span>';
      } else {
        html += '  <span class="tree-icon">≡</span>';
      }
      html += '  <span class="tree-name">' + escapeHtml(node.name) + '</span>';
      html += '</div>';
    }
  }
  return html;
}

/** 绑定文件树的折叠展开事件 */
function bindTreeEvents(container) {
  container.querySelectorAll('.tree-item.folder').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const toggle = el.querySelector('.tree-toggle');
      const children = el.nextElementSibling;
      if (children && children.classList.contains('tree-children')) {
        const isHidden = children.style.display === 'none';
        children.style.display = isHidden ? 'block' : 'none';
        if (toggle) toggle.textContent = isHidden ? '▼' : '▶';
      }
    });
  });
  // 文件点击
  container.querySelectorAll('.tree-item.file').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const path = el.dataset.path;
      if (path) {
        // 可选：打开文件
        console.log('[panel] 点击文件:', path);
      }
    });
  });
}

/** 加载 Git 变更列表 */
async function loadGitChanges(container) {
  try {
    const changes = await api.readGitStatus();
    if (changes && changes.error) {
      container.innerHTML = '<div class="panel-empty">' + escapeHtml(changes.error) + '</div>';
      return;
    }
    if (!changes || changes.length === 0) {
      container.innerHTML = '<div class="panel-empty">工作区干净，无变更</div>';
      return;
    }
    let html = '<div class="changes-list">';
    for (const change of changes) {
      const statusMap = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', '??': 'untracked' };
      const cls = statusMap[change.status] || 'unknown';
      html += '<div class="change-item ' + cls + '" title="' + escapeHtml(change.file) + '">';
      html += '  <span class="change-status">' + escapeHtml(change.status) + '</span>';
      html += '  <span class="change-file">' + escapeHtml(change.file) + '</span>';
      html += '</div>';
    }
    html += '</div>';
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = '<div class="panel-empty">加载失败: ' + escapeHtml(err.message) + '</div>';
  }
}

// ════════════════════════════════════════════════════════
// 状态栏显示
// ════════════════════════════════════════════════════════
function updateStatus() {
  if (!connected) {
    statusText.textContent = '正在连接 Agent...';
    return;
  }

  if (listenActive) {
    statusText.textContent = '审查中...';
    statusDot.className = 'status-dot processing';
    return;
  }

  if (processing) {
    if (thinkingActive) {
      statusText.textContent = 'AI 思考中...';
    } else {
      statusText.textContent = '处理中...';
    }
    statusDot.className = 'status-dot processing';
    return;
  }

  statusText.textContent = '就绪';
  statusDot.className = 'status-dot connected';
}

// ════════════════════════════════════════════════════════
// 连接状态处理
// ════════════════════════════════════════════════════════
api.onAgentStatus((status) => {
  connected = status.connected;
  if (status.code !== undefined && !status.connected) {
    statusText.textContent = 'Agent 已退出（code: ' + status.code + '）';
    statusDot.className = 'status-dot disconnected';
  } else if (status.connected) {
    connected = true;
    updateStatus();
  }
});

// ════════════════════════════════════════════════════════
// stderr 日志
// ════════════════════════════════════════════════════════
api.onAgentStderr((text) => {
  // 在开发时显示错误
  console.error('[agent]', text);
});

// ════════════════════════════════════════════════════════
// 初始化
// ════════════════════════════════════════════════════════
// 注册 agent 消息处理
api.onAgentMessage(handleAgentMessage);

// 显示初始状态
statusText.textContent = '正在连接 Agent...';

// 显示欢迎消息
appendMessage({ role: 'banner', content: '', createdAt: Date.now() });
appendMessage({ role: 'system', content: 'Seek Agent 已启动。输入消息开始对话。' });
appendMessage({ role: 'blank', content: '' });

// 聚焦输入框
setTimeout(() => messageInput.focus(), 300);

// 初始化右侧面板
if (document.querySelector('.panel-tab')) {
  initRightPanel();
}










































