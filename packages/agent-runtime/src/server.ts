/**
 * seek-agent JSON-RPC server
 *
 * 通过 stdio 与 VS Code 扩展通信。
 * 第一阶段：ping/pong + echo，验证链路。
 * 后续：接入 seek-agent 完整 LLM 引擎和工具系统。
 */

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node.js';
import { streamChat } from './llm/chatHandler.js';
import { generateCompletion } from './llm/completionHandler.js';
import type { ChatMessage } from './llm/chatHandler.js';
export type { ChatMessage } from './llm/chatHandler.js';

// ── 协议定义 ──

export interface PingParams {}
export interface PingResult {
  pong: boolean;
  timestamp: number;
}

export interface EchoParams {
  text: string;
}

export interface EchoResult {
  text: string;
}

export interface CompletionParams {
  uri: string;
  text: string;
  offset: number;
  language: string;
  triggerKind: number;
}

export interface CompletionItem {
  text: string;
  range?: { start: number; end: number };
  filterText?: string;
}

export interface CompletionResult {
  items: CompletionItem[];
}


export interface ChatExecuteParams {
  messages: ChatMessage[];
  context?: {
    workspaceFolder?: string;
    currentFile?: string;
  };
}

// ── Server ──

export class AgentServer {
  /** 当前活动的聊天 AbortController，用于取消 */
  private currentChatAbort: AbortController | null = null;
  private connection: MessageConnection;

  constructor() {
    this.connection = createMessageConnection(
      new StreamMessageReader(process.stdin),
      new StreamMessageWriter(process.stdout),
    );

    // ── 注册方法 ──
    this.connection.onRequest('ping', async (_params: PingParams): Promise<PingResult> => {
      return { pong: true, timestamp: Date.now() };
    });
    // ── 流式聊天 ──
    this.connection.onRequest('chat/execute', async (params: { messages: ChatMessage[]; system?: string; model?: string }) => {
      // 取消上一次未完成的聊天
      if (this.currentChatAbort) {
        this.currentChatAbort.abort();
      }
      const abort = new AbortController();
      this.currentChatAbort = abort;

      const { messages, system, model } = params;
      let fullText = '';
      let wasCancelled = false;

      try {
        await streamChat(
          { messages, system, model, signal: abort.signal },
          (token: string) => {
            if (abort.signal.aborted) {
              wasCancelled = true;
              return;
            }
            fullText += token;
            this.connection.sendNotification('$/chat/token', { token });
          }
        );
      } catch (err: any) {
        if (err?.name === 'AbortError' || abort.signal.aborted) {
          wasCancelled = true;
        } else {
          console.error('[agent-runtime] chat error:', err);
        }
      } finally {
        if (this.currentChatAbort === abort) {
          this.currentChatAbort = null;
        }
      }

      if (!wasCancelled) {
        this.connection.sendNotification('$/chat/end', { fullText });
      }
      return { fullText };
    });

    // ── 取消聊天 ──
    this.connection.onNotification('$/chat/cancel', () => {
      if (this.currentChatAbort) {
        console.error('[agent-runtime] cancelling chat...');
        this.currentChatAbort.abort();
        this.currentChatAbort = null;
      }
    });



    // ── 代码补全 ──
    this.connection.onRequest('completion', async (params: CompletionParams): Promise<CompletionResult> => {
      const { text, offset, language, triggerKind } = params;
      const prefix = text.slice(0, offset);
      const suffix = text.slice(offset);

      const candidates = await generateCompletion(
        { prefix, suffix, language, triggerKind },
        { temperature: 0.3 }
      );

      return { items: candidates };
    });
    this.connection.onRequest('echo', async (params: EchoParams): Promise<EchoResult> => {
      return { text: `[echo] ${params.text}` };
    });

    this.connection.onNotification('exit', async () => {
      await this.shutdown();
    });
  }

  async start(): Promise<void> {
    // stderr 仅供日志，不影响 stdio 通信
    console.error('[agent-runtime] starting...');
    this.connection.listen();
    console.error('[agent-runtime] ready');
  }

  async shutdown(): Promise<void> {
    console.error('[agent-runtime] shutting down...');
    this.connection.dispose();
    process.exit(0);
  }
}

// 作为独立入口时自动启动
const isMainEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMainEntry) {
  const server = new AgentServer();
  server.start().catch((err) => {
    console.error('[agent-runtime] fatal:', err);
    process.exit(1);
  });
}












