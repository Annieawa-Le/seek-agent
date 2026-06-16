/**
 * InlineCompletionItemProvider
 *
 * 将光标位置上下文发送到 agent，获取 AI 补全建议。
 * 支持自动触发（加防抖）和手动触发。
 */

import * as vscode from 'vscode';
import { AgentClient } from './agentClient';

/** 自动触发防抖间隔（ms） */
const AUTO_DEBOUNCE_MS = 250;

export class SeekCompletionProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRequestId = 0;

  constructor(private client: AgentClient) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
    if (!this.client.isConnected) {
      return undefined;
    }

    // 自动触发：防抖 + 快速路径
    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
      return this.handleAutomatic(document, position, token);
    }

    // 手动触发（Ctrl+Space）：直接请求
    return this.requestCompletion(document, position, token);
  }

  /** 自动触发：防抖后请求 */
  private async handleAutomatic(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    // 取消上一次防抖
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // 等待防抖间隔
    await new Promise<void>((resolve) => {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        resolve();
      }, AUTO_DEBOUNCE_MS);
    });

    if (token.isCancellationRequested) return undefined;

    return this.requestCompletion(document, position, token);
  }

  /** 执行补全请求 */
  private async requestCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const requestId = ++this.lastRequestId;

    const offset = document.offsetAt(position);
    const text = document.getText();

    try {
      const result = await this.client.requestCompletion({
        uri: document.uri.toString(),
        text,
        offset,
        language: document.languageId,
        triggerKind: vscode.InlineCompletionTriggerKind.Invoke, // 统一用 invoke
      });

      // 如果已经被取消或有更新的请求，丢弃结果
      if (token.isCancellationRequested || requestId !== this.lastRequestId) {
        return undefined;
      }

      if (!result.items.length) return undefined;

      return result.items.map((item) => {
        const range = item.range
          ? new vscode.Range(
              document.positionAt(item.range.start),
              document.positionAt(item.range.end),
            )
          : undefined;

        const completionItem = new vscode.InlineCompletionItem(item.text, range);
        completionItem.filterText = item.filterText;
        return completionItem;
      });
    } catch {
      return undefined;
    }
  }

  /** 清理资源 */
  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
