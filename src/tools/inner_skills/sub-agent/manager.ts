/**
 * manager.ts — SubAgentManager 单例
 *
 * 管理所有子 agent 的生命周期。
 */

import type { SubAgentState, SubAgentMode, SubAgentStatus, SubmissionPayload } from './types';

// ── 子 agent 注入队列 ──
const pendingInjections: Array<{ name: string; payload: SubmissionPayload }> = [];

/** 向主模型的 messages 数组注入一条子 agent 提交（模拟用户中断） */
export function queueSubmissionInjection(
  name: string,
  payload: SubmissionPayload,
): void {
  pendingInjections.push({ name, payload });
}

/** 消费所有待注入的提交（返回注入内容列表） */
export function drainPendingInjections(): Array<{ name: string; submission: string }> {
  const result = pendingInjections.map(p => ({
    name: p.name,
    submission: `【${p.name} 提交工作结果】\n概要: ${p.payload.summary}\n详情: ${p.payload.details}`,
  }));
  pendingInjections.length = 0;
  return result;
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
    if (this.agents.has(config.name)) {
      this.agents.delete(config.name);
    }
    const agent: SubAgentState = {
      name: config.name,
      mode: config.mode,
      status: 'idle',
      tools: config.tools ?? [],
      systemPrompt: config.systemPrompt,
      context: config.context,
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

  /** 销毁子 agent */
  fire(name: string): boolean {
    // reject 任何挂起的等待者
    const waiter = this.submissionWaiters.get(name);
    if (waiter) {
      waiter.reject(new Error(`子模型 "${name}" 已被销毁`));
      this.submissionWaiters.delete(name);
    }
    return this.agents.delete(name);
  }

  /** 销毁所有子 agent */
  fireAll(): void {
    for (const [, waiter] of this.submissionWaiters) {
      waiter.reject(new Error('所有子模型已被销毁'));
    }
    this.submissionWaiters.clear();
    this.agents.clear();
  }
}

/** 全局单例 */
export const subAgentManager = new SubAgentManager();

