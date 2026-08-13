/**
 * subagent-worklog-store.ts — 子 Agent 工作记录（Worklog）归档存储
 *
 * 子 Agent 的上下文压缩机制与主模型同构（context-compactor.ts），但归档分区不同：
 * 主模型按会话分区（sessions/{sessionId}/worklog/），子 Agent 按「会话 + 子 Agent 名」
 * 分区，落盘到 {workspace}/sessions/{sessionId}/subagent-worklog/{agentName}.json。
 *
 * 用途：
 *  - 子 Agent 长对话被压缩后，其历史工作沉淀为可查的 Worklog（标题/意图/决策/改动）
 *  - Manager 派活前用 agent_worklog 查看「谁做过什么」，优先复用有了解的子 Agent
 *
 * 接口对齐 WorklogStore（setSessionId / nextId / add / get / list），
 * 可注入 context-compactor 的 compactMessages 作 store 参数。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getSessionsRoot } from '../workdir';
import type { WorklogEntry } from './worklog-store';

/** 文件名安全化（sessionId / 子 Agent 名 → 合法文件名） */
function safeName(id: string): string {
  return (id || 'default').replace(/[\\/:*?"<>|]/g, '_');
}

export class SubagentWorklogStore {
  private sessionId = '';
  /** 当前操作的子 Agent 名（setActiveAgent 设置，nextId/add/get/list 作用于它） */
  private activeAgent = '';
  /** agentName → id → entry（内存态，首次访问时懒加载磁盘） */
  private entriesByAgent = new Map<string, Map<string, WorklogEntry>>();

  /** agent 启动/切换会话时调用（与 subagentContextStore 同步点一致） */
  setSessionId(id: string): void {
    this.sessionId = id;
    this.entriesByAgent.clear();
  }

  /** 当前操作的子 Agent（runner 压缩 / agent_worklog 工具查询时设置） */
  setActiveAgent(name: string): void {
    this.activeAgent = name;
  }

  getActiveAgent(): string {
    return this.activeAgent;
  }

  /** 某子 Agent 工作记录的落盘路径 */
  private filePath(agent: string): string {
    return path.join(
      getSessionsRoot(), 'sessions', safeName(this.sessionId),
      'subagent-worklog', `${safeName(agent)}.json`,
    );
  }

  /** 当前子 Agent 的条目表（懒加载磁盘） */
  private entries(): Map<string, WorklogEntry> {
    const agent = this.activeAgent || 'default';
    let m = this.entriesByAgent.get(agent);
    if (!m) {
      m = new Map();
      try {
        const fp = this.filePath(agent);
        if (fs.existsSync(fp)) {
          const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8')) as { entries?: WorklogEntry[] };
          for (const e of parsed.entries ?? []) {
            if (e?.id) m.set(e.id, e);
          }
        }
      } catch {
        // 损坏从空开始，不影响主流程
      }
      this.entriesByAgent.set(agent, m);
    }
    return m;
  }

  private persist(): void {
    const agent = this.activeAgent;
    if (!agent) return;
    const m = this.entriesByAgent.get(agent);
    if (!m) return;
    try {
      const fp = this.filePath(agent);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(
        fp,
        JSON.stringify({ sessionId: this.sessionId, agentName: agent, entries: [...m.values()] }, null, 2),
        'utf-8',
      );
    } catch {
      // 落盘失败不影响内存态
    }
  }

  /** 分配当前子 Agent 的下一个自增 id（W1/W2...） */
  nextId(): string {
    let max = 0;
    for (const id of this.entries().keys()) {
      const n = parseInt(id.replace(/^W/, ''), 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
    return `W${max + 1}`;
  }

  /** 归档一条工作记录（落盘到 subagent-worklog/{agentName}.json） */
  add(entry: WorklogEntry): void {
    this.entries().set(entry.id, entry);
    this.persist();
  }

  get(id: string): WorklogEntry | undefined {
    return this.entries().get(id);
  }

  /** 当前子 Agent 的全部工作记录（按 id 数字序） */
  list(): WorklogEntry[] {
    return [...this.entries().values()].sort((a, b) =>
      a.id.localeCompare(b.id, undefined, { numeric: true }),
    );
  }

  /** 列出当前会话下所有有工作记录的子 Agent（扫描磁盘，供 agent_worklog 工具） */
  listAgents(): { agentName: string; count: number; lastTitle: string }[] {
    const result: { agentName: string; count: number; lastTitle: string }[] = [];
    try {
      const dir = path.join(getSessionsRoot(), 'sessions', safeName(this.sessionId), 'subagent-worklog');
      if (!fs.existsSync(dir)) return result;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as { agentName?: string; entries?: WorklogEntry[] };
          const agentName = parsed.agentName || f.replace(/\.json$/, '');
          const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
          const last = entries[entries.length - 1];
          result.push({
            agentName,
            count: entries.length,
            lastTitle: last?.title ?? '',
          });
        } catch { /* 单个文件损坏跳过 */ }
      }
    } catch {
      // 目录不可读返回空
    }
    return result.sort((a, b) => a.agentName.localeCompare(b.agentName));
  }
}

/** 全局单例（进程内共享） */
export const subagentWorklogStore = new SubagentWorklogStore();

