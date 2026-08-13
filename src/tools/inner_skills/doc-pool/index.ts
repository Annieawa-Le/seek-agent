/**
 * doc-pool skill 入口
 * 提供 doc_pool（文件池编排）与 doc-pool-prompt-get（技能文档）。
 */
import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docPoolStore } from '../../doc-pool-store';
import { subAgentManager } from '../sub-agent/manager';
import { subagentContextStore } from '../../subagent-context-store';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const docPoolTool = tool({
  description: `创建/更新文件池：把子模型「读阶段」（其第一条工具调用起，到第一个写入工具或 TODO 工具为止）读取到的文件片段沉淀到命名文件池。
  建立关联后，该子模型循环中后续的读取会自动记录、被修改过的文件片段会自动移除。
  委派新员工时在 agent_task 传 pool_name 参数，可把池内容作为参考上下文注入其初始对话。`,
  inputSchema: z.object({
    pool_name: z.string().describe('文件池名称（如“渲染组”“后端组”）'),
    name: z.string().describe('要关联的子模型名称（其读阶段读取的内容会存入该池）'),
  }),
  execute: async ({ pool_name, name }) => {
    if (!pool_name?.trim()) return '❌ pool_name 不能为空。';
    const agent = subAgentManager.get(name);
    if (!agent) {
      return `❌ 未找到子模型 "${name}"。请先调用 spawn_agent 创建它，再调用 doc_pool 关联文件池。`;
    }
    // 从子模型持久化上下文扫描已完成的读阶段（运行中的由 runner 实时挂钩补充）
    const persisted = subagentContextStore.load(name);
    const messages = persisted && Array.isArray(persisted.messages) ? persisted.messages : [];
    const pool = docPoolStore.associateAndScan(pool_name.trim(), name, messages);
    return `✅ 文件池 "${pool.poolName}" 已关联子模型「${pool.agentName}」并持久化到 subagent-docs（团队知识沉淀，不随子模型销毁）\n${docPoolStore.describePool(pool.poolName)}\n\n委派员工时在 agent_task 传 pool_name: "${pool.poolName}" 即可注入池上下文。`;
  },
});

export const docPoolPromptGet = tool({
  description: '获取 doc-pool 技能的详细说明文档（SKILL.md），包含文件池用法与读阶段语义。',
  inputSchema: z.object({}),
  execute: async (): Promise<string> => {
    try {
      const skillPath = path.join(__dirname, 'SKILL.md');
      const content = await fs.readFile(skillPath, 'utf-8');
      return content;
    } catch (error) {
      return `读取失败: ${(error as Error).message}`;
    }
  },
});

const tools: Record<string, any> = {
  'doc_pool': docPoolTool,
  'doc-pool-prompt-get': docPoolPromptGet,
};

export default tools;

