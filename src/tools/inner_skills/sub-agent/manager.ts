/**
 * manager.ts — SubAgentManager 单例
 *
 * 管理所有子 agent 的生命周期。
 * 持有一个懒惰解析的工具注册表引用，避免与 tools/index.ts 的循环依赖。
 */

import type { SubAgentState, SubAgentMode, SubAgentStatus, SubmissionPayload, ListenMode } from './types';
import { PatchStaging } from '../../patch-staging';

// ── 工具注册表（懒惰注入，避免循环依赖） ──
let _toolRegistry: Record<string, any> | null = null;

/** 注入全局工具注册表引用（由 tools/index.ts 在构建完成后调用） */
export function setToolRegistry(registry: Record<string, any>): void {
  _toolRegistry = registry;
}

/** 获取全局工具注册表引用 */
export function getToolRegistry(): Record<string, any> {
  return _toolRegistry ?? {};
}

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
    listenMode?: ListenMode;
    listenTools?: string[];
    analyzeTarget?: string;
    returnTemplate?: string;
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
      listenMode: config.listenMode ?? 'call',
      listenTools: config.listenTools,
      analyzeTarget: config.analyzeTarget,
      returnTemplate: config.returnTemplate,
      patchStaging: (config.mode === 'clone' || config.mode === 'mission')
        ? new PatchStaging()
        : undefined,
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

  /** 获取监听指定工具的 listen 模式 agent */
  /** 获取监听指定工具的 call 模式 listen agent */
  getListenersForTool(toolName: string): SubAgentState[] {
    return this.getAll().filter(
      a => a.mode === 'listen' && a.listenMode === 'call' && a.listenTools?.includes(toolName),
    );
  }

  /** 获取监听指定工具的 result 模式 listen agent */
  getResultListenersForTool(toolName: string): SubAgentState[] {
    return this.getAll().filter(
      a => a.mode === 'listen' && a.listenMode === 'result' && a.listenTools?.includes(toolName),
    );
  }
}

/** 全局单例 */
export const subAgentManager = new SubAgentManager();

// ── Listen 模式自动拦截触发器 ──

/**
 * 在主模型调用某个工具前触发 listen 模式分析。
 * 如果存在监听此工具的 listen agent，自动触发分析并排队提交结果。
 */
export async function triggerListenInterceptors(
  toolName: string,
  args: Record<string, unknown>,
  messages: any[],
): Promise<void> {
  const listeners = subAgentManager.getListenersForTool(toolName);
  if (listeners.length === 0) return;

  const { executeListenAgent } = await import('./runner');

  for (const listener of listeners) {
    try {
      const toolCallData = JSON.stringify({
        tool: toolName,
        arguments: args,
        context: messages.slice(-6).map(m => ({
          role: m.role,
          content: typeof m.content === 'string'
            ? m.content.slice(0, 300)
            : `[${(m.content as any[])?.length || 0} parts]`,
        })),
      }, null, 2);

      subAgentManager.updateStatus(listener.name, 'running');
      const result = await executeListenAgent(
        listener,
        toolCallData,
        `自动监听分析: 主模型调用了 ${toolName}`,
      );

      if (result !== null) {
        try {
          const parsed = JSON.parse(result);
          queueSubmissionInjection(listener.name, parsed);
        } catch {
          queueSubmissionInjection(listener.name, { summary: `监听分析: ${toolName}`, details: result });
        }
      }
    } catch (err: any) {
      subAgentManager.setError(listener.name, `监听分析出错: ${err.message}`);
    }
  }
}

/**
 * 在主模型执行完某个工具后触发 result 模式分析。
 * 如果存在监听此工具结果的 listen agent，自动触发分析工具执行结果并排队提交。
 */
export async function triggerResultListenInterceptors(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  messages: any[],
): Promise<void> {
  const listeners = subAgentManager.getResultListenersForTool(toolName);
  if (listeners.length === 0) return;

  const { executeListenAgent } = await import('./runner');

  for (const listener of listeners) {
    try {
      const resultData = JSON.stringify({
        tool: toolName,
        arguments: args,
        output: output.slice(0, 2000),
        context: messages.slice(-6).map(m => ({
          role: m.role,
          content: typeof m.content === 'string'
            ? m.content.slice(0, 300)
            : `[${(m.content as any[])?.length || 0} parts]`,
        })),
      }, null, 2);

      subAgentManager.updateStatus(listener.name, 'running');
      const result = await executeListenAgent(
        listener,
        resultData,
        `自动监听分析: 主模型调用了 ${toolName} 并得到结果`,
      );

      if (result !== null) {
        try {
          const parsed = JSON.parse(result);
          queueSubmissionInjection(listener.name, parsed);
        } catch {
          queueSubmissionInjection(listener.name, { summary: `结果分析: ${toolName}`, details: result });
        }
      }
    } catch (err: any) {
      subAgentManager.setError(listener.name, `结果监听分析出错: ${err.message}`);
    }
  }
}







