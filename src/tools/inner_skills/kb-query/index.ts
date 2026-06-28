/**
 * kb-query skill 入口
 *
 * 提供三个工具:
 *   kb_build_index — 构建/重建知识库索引
 *   kb_query       — 语义搜索代码库
 *   kb_status      — 查看知识库状态
 */

import { kbBuildIndex } from './scripts/build-index';
import { kbQuery } from './scripts/query';
import { kbStatus } from './scripts/status';

const tools: Record<string, any> = {
  'kb_build_index': kbBuildIndex,
  'kb_query': kbQuery,
  'kb_status': kbStatus,
};

export default tools;
