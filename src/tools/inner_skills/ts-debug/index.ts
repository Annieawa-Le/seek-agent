/**
 * ts-debug skill 入口 — TS 项目调试工具集
 *
 * 高频调试命令封装：类型检查、tsx 测试运行、JS 语法检查、构建。
 * 全部走 Node 子进程直跑，UTF-8 输出无损，绕开 cmd 管道乱码。
 */
import { tsTypecheck } from './scripts/typecheck';
import { tsRunTest } from './scripts/run-test';
import { tsNodeCheck } from './scripts/node-check';
import { tsBuild } from './scripts/build';
import { tsDebugPromptGet } from './scripts/prompt-get';

const tools: Record<string, any> = {
  'ts_typecheck': tsTypecheck,
  'ts_run_test': tsRunTest,
  'ts_node_check': tsNodeCheck,
  'ts_build': tsBuild,
  'ts-debug-prompt-get': tsDebugPromptGet,
};

export default tools;
