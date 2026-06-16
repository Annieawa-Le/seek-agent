/**
 * agent-runtime 入口
 *
 * 启动 JSON-RPC server 并通过 stdio 与 VS Code 扩展通信。
 */

import { AgentServer } from './server.js';

const server = new AgentServer();
server.start().catch((err) => {
  console.error('[agent-runtime] fatal:', err);
  process.exit(1);
});

export { AgentServer } from './server.js';
export type {
  PingParams,
  PingResult,
  EchoParams,
  EchoResult,
  CompletionParams,
  CompletionItem,
  CompletionResult,
  ChatMessage,
  ChatExecuteParams,
} from './server.js';
