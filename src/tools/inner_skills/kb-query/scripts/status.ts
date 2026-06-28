/**
 * kb_status — 知识库状态查询
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getStore, getStoreType, getStoreConnectionString } from './store/factory';
import { embedder } from './embedder';

export const kbStatus = tool({
  description: '查看知识库当前状态：存储后端类型、索引统计、嵌入模型信息等。',
  inputSchema: z.object({}),
  execute: async (): Promise<string> => {
    const storeType = getStoreType();
    const lines: string[] = [
      '📊 知识库状态报告',
      '═══════════════════',
      '',
      `存储后端: ${storeType}`,
      `嵌入模型: ${embedder.model}`,
      `API 地址: ${embedder['baseUrl'] || process.env.EMBEDDING_BASE_URL || 'http://localhost:11434/v1'}`,
    ];

    // 尝试获取向量维度
    try {
      const dim = await embedder.getDim();
      lines.push(`向量维度: ${dim}`);
    } catch {
      lines.push('向量维度: 无法获取（检查 embedding API 是否可用）');
    }

    // 连接串（隐藏密码）
    if (storeType === 'postgres') {
      const connStr = getStoreConnectionString();
      try {
        const url = new URL(connStr);
        url.password = '****';
        lines.push(`数据库: ${url.toString()}`);
      } catch {
        lines.push(`数据库: ${connStr.slice(0, 40)}...`);
      }
    }

    // 获取统计
    try {
      const store = await getStore();
      const stats = await store.stats();
      lines.push('');
      lines.push(`📦 索引统计:`);
      lines.push(`  总块数:     ${stats.totalChunks}`);
      lines.push(`  源文件数:   ${stats.files.length}`);
      lines.push(`  最后更新:   ${stats.lastUpdated}`);

      if (stats.files.length > 0) {
        lines.push(`  文件列表（前 30）:`);
        for (const f of stats.files.slice(0, 30)) {
          lines.push(`    · ${f}`);
        }
        if (stats.files.length > 30) {
          lines.push(`    ... 还有 ${stats.files.length - 30} 个文件`);
        }
      }
    } catch (e: any) {
      lines.push('');
      lines.push(`⚠ 获取统计失败: ${e.message}`);
      lines.push('  提示: 先运行 kb_build_index 构建知识库。');
    }

    return lines.join('\n');
  },
});
