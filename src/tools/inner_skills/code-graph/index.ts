/**
 * code-graph skill 入口
 * 代码图谱：符号提取 / 引用查找 / 调用链追踪 / 文件依赖 / 影响面分析
 */
import {
  listSymbolsTool,
  readSymbolTool,
  findReferencesTool,
  traceCallersTool,
  traceCalleesTool,
  traceChainTool,
  fileDepsTool,
  blastRadiusTool,
} from './scripts/tools.js';

const tools: Record<string, any> = {
  list_symbols: listSymbolsTool,
  read_symbol: readSymbolTool,
  find_references: findReferencesTool,
  trace_callers: traceCallersTool,
  trace_callees: traceCalleesTool,
  trace_chain: traceChainTool,
  file_deps: fileDepsTool,
  blast_radius: blastRadiusTool,
};

export default tools;
