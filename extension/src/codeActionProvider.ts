/**
 * CodeActionProvider（灯泡菜单）
 *
 * 根据当前上下文（诊断错误 / 代码选中），提供三种 AI 动作：
 * - Fix：针对诊断错误给出修复
 * - Explain：解释选中代码
 * - Refactor：重构选中代码
 *
 * 第一阶段：模拟数据验证 UI 交互
 * 第二阶段：接入真实 agent
 */

import * as vscode from 'vscode';
import { AgentClient } from './agentClient';

/** 简单字符串哈希 */
function hash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return String(h);
}

// ── 请求/响应类型 ──

export interface CodeActionRequest {
  code: string;
  language: string;
  diagnostics: Array<{
    message: string;
    line: number;
  }>;
  selectionText?: string;
}

export interface CodeActionItem {
  title: string;
  type: 'fix' | 'explain' | 'refactor';
  edits?: Array<{
    filePath: string;
    range: { start: number; end: number };
    newText: string;
  }>;
  explanation?: string;
}

export interface CodeActionResult {
  actions: CodeActionItem[];
}

// ── Provider ──

export class SeekCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.RefactorExtract,
  ];

  private cache = new Map<string, { actions: CodeActionItem[]; time: number }>();
  private readonly CACHE_TTL = 5000;

  constructor(private client: AgentClient) {}

  async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeAction[] | undefined> {
    if (!this.client.isConnected) return undefined;

    const hasDiagnostics = context.diagnostics.length > 0;
    const hasSelection = range instanceof vscode.Selection && !range.isEmpty;

    if (!hasDiagnostics && !hasSelection) return undefined;

    // 只看光标所在行的诊断（避免太多无关 action）
    const cursorDiags = hasDiagnostics
      ? context.diagnostics.filter(d => d.range.start.line === (range as vscode.Selection).start.line)
      : [];

    const selText = hasSelection ? document.getText(range as vscode.Selection) : '';
    const cacheKey = `${document.uri.toString()}:${hash(JSON.stringify(cursorDiags.map(d => d.message)))}:${hash(selText)}`;

    // 检查缓存
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.time < this.CACHE_TTL) {
      return this.toCodeActions(cached.actions, document, token);
    }

    // 构造请求
    const request: CodeActionRequest = {
      code: document.getText(),
      language: document.languageId,
      diagnostics: cursorDiags.map(d => ({
        message: d.message,
        line: d.range.start.line,
      })),
      selectionText: selText || undefined,
    };

    try {
      const actions = await this.mockAgent(request, hasDiagnostics, hasSelection);
      this.cache.set(cacheKey, { actions, time: Date.now() });
      this.evictStaleCache();

      if (token.isCancellationRequested) return undefined;
      return this.toCodeActions(actions, document, token);
    } catch {
      return undefined;
    }
  }

  // ── 模拟 agent（第一阶段） ──

  private async mockAgent(
    request: CodeActionRequest,
    hasDiagnostics: boolean,
    hasSelection: boolean,
  ): Promise<CodeActionItem[]> {
    await new Promise(r => setTimeout(r, 200)); // 模拟延迟

    const actions: CodeActionItem[] = [];

    if (hasDiagnostics) {
      const msgs = request.diagnostics.map(d => d.message).join('; ');
      actions.push({
        title: `AI 修复${msgs.length > 0 ? ': ' + msgs.slice(0, 40) + (msgs.length > 40 ? '…' : '') : ''}`,
        type: 'fix',
        edits: request.diagnostics.map(d => ({
          filePath: '',
          range: { start: 0, end: 0 },
          newText: `// TODO: AI fix for: ${d.message}\n`,
        })),
      });
    }

    if (hasSelection) {
      actions.push({
        title: 'AI 解释选中代码',
        type: 'explain',
        explanation:
          '这是对所选代码的解释说明。\n\n' +
          '```\n' +
          (request.selectionText || '').slice(0, 200) +
          '\n```\n\n' +
          '（此解释来自模拟数据，接入真实 agent 后由 LLM 生成。）',
      });

      actions.push({
        title: 'AI 重构选中代码',
        type: 'refactor',
        edits: [{
          filePath: '',
          range: { start: 0, end: 0 },
          newText: '// Refactored code\n',
        }],
      });
    }

    return actions;
  }

  // ── 转换为 VS Code CodeAction ──

  private toCodeActions(
    items: CodeActionItem[],
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): vscode.CodeAction[] {
    if (token.isCancellationRequested) return [];

    return items.map(item => {
      if (item.type === 'explain') {
        const action = new vscode.CodeAction(item.title, vscode.CodeActionKind.QuickFix);
        action.command = {
          command: 'seek.explainCode',
          title: item.title,
          arguments: [item.explanation || ''],
        };
        return action;
      }

      const kind = item.type === 'fix'
        ? vscode.CodeActionKind.QuickFix
        : vscode.CodeActionKind.RefactorExtract;

      const action = new vscode.CodeAction(item.title, kind);

      if (item.edits && item.edits.length > 0) {
        const edit = new vscode.WorkspaceEdit();
        for (const e of item.edits) {
          const range = new vscode.Range(
            document.positionAt(e.range.start),
            document.positionAt(e.range.end),
          );
          edit.replace(document.uri, range, e.newText);
        }
        action.edit = edit;
      }

      action.isPreferred = item.type === 'fix';
      return action;
    });
  }

  private evictStaleCache(): void {
    if (this.cache.size <= 50) return;
    const now = Date.now();
    for (const [k, v] of this.cache) {
      if (now - v.time > this.CACHE_TTL) this.cache.delete(k);
    }
  }
}
