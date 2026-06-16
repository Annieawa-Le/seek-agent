/**
 * Agent JSON-RPC 客户端
 *
 * 封装 vscode-jsonrpc 连接，提供类型安全的方法调用。
 * 支持流式 chat（token 逐片推送）和取消。
 */

import * as vscode from 'vscode';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import type { ChildProcess } from 'child_process';

// ── RPC 方法类型 ──

interface PingResult {
  pong: boolean;
  timestamp: number;
}

interface EchoResult {
  text: string;
}

export interface CompletionItem {
  text: string;
  range?: { start: number; end: number };
  filterText?: string;
}

export interface CompletionParams {
  uri: string;
  text: string;
  offset: number;
  language: string;
  triggerKind: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatExecuteParams {
  messages: ChatMessage[];
  system?: string;
  model?: string;
}

/** 流式 chat 的 token 回调 */
export type TokenCallback = (token: string) => void;

// ── AgentClient ──

export class AgentClient implements vscode.Disposable {
  private connection: MessageConnection | null = null;
  private process: ChildProcess | null = null;

  /** 连接后全局注册的一次性通知监听器 */
  private globalTokenListener: vscode.Disposable | null = null;
  /** 当前正在等待的 chat Promise（用于取消时拒绝） */
  private currentChatResolve: ((value: string) => void) | null = null;
  private currentChatReject: ((err: Error) => void) | null = null;
  private currentChatTimeout: ReturnType<typeof setTimeout> | null = null;

  /** 连接到 agent 子进程 */
  connect(child: ChildProcess): void {
    this.disconnect();

    this.process = child;
    this.connection = createMessageConnection(
      new StreamMessageReader(child.stdout!),
      new StreamMessageWriter(child.stdin!),
    );

    this.connection.listen();
  }

  /** 断开连接 */
  disconnect(): void {
    this.cleanupCurrentChat();
    if (this.connection) {
      this.connection.dispose();
      this.connection = null;
    }
    this.process = null;
  }

  /** 释放资源 */
  dispose(): void {
    this.disconnect();
  }

  // ── 当前 chat 清理 ──

  private cleanupCurrentChat(): void {
    if (this.currentChatTimeout) {
      clearTimeout(this.currentChatTimeout);
      this.currentChatTimeout = null;
    }
    this.currentChatResolve = null;
    this.currentChatReject = null;
  }

  // ── RPC 方法 ──

  /** ping/pong 健康检查 */
  async ping(): Promise<PingResult> {
    if (!this.connection) throw new Error('Agent not connected');
    return this.connection.sendRequest('ping', {});
  }

  /** echo 测试 */
  async echo(text: string): Promise<EchoResult> {
    if (!this.connection) throw new Error('Agent not connected');
    return this.connection.sendRequest('echo', { text });
  }

  /** 请求代码补全 */
  async requestCompletion(params: CompletionParams): Promise<{ items: CompletionItem[] }> {
    if (!this.connection) return { items: [] };
    return this.connection.sendRequest('completion', params);
  }

  /**
   * 流式聊天：发送消息并逐 token 回调。
   * 返回完整的响应文本。
   * 可通过 VS Code 的 CancellationToken 取消。
   */
  async requestChat(
    params: ChatExecuteParams,
    onToken: TokenCallback,
    cancellationToken?: vscode.CancellationToken,
  ): Promise<string> {
    if (!this.connection) throw new Error('Agent not connected');

    // 清理上一次未完成的 chat
    this.cleanupCurrentChat();

    // 建立一次性通知监听
    const tokenPromise = new Promise<string>((resolve, reject) => {
      this.currentChatResolve = resolve;
      this.currentChatReject = reject;

      // 监听 token
      if (!this.connection) return;
      const tokenDisposable = this.connection.onNotification(
        '$/chat/token',
        (p: { token: string }) => {
          if (p && typeof p.token === 'string') {
            onToken(p.token);
          }
        },
      );
      // 监听 end
      const endDisposable = this.connection.onNotification(
        '$/chat/end',
        (p: { fullText: string }) => {
          tokenDisposable.dispose();
          endDisposable.dispose();
          this.cleanupCurrentChat();
          resolve(p.fullText);
        },
      );

      // 超时保护（2 分钟）
      this.currentChatTimeout = setTimeout(() => {
        tokenDisposable.dispose();
        endDisposable.dispose();
        this.cleanupCurrentChat();
        reject(new Error('Chat timeout'));
      }, 120_000);

      // 如果传入了 CancellationToken，连接取消
      if (cancellationToken) {
        cancellationToken.onCancellationRequested(() => {
          tokenDisposable.dispose();
          endDisposable.dispose();
          this.cancelCurrentChat();
          this.cleanupCurrentChat();
          reject(new Error('Chat cancelled by user'));
        });
      }
    });

    // 发送请求
    this.connection.sendRequest('chat/execute', {
      messages: params.messages,
      system: params.system,
      model: params.model,
    }).catch((err) => {
      // 请求发送失败
      this.cleanupCurrentChat();
    });

    return tokenPromise;
  }

  /**
   * 取消当前的聊天请求。
   * 发送 $/chat/cancel 通知给 agent。
   */
  cancelCurrentChat(): void {
    if (this.connection) {
      try {
        this.connection.sendNotification('$/chat/cancel');
      } catch {
        // 连接可能已断开
      }
    }
  }

  /** 获取连接状态 */
  get isConnected(): boolean {
    return this.connection !== null;
  }
}
