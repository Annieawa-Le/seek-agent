import { subagentContextStore } from '../../subagent-context-store';
import { docPoolStore } from '../../doc-pool-store';
/**
 * manager.ts — SubAgentManager 单例
 *
 * 管理所有子 agent 的生命周期。
 */

import type { SubAgentState, SubAgentMode, SubAgentStatus, SubmissionPayload } from './types';
import type { ModelMessage } from 'ai';

// ── 子 agent 注入队列（按会话分区：sessionId -> 队列） ──
// 子 Agent 后台执行跨会话进行：提交结果入队到其所属会话，
// 只有当前会话的提交立即触发排空；其他会话的等切回时再注入。
const pendingInjections = new Map<string, Array<{ name: string; payload: SubmissionPayload }>>();

/** 提交监听器：入队后通知 agent 排空（CLIAAgent 注册，用于空闲时触发新一轮） */
let submissionListener: (() => void) | null = null;
export function setSubmissionListener(fn: (() => void) | null): void {
  submissionListener = fn;
}

/**
 * 向主模型的 messages 数组注入一条子 agent 提交（入队 + 通知监听器）。
 * ownerSid 缺省取当前会话；只有属于当前会话的提交才立即触发排空（
 * 跨会话的后台任务完成时静默入队，等切回其所属会话时经 drain 注入）。
 */
export function queueSubmissionInjection(
  name: string,
  payload: SubmissionPayload,
  ownerSid?: string,
): void {
  const sid = ownerSid || subagentContextStore.getSessionId();
  const list = pendingInjections.get(sid) || [];
  list.push({ name, payload });
  pendingInjections.set(sid, list);
  if (sid === subagentContextStore.getSessionId()) {
    submissionListener?.();
  }
}

/** 消费指定（缺省当前）会话的所有待注入提交 */
export function drainPendingInjections(sid?: string): Array<{ name: string; payload: SubmissionPayload }> {
  const s = sid || subagentContextStore.getSessionId();
  const list = pendingInjections.get(s) || [];
  pendingInjections.delete(s);
  return list;
}

/** 指定（缺省当前）会话是否有待注入的子模型提交（供 agent 轮末兜底触发新一轮） */
export function hasPendingInjections(sid?: string): boolean {
  const s = sid || subagentContextStore.getSessionId();
  return (pendingInjections.get(s) || []).length > 0;
}

// ── 派活监听器 ──
/** 派活监听器：spawn_agent / agent_task 被调用时通知外部（electron-entry 注册，用于推送 sidebar:data 刷新通讯录） */
let taskListener: (() => void) | null = null;
export function setTaskListener(fn: (() => void) | null): void {
  taskListener = fn;
}

/** 通知外部：有新的子 Agent 创建/派活（渲染层通讯录立即刷新） */
export function notifyTaskDispatched(): void {
  taskListener?.();
}

// ── SubAgentManager ──

class SubAgentManager {
  private agents = new Map<string, SubAgentState>();
  /** 提交等待器：name -> { resolve, reject } */
  private submissionWaiters = new Map<string, {
    resolve: (value: string) => void;
    reject: (err: Error) => void;
  }>();

  /** 注册一个新子 agent */
  spawn(config: {
    mode: SubAgentMode;
    name: string;
    tools: string[];
    systemPrompt?: string;
    context?: string;
    // instructor 模式
    requirement?: string;
    maxRounds?: number;
  }): SubAgentState {
    // 同名且正在运行（可能是其他会话的后台任务）：拒绝重建，避免后台任务状态丢失
    const existing = this.agents.get(config.name);
    if (existing?.status === 'running' && existing.mode !== 'instructor') {
      throw new Error(`子模型 "${config.name}" 正在运行中（后台任务），请等待完成或先销毁`);
    }
    if (this.agents.has(config.name)) {
      this.agents.delete(config.name);
    }
    // 同名重建 = 重新开始：清除该子 Agent 的持久化上下文
    subagentContextStore.remove(config.name);
    const agent: SubAgentState = {
      name: config.name,
      mode: config.mode,
      status: 'idle',
      ownerSessionId: subagentContextStore.getSessionId(),
      tools: config.tools ?? [],
      systemPrompt: config.systemPrompt,
      context: config.context,
      requirement: config.requirement,
      maxRounds: config.maxRounds,
      createdAt: Date.now(),
    };
    this.agents.set(config.name, agent);
    return agent;
  }

  /** 获取指定子 agent */
  get(name: string): SubAgentState | undefined {
    return this.agents.get(name);
  }

  /** 获取所有子 agent（按创建时间排序） */
  getAll(): SubAgentState[] {
    return Array.from(this.agents.values())
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 获取 instructor 模式的 agent（通常只有一个） */
  getInstructor(): SubAgentState | undefined {
    for (const agent of this.agents.values()) {
      if (agent.mode === 'instructor') return agent;
    }
    return undefined;
  }

  /** 获取所有 instructor 模式的 agent */
  getAllInstructors(): SubAgentState[] {
    return Array.from(this.agents.values()).filter(a => a.mode === 'instructor');
  }

  /** 更新状态 */
  updateStatus(name: string, status: SubAgentStatus): void {
    const agent = this.agents.get(name);
    if (agent) {
      agent.status = status;
      if (status === 'running') agent.lastActiveAt = Date.now();
    }
  }

  /** 设置提交结果（resolve 等待者） */
  setSubmission(name: string, submission: string): void {
    const agent = this.agents.get(name);
    if (agent) {
      agent.submission = submission;
      agent.status = 'done';
      agent.lastActiveAt = Date.now();
      const waiter = this.submissionWaiters.get(name);
      if (waiter) {
        waiter.resolve(submission);
        this.submissionWaiters.delete(name);
      }
    }
  }

  /** 设置错误（reject 等待者） */
  setError(name: string, error: string): void {
    const agent = this.agents.get(name);
    if (agent) {
      agent.error = error;
      agent.status = 'error';
      const waiter = this.submissionWaiters.get(name);
      if (waiter) {
        waiter.reject(new Error(error));
        this.submissionWaiters.delete(name);
      }
    }
  }

  /**
   * 等待子模型的下一次提交（异步挂起）
   * 如果子模型已完成/出错，立即返回/抛出
   */
  waitForSubmission(name: string): Promise<string> {
    const agent = this.agents.get(name);
    if (!agent) return Promise.reject(new Error(`子模型 "${name}" 不存在`));
    if (agent.status === 'done' && agent.submission) {
      return Promise.resolve(agent.submission);
    }
    if (agent.status === 'error') {
      return Promise.reject(new Error(agent.error || '子模型执行出错'));
    }
    return new Promise((resolve, reject) => {
      this.submissionWaiters.set(name, { resolve, reject });
    });
  }

  /**
   * 中断指定子 agent 的当前执行（不销毁状态，供便条窗体「停止」按钮）。
   * 返回是否找到该 agent。
   */
  abort(name: string): boolean {
    const agent = this.agents.get(name);
    if (!agent) return false;
    agent.abortController?.abort();
    return true;
  }

  /** 销毁子 agent */
  fire(name: string): boolean {
    // reject 任何挂起的等待者
    const waiter = this.submissionWaiters.get(name);
    if (waiter) {
      waiter.reject(new Error(`子模型 "${name}" 已被销毁`));
      this.submissionWaiters.delete(name);
    }
    // 中断正在后台运行的 instructor / mission 执行流
    const agent = this.agents.get(name);
    agent?.instructorAbortController?.abort();
    agent?.abortController?.abort();
    // 销毁即清理持久化上下文与文件池关联（再次 spawn 同名会重新开始）
    subagentContextStore.remove(name, agent?.ownerSessionId || subagentContextStore.getSessionId());
    docPoolStore.unlinkAgent(name);
    return this.agents.delete(name);
  }

  /** 销毁所有子 agent */
  fireAll(): void {
    for (const [, waiter] of this.submissionWaiters) {
      waiter.reject(new Error('所有子模型已被销毁'));
    }
    this.submissionWaiters.clear();
    this.abortAllInstructors();
    // 清理全部持久化上下文与文件池关联
    for (const name of this.agents.keys()) {
      subagentContextStore.remove(name);
      docPoolStore.unlinkAgent(name);
    }
    this.agents.clear();
  }

  /**
   * 从持久化注册恢复子 agent（loadsession 切换会话用）。
   * 与 spawn 的区别：不清理持久化上下文（上下文文件由 subagentContextStore 独立管理，
   * 下次派活时自动加载延续）；status 复位为 idle，运行时 submission/error 不恢复。
   */
  restore(config: {
    mode: SubAgentMode;
    name: string;
    tools: string[];
    systemPrompt?: string;
    context?: string;
    requirement?: string;
    maxRounds?: number;
    createdAt?: number;
    instructorRoundCount?: number;
    instructorMessages?: ModelMessage[];
  }): SubAgentState {
    const agent: SubAgentState = {
      name: config.name,
      mode: config.mode,
      status: 'idle',
      ownerSessionId: subagentContextStore.getSessionId(),
      tools: config.tools ?? [],
      systemPrompt: config.systemPrompt,
      context: config.context,
      requirement: config.requirement,
      maxRounds: config.maxRounds,
      createdAt: config.createdAt ?? Date.now(),
      instructorRoundCount: config.instructorRoundCount,
      instructorMessages: config.instructorMessages,
    };
    this.agents.set(config.name, agent);
    return agent;
  }

  /**
   * 切换会话（loadsession）时清空非本会话的子 Agent 注册。
   * - mission 且正在运行：保留（后台任务按 ownerSessionId 继续，结果归原会话）
   * - instructor：中断（发散建议与当前轮次强耦合，跨会话后台跑无意义）
   * - 其余（idle/done/error）：直接移除
   * 不删任何持久化上下文（文件保留，切回该会话时经 registry 恢复）。
   */
  clearForLoad(): void {
    for (const [name, agent] of [...this.agents.entries()]) {
      if (agent.status === 'running' && agent.mode !== 'instructor') continue;
      if (agent.mode === 'instructor') {
        agent.instructorAbortController?.abort();
      }
      const waiter = this.submissionWaiters.get(name);
      if (waiter) {
        waiter.reject(new Error('会话切换，子模型已卸载'));
        this.submissionWaiters.delete(name);
      }
      this.agents.delete(name);
    }
  }

  /** 中断所有 instructor 的后台执行（agent 退出/停止时调用） */
  abortAllInstructors(): void {
    for (const agent of this.agents.values()) {
      if (agent.mode === 'instructor') {
        agent.instructorAbortController?.abort();
      }
    }
  }
}

/** 全局单例 */
export const subAgentManager = new SubAgentManager();

























