/**
 * subagent-registry-store.ts — 活跃子 Agent 注册状态持久化
 *
 * 把当前会话中活跃子 Agent 的注册信息（name/mode/tools/systemPrompt/context/
 * requirement/maxRounds/instructor 状态等）落盘到：
 *   {workspace}/sessions/{sessionId}/subagent-registry.json
 *
 * 与 subagent-context-store（子 Agent 对话历史，逐个子 Agent 一个文件）互补：
 * registry 是「谁在活跃 + 如何注册」的索引，loadsession 切换会话时据此把
 * 子 Agent 重新注册进 SubAgentManager（并自动加载各自上下文，接入工具系统）。
 * 由 agent.ts saveSessionToDisk 每轮同步写入；loadsession 时读取恢复。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getSessionsRoot } from '../workdir';
import type { SubAgentMode } from './inner_skills/sub-agent/types';
import type { ModelMessage } from 'ai';

/** 子 Agent 注册状态（可恢复的 SubAgentState 子集，不含运行时 status/submission/error） */
export interface SubagentRegistryEntry {
  name: string;
  mode: SubAgentMode;
  tools: string[];
  systemPrompt?: string;
  context?: string;
  requirement?: string;
  maxRounds?: number;
  createdAt: number;
  /** instructor 模式：已输出轮次与独立消息历史（恢复后继续发散） */
  instructorRoundCount?: number;
  instructorMessages?: ModelMessage[];
}

function safeName(id: string): string {
  return (id || 'default').replace(/[\\/:*?"<>|]/g, '_');
}

class SubagentRegistryStore {
  private sessionId = '';

  /** agent 启动/切换会话时调用，切换后读写落点自动跟随 */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  private filePath(): string {
    return path.join(getSessionsRoot(), 'sessions', safeName(this.sessionId), 'subagent-registry.json');
  }

  /** 保存活跃子 Agent 注册状态（覆盖写入，自动建目录） */
  save(agents: SubagentRegistryEntry[]): void {
    try {
      const fp = this.filePath();
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, JSON.stringify({
        sessionId: this.sessionId,
        agents,
        updatedAt: new Date().toISOString(),
      }, null, 2), 'utf-8');
    } catch {
      // 落盘失败不影响主流程
    }
  }

  /** 加载注册状态；不存在或损坏返回 [] */
  load(): SubagentRegistryEntry[] {
    try {
      const fp = this.filePath();
      if (!fs.existsSync(fp)) return [];
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      if (parsed && Array.isArray(parsed.agents)) return parsed.agents as SubagentRegistryEntry[];
      return [];
    } catch {
      return [];
    }
  }
}

/** 全局单例（Electron 每会话一个 agent 进程，进程内单例安全） */
export const subagentRegistryStore = new SubagentRegistryStore();

