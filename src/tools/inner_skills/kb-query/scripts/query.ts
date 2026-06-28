/**
 * kb_query — 知识库语义搜索
 *
 * 接收自然语言问题，检索相关代码片段，返回带文件路径和行号的上下文。
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getStore } from './store/factory';
import { embedder } from './embedder';

export const kbQuery = tool({
  description: `在项目知识库中搜索与问题相关的代码片段。支持语义搜索和混合搜索（向量+关键词）。返回匹配的代码块、文件路径和行号范围。`,
  inputSchema: z.object({
    question: z.string().describe('自然语言问题或搜索关键词，如 "agent 的工具调用是怎么执行的" 或 "processRound 函数"'),
    topK: z.number().default(5).describe('返回的最大结果数（1-20），默认 5'),
    useHybrid: z.boolean().default(true).describe('是否使用混合搜索（向量 + 关键词），默认 true'),
    minScore: z.number().default(0).describe('最低相似度阈值（0-1），低于此值的结果会被过滤，默认 0 不过滤'),
  }),
  execute: async ({ question, topK, useHybrid, minScore }): Promise<string> => {
    const store = await getStore();

    // 1. 将问题转为向量
    const queryEmbedding = await embedder.embed(question);

    // 2. 检索
    let results;
    if (useHybrid) {
      results = await store.hybridSearch({ embedding: queryEmbedding, text: question, topK });
    } else {
      results = await store.search({ embedding: queryEmbedding, topK });
    }

    // 3. 过滤低分结果
    if (minScore > 0) {
      results = results.filter(r => r.score >= minScore);
    }

    if (results.length === 0) {
      return `未找到与「${question}」相关的结果。`;
    }

    // 4. 格式化输出
    let output = `📚 知识库搜索结果（共 ${results.length} 条）：\n\n`;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const { metadata } = r.chunk;

      // 文件位置标识
      const location = metadata.startLine
        ? `${metadata.filePath}:${metadata.startLine}${metadata.endLine && metadata.endLine !== metadata.startLine ? `-${metadata.endLine}` : ''}`
        : metadata.filePath;

      // 类型标签
      const typeBadge = {
        file: '📄',
        function: '🔧',
        class: '🏛',
        doc: '📝',
      }[metadata.type] || '📄';

      output += `### ${i + 1}. ${typeBadge} ${metadata.name || path.basename(metadata.filePath)}\n`;
      output += `**位置**: \`${location}\`\n`;
      output += `**类型**: ${metadata.type} | **相似度**: ${(r.score * 100).toFixed(1)}%\n`;
      if (metadata.description) {
        output += `**说明**: ${metadata.description}\n`;
      }
      output += '\n```' + getLanguageTag(metadata.filePath) + '\n';
      // 截断过长内容
      const content = r.chunk.content.length > 1500
        ? r.chunk.content.slice(0, 1500) + '\n// ... (截断)'
        : r.chunk.content;
      output += content + '\n```\n\n';
    }

    return output;
  },
});

function getLanguageTag(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    mjs: 'javascript', cjs: 'javascript',
    css: 'css', html: 'html', json: 'json',
    md: 'markdown', mdx: 'mdx', txt: 'text',
  };
  return map[ext || ''] || '';
}

import path from 'node:path';
