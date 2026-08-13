import { Command } from '../types';
import type { UIMessage } from '../../ui';
import { sanitizeToolInput } from '../../tools';
import path from 'node:path';
import fs from 'node:fs';
import { getWorkspaceRoot, getSessionsRoot, setCwd } from '../../workdir';
import { friendlyToolCallLabel, friendlyToolResultLabel } from '../../assets/tool-translations';
import { setActiveModes } from '../../modes/registry';
import { KB_INJECT_PREFIX } from '../../modes/preprocess';
import { subAgentManager, notifyTaskDispatched, hasPendingInjections } from '../../tools/inner_skills/sub-agent/manager';
import { subagentRegistryStore } from '../../tools/subagent-registry-store';

/** 会话保存目录 */
/** 会话保存目录 */
function getSessionDir(): string {
  return path.join(getSessionsRoot(), 'sessions');
}

/** 列出所有保存的会话（按修改时间倒序）。新结构：sessions/{sessionId}/session.json；兼容旧单文件（导出供测试） */
export function listSessionFiles(): { name: string; filePath: string; mtime: Date }[] {
  const dir = getSessionDir();
  if (!fs.existsSync(dir)) return [];
  const result: { name: string; filePath: string; mtime: Date }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // 新结构：文件夹名 = sessionId，主会话在 session.json
      const sp = path.join(dir, entry.name, 'session.json');
      if (fs.existsSync(sp)) {
        const stat = fs.statSync(sp);
        result.push({ name: entry.name, filePath: sp, mtime: stat.mtime });
      }
    } else if (entry.name.endsWith('.json')) {
      // 旧结构：sessions/*.json（迁移前兼容）
      const fp = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fp);
        result.push({ name: entry.name.replace(/\.json$/, ''), filePath: fp, mtime: stat.mtime });
      } catch { /* skip */ }
    }
  }
  return result.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}


/**
 * 从 session 的 agentMessages 重建 UI 消息列表。
 * 完整还原 user 文本、assistant 文本，以及 tool-call / tool-result 工具调用块，
 * 使加载后的对话历史与保存时一致。
 * （导出：供 electron-entry 的 session:activate 重放 UI 消息使用）
 */
export function reconstructUIMessages(data: any): UIMessage[] {
  const uiMessages: UIMessage[] = [];
  const agentMessages: any[] = data.agentMessages || [];

  // toolCallId → { toolName, args }：供 tool-result 重建显示标签
  const toolCallMap = new Map<string, { toolName: string; args: Record<string, unknown> }>();

  for (const msg of agentMessages) {
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : (msg.content || [])
            .filter((p: any) => p?.type === 'text')
            .map((p: any) => p.text)
            .join('\n');
      // 排除系统注入的 [工作记忆] / [知识库检索] 与【子模型提交】（每轮重新注入/实时展示，加载时不重复展示）
      if (text && !text.startsWith('[工作记忆]') && !text.startsWith(KB_INJECT_PREFIX) && !text.startsWith('【') && !text.startsWith('[Worklog#')) {
        uiMessages.push({ role: 'user', content: text });
      }
    } else if (msg.role === 'assistant') {
      // assistant 消息可能为纯字符串（旧格式）或 parts 数组（含 text / tool-call / reasoning）
      const parts = typeof msg.content === 'string'
        ? (msg.content ? [{ type: 'text', text: msg.content }] : [])
        : (msg.content || []);

      let textBuffer: string[] = [];
      for (const p of parts) {
        if (p?.type === 'text' && p.text) {
          textBuffer.push(p.text);
        } else if (p?.type === 'tool-call') {
          // 先收尾已积累的文本，保持与实时会话一致的顺序
          if (textBuffer.length > 0) {
            uiMessages.push({ role: 'agent', content: textBuffer.join('\n') });
            textBuffer = [];
          }
          const args = sanitizeToolInput(p.input);
          toolCallMap.set(p.toolCallId, { toolName: p.toolName, args });
          uiMessages.push({
            role: 'tool',
            content: friendlyToolCallLabel(p.toolName, args),
            toolMeta: { toolName: p.toolName, args },
          });
        } else if (p?.type === 'reasoning' && p.text) {
          // 思考过程：先收尾文本，再输出 thinking 气泡，保持与实时会话一致的顺序
          if (textBuffer.length > 0) {
            uiMessages.push({ role: 'agent', content: textBuffer.join('\n') });
            textBuffer = [];
          }
          uiMessages.push({ role: 'thinking', content: p.text });
        }
      }
      if (textBuffer.length > 0) {
        uiMessages.push({ role: 'agent', content: textBuffer.join('\n') });
      }
    } else if (msg.role === 'tool') {
      // tool-result：与前面的 tool-call 配对，渲染成 RESULT 块
      const parts = Array.isArray(msg.content) ? msg.content : [];
      for (const p of parts) {
        if (p?.type !== 'tool-result') continue;
        const meta = toolCallMap.get(p.toolCallId);
        const raw = p.output?.value;
        const outText = typeof raw === 'string' ? raw : String(raw ?? '');
        const label = meta
          ? friendlyToolResultLabel(meta.toolName, meta.args, outText)
          : outText;
        uiMessages.push({ role: 'tool', content: label, fullOutput: outText });
      }
    }
    // system 消息跳过：agent 启动时已重新注入
  }

  return uiMessages;
}

export const LoadSessionCommand: Command = {
  name: 'loadsession',
  aliases: ['/loadsession', '/load'],
  description: '加载已保存的对话会话',
  usage: '/loadsession [name|list]',
  match(input: string): boolean {
    const t = input.trim().toLowerCase();
    return t === '/loadsession' || t.startsWith('/loadsession ') ||
           t === 'loadsession' || t.startsWith('loadsession ') ||
           t === '/load' || t.startsWith('/load ');
  },
  execute(input: string, ctx): void {
    const trimmed = input.trim();
    const nameMatch = trimmed.match(/^\/(?:loadsession|load)\s+(.+)/)
      || trimmed.match(/^loadsession\s+(.+)/);

    const sessions = listSessionFiles();

    // ── 无参或 list 参数：列出可用会话 ──
    if (!nameMatch || nameMatch[1].trim().toLowerCase() === 'list') {
      ctx.ui.addUserMessage(input);
      if (sessions.length === 0) {
        ctx.ui.addAgentMessage('📂 没有找到已保存的会话。\n使用 `/savesession [name]` 保存当前对话。');
        return;
      }
      let msg = '**已保存的会话:**\n\n';
      for (const s of sessions) {
        const size = fs.statSync(s.filePath).size;
        const sizeStr = size > 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;
        const timeStr = s.mtime.toLocaleString('zh-CN', { hour12: false });
        msg += `- \`${s.name}\`  (${sizeStr}, ${timeStr})\n`;
      }
      msg += '\n使用 `/loadsession <name>` 加载对应会话。';
      ctx.ui.addAgentMessage(msg);
      return;
    }

    // ── 加载指定会话 ──
    const sessionName = nameMatch[1].trim().replace(/\.json$/, '');
    // 新结构优先：sessions/{sessionId}/session.json（文件夹）；回退旧单文件 sessions/{name}.json
    const folderPath = path.join(getSessionDir(), sessionName, 'session.json');
    const legacyPath = path.join(getSessionDir(), `${sessionName}.json`);

    let filePath: string;
    if (fs.existsSync(folderPath)) {
      filePath = folderPath;
    } else if (fs.existsSync(legacyPath)) {
      filePath = legacyPath;
    } else {
      // 尝试模糊匹配：查找名字中包含输入的第一个会话
      const match = sessions.find(s =>
        s.name.toLowerCase() === sessionName.toLowerCase() ||
        s.name.toLowerCase().includes(sessionName.toLowerCase())
      );
      if (!match) {
        ctx.ui.addUserMessage(input);
        ctx.ui.addAgentMessage(`❌ 未找到会话「${sessionName}」。\n使用 \`/loadsession list\` 查看所有可用会话。`);
        return;
      }
      filePath = match.filePath;
    }

    // ── 读取会话文件（新结构下 payload 在独立 payload.json，旧单文件内联 payloads 字段） ──
    let data: any;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      data = JSON.parse(raw);
      if (data.payloads === undefined) {
        const payloadPath = path.join(path.dirname(filePath), 'payload.json');
        if (fs.existsSync(payloadPath)) {
          try {
            const pp = JSON.parse(fs.readFileSync(payloadPath, 'utf-8'));
            data.payloads = Array.isArray(pp.payloads) ? pp.payloads : [];
          } catch { data.payloads = []; }
        }
      }
    } catch (err: any) {
      ctx.ui.addUserMessage(input);
      ctx.ui.addAgentMessage(`❌ 无法读取会话文件: ${err.message}`);
      return;
    }

    if (!data.agentMessages || !Array.isArray(data.agentMessages)) {
      ctx.ui.addUserMessage(input);
      ctx.ui.addAgentMessage('❌ 会话文件格式错误，缺少 agentMessages 字段。');
      return;
    }

    // ── 切换会话前：清空当前内存中的子 Agent（不删持久化上下文，切回该会话时可恢复） ──
    subAgentManager.clearForLoad();

    // ── 恢复 agent 消息 ──
    ctx.agent.setMessages(data.agentMessages);
    // ── 恢复发给模型的完整 payload 历史（附加字段，供 WebUI「记忆」面板展示） ──
    ctx.agent.setPayloadHistory(data.payloads || []);
    // ── 恢复会话 ID（后续自动保存会覆盖同一文件） ──
    // 会话身份统一以文件内 sessionId 为准（固定形态 session-xxxx-xxxx-xxxx / new-xxx / xxxx-xxxx-xxxx），
    // 主进程已在会话列表扫描时一次性迁移历史标题污染文件；此处无条件对齐，
    // 避免恢复会话后身份漂移（worklog 分区 / 自动保存文件随之稳定）。
    if (data.sessionId) {
      ctx.agent.setSessionId(data.sessionId);
    }

    // ── 恢复子 Agent 注册（loadsession 自动加载活跃子 Agent，接入工具系统） ──
    // registry 在每次会话保存时随 session.json 同步落盘；此处重新注册进 SubAgentManager，
    // 派活（agent_task）时自动从 subagentContextStore 加载各自上下文延续。
    const registryAgents = subagentRegistryStore.load();
    for (const entry of registryAgents) {
      subAgentManager.restore(entry);
    }
    if (registryAgents.length > 0) {
      // 通知外部（electron-entry 推送 sidebar:data）：通讯录立即出现恢复的子模型
      notifyTaskDispatched();
    }
    // ── 恢复后排空本会话待注入的提交（跨会话后台任务切回时，结果立即回到对话） ──
    if (hasPendingInjections()) {
      ctx.agent.onSubAgentSubmission?.().catch(() => {});
    }
    // ── 恢复工作目录（如果保存的路径在当前工作区内） ──
    if (data.cwd) {
      try {
        const resolved = path.resolve(data.cwd);
        fs.accessSync(resolved, fs.constants.F_OK);
        const rel = path.relative(getWorkspaceRoot(), resolved);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
          setCwd(resolved);
        }
      } catch {
        // 目录不可达则忽略
      }
    }

    // ── 重建 UI 显示（WebUI 下 replaceMessages 整体替换，无需恢复提示气泡） ──
    const uiMessages = reconstructUIMessages(data);
    ctx.ui.replaceMessages(uiMessages);

    ctx.ui.addUserMessage(input);
    // ── 恢复会话标题（后续自动保存沿用原标题命名） ──
    if (data.title) {
      ctx.agent.setSessionTitle(data.title);
    }

    // ── 恢复模式（模式随会话持久化） ──
    if (Array.isArray(data.mode) && data.mode.length > 0) {
      setActiveModes(data.mode);
      ctx.agent.reloadPrompt();
    }

  },
};






























