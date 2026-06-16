/**
 * index.ts — sub-agent 技能入口
 *
 * 暴露 5 个工具：
 *   spawn_agent — 创建子模型
 *   agent_task  — 给子模型委派任务并执行
 *   agent_query — 查询子模型状态
 *   agent_fire  — 销毁子模型
 *   a_submission — 提交工作结果（子模型内部使用）
 */
import { tool } from 'ai';
import { z } from 'zod';
import { subAgentManager, queueSubmissionInjection } from './manager';
import { executeChildAgent, executeListenAgent, queryChildAgent } from './runner';
import { getSystemPrompt } from '../../../model-provider';
import type { ModelMessage } from 'ai';

const tools: Record<string, any> = {};

// ═════════════════════════════════════════════════════
// spawn_agent — 创建子模型
// ═════════════════════════════════════════════════════

tools['spawn_agent'] = tool({
  description: `创建/注册一个子 AI 模型，有四种模式可选：
- clone：子模型拥有主模型的所有上下文，最新一条 user 消息是主模型传进去的任务
- mission：子模型拥有独立的系统提示词，主模型传入上下文和任务
- listen：子模型监听主模型特定的工具调用并进行分析
- instructor：子模型作为开发指导，在主模型每轮工作完成后发散思维提出建议`,
  inputSchema: z.object({
    mode: z.enum(['clone', 'mission', 'listen', 'instructor']).describe('子模型模式: clone/mission/listen/instructor'),
    name: z.string().describe('子模型的唯一名称，后续操作通过此名称引用'),
    tools: z.array(z.string()).optional().describe('子模型可调用的工具列表（工具名数组），不传则仅有 a_submission 等内置工具'),
    // clone 模式
    task: z.string().optional().describe('(clone 模式) 要执行的任务内容'),
    // mission 模式
    systemPrompt: z.string().optional().describe('(mission 模式) 子模型的自定义系统提示词'),
    contextAndTask: z.string().optional().describe('(mission 模式) 传给子模型的上下文和任务'),
    // listen 模式
    // listen 模式
    listenMode: z.enum(['call', 'result']).optional().describe('(listen 模式) 监听方式：call（监听调用参数）/ result（监听执行结果），默认 call'),
    analyzeTarget: z.string().optional().describe('(listen 模式) 需要分析的工具调用方面'),
    returnTemplate: z.string().optional().describe('(listen 模式) 返回结果的模板字符串'),
    listenTools: z.array(z.string()).optional().describe('(listen 模式) 需要监听的工具列表'),
    // instructor 模式
    requirement: z.string().optional().describe('(instructor 模式) instructor 的工作要求，指定发散思维的方向'),
    maxRounds: z.number().optional().describe('(instructor 模式) instructor 的最大输出轮次（默认 3）'),
  }),
  execute: async (args) => {
    const { mode, name, tools = [] } = args;

    if (subAgentManager.get(name)) {
      return `ℹ 子模型 "${name}" 已存在，将重新创建。`;
    }

    subAgentManager.spawn({
      mode,
      name,
      tools,
      systemPrompt: args.systemPrompt,
      context: args.contextAndTask,
      listenMode: (args as any).listenMode as any,
      listenTools: args.listenTools,
      analyzeTarget: args.analyzeTarget,
      returnTemplate: args.returnTemplate,
      requirement: (args as any).requirement,
      maxRounds: (args as any).maxRounds,
    });

    // listen 模式自动注入 check_patch + revise_patch，显示时一并算上
    const effectiveTools = mode === 'listen'
      ? [...new Set([...tools, 'check_patch', 'revise_patch'])]
      : tools;
    const toolList = effectiveTools.length > 0 ? effectiveTools.join(', ') : '(无工具)';
    const extra = mode === 'instructor' ? `\n要求: ${(args as any).requirement || '(未设置)'} | 最大轮次: ${(args as any).maxRounds || 3}` : '';
    return `✅ 已创建 ${mode} 模式子模型 "${name}"\n可用工具: ${toolList}${extra}`;
  },
});

// ═════════════════════════════════════════════════════
// agent_task — 给子模型委派任务
// ═════════════════════════════════════════════════════

tools['agent_task'] = tool({
  description: '给已创建的子模型委派任务并立即执行。子模型会独立运行 LLM 循环并使用其被分配的工具。任务完成后子模型会通过 a_submission 提交结果。',
  inputSchema: z.object({
    name: z.string().describe('子模型名称（必须已通过 spawn_agent 创建）'),
    task: z.string().describe('要委派给子模型的详细任务描述'),
    context: z.string().optional().describe('额外上下文信息（mission 模式使用）'),
    toolCallsForListen: z.string().optional().describe('(listen 模式) 需要分析的最近工具调用记录 JSON'),
  }),
  execute: async ({ name, task, context, toolCallsForListen }, { messages }) => {
    const agent = subAgentManager.get(name);
    if (!agent) {
      return `❌ 未找到子模型 "${name}"。请先调用 spawn_agent 创建。`;
    }

    if (agent.status === 'running') {
      return `⚠ 子模型 "${name}" 正在运行中，请等待完成或先销毁。`;
    }

    let result: string;

    if (agent.mode === 'listen') {
      // listen 模式：分析工具调用数据
      const data = toolCallsForListen || context || task;
      const listenResult = await executeListenAgent(agent, data, task);
      if (listenResult === null) {
        return `[${name}] 监听分析完成：一切正常，无需报告。`;
      }
      result = listenResult;
    } else {
      // clone / mission 模式：完整 LLM 执行
      const mainMsgs = messages as ModelMessage[];
      const mainSysPrompt = getSystemPrompt();
      result = await executeChildAgent(agent, mainMsgs, mainSysPrompt, task, context);
    }

    // 解析提交结果并排队注入
    try {
      const parsed = JSON.parse(result);
      queueSubmissionInjection(name, parsed);
      return result;
    } catch {
      return result;
    }
  },
});

// ═════════════════════════════════════════════════════
// agent_query — 查询子模型状态
// ═════════════════════════════════════════════════════

tools['agent_query'] = tool({
  description: '向子模型提问或查询状态。传 question 时，子模型的 LLM 会真正回答问题（不调工具）；传 waitForCompletion 时等待正在运行的子模型完成。不传 question 时返回状态摘要。',
  inputSchema: z.object({
    name: z.string().describe('子模型名称'),
    question: z.string().optional().describe('向子模型提出的问题（将会让子模型的 LLM 回答）'),
    waitForCompletion: z.boolean().optional().default(false).describe('如果子模型正在运行，是否等待其完成后返回结果'),
  }),
  execute: async ({ name, question, waitForCompletion }, { messages }) => {
    const agent = subAgentManager.get(name);
    if (!agent) {
      return `❌ 未找到子模型 "${name}"。`;
    }

    // 等待正在运行的子模型完成
    if (waitForCompletion && agent.status === 'running') {
      try {
        const submission = await subAgentManager.waitForSubmission(name);
        const parsed = JSON.parse(submission);
        return `📋 子模型 "${name}" 已完成\n\n概要: ${parsed.summary}\n详情: ${parsed.details}`;
      } catch (err: any) {
        return `❌ 等待子模型 "${name}" 时出错: ${err.message}`;
      }
    }

    // 向子模型提问（轻量 LLM 调用）
    if (question) {
      try {
        const mainMsgs = messages as ModelMessage[];
        const mainSysPrompt = getSystemPrompt();
        const answer = await queryChildAgent(agent, mainMsgs, mainSysPrompt, question);
        return `💬 ${name} 的回答:\n${answer}`;
      } catch (err: any) {
        return `❌ 向子模型 "${name}" 提问时出错: ${err.message}`;
      }
    }

    // 纯状态查询
    const lines: string[] = [];
    lines.push(`📋 子模型: "${name}"`);
    lines.push(`模式: ${agent.mode}`);
    lines.push(`状态: ${agent.status}`);
    lines.push(`可用工具: ${(agent.tools ?? []).join(', ')}`);
    if (agent.submission) {
      try {
        const p = JSON.parse(agent.submission);
        lines.push(`\n最近提交概要: ${p.summary || '(无)'}`);
      } catch {
        lines.push(`\n最近提交: ${agent.submission}`);
      }
    }
    if (agent.error) lines.push(`\n错误: ${agent.error}`);
    return lines.join('\n');
  },
});
// ═════════════════════════════════════════════════════
// agent_fire — 销毁子模型
// ═════════════════════════════════════════════════════

tools['agent_fire'] = tool({
  description: '解雇/销毁指定名称的子模型。子模型会被立即销毁，其所有状态将丢失。',
  inputSchema: z.object({
    name: z.string().describe('要销毁的子模型名称'),
  }),
  execute: async ({ name }) => {
    const existed = subAgentManager.fire(name);
    if (existed) {
      return `🔥 已销毁子模型 "${name}"。`;
    }
    return `❓ 未找到子模型 "${name}"。`;
  },
});

// ═════════════════════════════════════════════════════
// a_submission — 提交工作结果（子模型内部使用）
// ═════════════════════════════════════════════════════

tools['a_submission'] = tool({
  description: '向主模型提交工作结果。此工具主要由子模型内部调用，用于在完成任务后向主模型汇报。',
  inputSchema: z.object({
    summary: z.string().describe('工作概要总结（一句话）'),
    details: z.string().describe('详细的工作过程和结果'),
  }),
  execute: async ({ summary, details }) => {
    // 全局注册的 a_submission 主要供子模型在执行 agent_task 时使用
    // 其终端行为在 runner.ts 的 buildChildTools 中实现
    // 此处仅作为一个安全兜底
    return JSON.stringify({ type: 'submission', summary, details });
  },
});

export default tools;

















