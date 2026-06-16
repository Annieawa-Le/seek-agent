/**
 * desk-edit.ts — 光标驱动的桌面编辑模式
 *
 * 每个编辑会话维护一个 line_cursor（光标位置在行间），
 * 支持 move（移动）和 selectto（选择到）两种操作。
 * selectto 直接接受起始行号和终止行号（均为 1-based 行号）。
 * 每次 paste 后光标被清除，需先 move 才能继续编辑。
 * 统一通过 line_paste 进行插入/替换。
 */

import { tool, ModelMessage } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { resolvePath } from '../workdir.js';

type MessageHookFn = (messages: ModelMessage[]) => ModelMessage[];

// ═════════════════════════════════════════════════════
// 类型定义
// ═════════════════════════════════════════════════════

interface PatchRecord {
  type: 'move' | 'selectto' | 'paste';
  description: string;
  contentBefore: string;
}

interface SessionState {
  id: string;
  filePath: string;
  originalContent: string;
  currentLines: string[];
  /** 0-based 行间光标位置。N 表示在第 N+1 行前（即 N.5 位置） */
  cursorPos: number;
  /** 选中范围（1-based 行号）。null 表示无选中 */
  selection: { start: number; end: number } | null;
  patchHistory: PatchRecord[];
  trailingNewline: boolean;
  refPinned: boolean;
  cursorActive: boolean;
}

// ═════════════════════════════════════════════════════
// 渲染辅助
// ═════════════════════════════════════════════════════

function renderWithCursor(session: SessionState): string {
  const lines = session.currentLines;
  const cp = session.cursorPos;
  const sel = session.selection;
  const ca = session.cursorActive;
  const maxDigits = String(lines.length).length;
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    let marker = '  ';

    if (sel && lineNum >= sel.start && lineNum <= sel.end) {
      marker = ' >';
    } else if (ca && !sel) {
      if (i === cp && cp < lines.length) {
        marker = ' ^';
      } else if (i === cp - 1 && cp > 0) {
        marker = ' v';
      }
    }

    const num = String(lineNum).padStart(maxDigits);
    out.push(`${marker} ${num}: ${lines[i]}`);
  }

  if (ca && !sel && cp === lines.length && lines.length > 0) {
    out[out.length - 1] = out[out.length - 1].replace(/^\s{2}/, ' v');
  }

  return out.join('\n');
}

function renderStatus(session: SessionState): string {
  const sel = session.selection;
  if (!session.cursorActive) {
    return '光标已清除（不可编辑）';
  }
  const cursorDisplay = `${session.cursorPos}.5`;
  if (sel) {
    return `光标 ${cursorDisplay}，选中行 ${sel.start}-${sel.end}`;
  }
  return `光标 ${cursorDisplay}`;
}

// ═════════════════════════════════════════════════════
// DeskEditManager（单例）
// ═════════════════════════════════════════════════════

class DeskEditManager {
  private sessions = new Map<string, SessionState>();

  isActive(): boolean { return this.sessions.size > 0; }
  getActiveIds(): string[] { return Array.from(this.sessions.keys()); }
  getActiveFiles(): string[] { return Array.from(this.sessions.values()).map(s => s.filePath); }
  getFilePath(id: string): string | null { return this.sessions.get(id)?.filePath ?? null; }
  get sessionCount(): number { return this.sessions.size; }
  hasSession(id: string): boolean { return this.sessions.has(id); }

  isRefPinned(id: string): boolean { return this.sessions.get(id)?.refPinned ?? false; }
  markRefPinned(id: string): void { const s = this.sessions.get(id); if (s) s.refPinned = true; }
  resetRefPin(id: string): void { const s = this.sessions.get(id); if (s) s.refPinned = false; }

  getContentText(id: string): string | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    return renderWithCursor(s);
  }

  // ── 进入 / 退出 ──

  async enter(id: string, filePath: string): Promise<{ success: boolean; result: string }> {
    try {
      const resolved = resolvePath(filePath);
      const raw = await fs.readFile(resolved, 'utf-8');
      const trailingNewline = raw.endsWith('\n');
      const lines = raw.split('\n');
      const currentLines = trailingNewline && lines.length > 0 && lines[lines.length - 1] === ''
        ? lines.slice(0, -1) : lines;

      const session: SessionState = {
        id, filePath: resolved, originalContent: raw,
        currentLines, cursorPos: currentLines.length, selection: null,
        patchHistory: [], trailingNewline, refPinned: false, cursorActive: false,
      };

      this.sessions.set(id, session);

      return {
        success: true,
        result: `🔓 已进入编辑模式\n━━━━━━━━━━━━━━━━━━━━\n📄 ${resolved}（${currentLines.length} 行）\n🆔 id: ${id}\n${renderStatus(session)}`,
      };
    } catch (err: any) {
      return { success: false, result: `❌ 无法打开文件：${err.message}` };
    }
  }

  cancelSession(id: string): string {
    const s = this.sessions.get(id);
    if (!s) return `会话已关闭：${id}`;
    this.sessions.delete(id);
    return `✅ 已退出（未保存），id: ${id}`;
  }

  cancelAll(): string {
    if (!this.isActive()) return '未处于编辑模式';
    this.sessions.clear();
    return `✅ 已退出所有编辑模式（未保存）`;
  }

  // ── line_cursor ──

  moveCursor(id: string, target: number): { result: string; success: boolean } {
    const s = this.sessions.get(id);
    if (!s) return { result: `❌ 未找到会话：${id}`, success: false };
    if (target > s.currentLines.length) {
      target = s.currentLines.length;
    }

    const snapshot = s.currentLines.join('\n');
    s.cursorPos = target;
    s.selection = null;
    s.cursorActive = true;
    s.patchHistory.push({ type: 'move', description: `移动光标到 ${target}.5`, contentBefore: snapshot });

    return {
      result: `✅ 已移动：光标 → ${target}.5\n${renderWithCursor(s)}`,
      success: true,
    };
  }

  selectTo(id: string, start: number, end: number): { result: string; success: boolean } {
    const s = this.sessions.get(id);
    if (!s) return { result: `❌ 未找到会话：${id}`, success: false };

    if (start < 1 || start > s.currentLines.length) {
      return { result: `❌ 起始行号 ${start} 超出范围（1-${s.currentLines.length}）`, success: false };
    }
    if (end < start || end > s.currentLines.length) {
      return { result: `❌ 终止行号 ${end} 超出范围或小于起始行号`, success: false };
    }

    const snapshot = s.currentLines.join('\n');
    s.selection = { start, end };
    s.cursorPos = end;
    s.cursorActive = true;
    s.patchHistory.push({
      type: 'selectto',
      description: `选择行 ${start}-${end}`,
      contentBefore: snapshot,
    });

    return {
      result: `✅ 已选择：${renderStatus(s)}\n${renderWithCursor(s)}`,
      success: true,
    };
  }

  // ── line_paste ──

  paste(id: string, newLines: string[]): { result: string; success: boolean } {
    const s = this.sessions.get(id);
    if (!s) return { result: `❌ 未找到会话：${id}`, success: false };

    if (!s.cursorActive) {
      return { result: '❌ 光标不存在，请先使用 line_cursor move 设置光标或者使用 selectto 选中行范围', success: false };
    }

    const snapshot = s.currentLines.join('\n');

    if (s.selection) {
      const { start, end } = s.selection;
      const startIdx = start - 1;
      const endIdx = end - 1;
      const removed = endIdx - startIdx + 1;

      s.currentLines.splice(startIdx, removed, ...newLines);
      s.cursorPos = startIdx + newLines.length;
      s.selection = null;

      const desc = newLines.length === 0
        ? `删除行 ${start}-${end}`
        : `替换行 ${start}-${end}（${removed} 行 → ${newLines.length} 行）`;
      s.patchHistory.push({ type: 'paste', description: desc, contentBefore: snapshot });
    } else {
      if (newLines.length === 0) {
        return { result: '⚠️ 无选中行且内容为空，不做任何操作', success: false };
      }
      const insertIdx = s.cursorPos;
      s.currentLines.splice(insertIdx, 0, ...newLines);
      s.cursorPos += newLines.length;

      const desc = `在光标处插入了 ${newLines.length} 行`;
      s.patchHistory.push({ type: 'paste', description: desc, contentBefore: snapshot });
    }

    s.cursorActive = false;

    return {
      result: `✅ ${s.patchHistory[s.patchHistory.length - 1].description}\n${renderStatus(s)}\n${renderWithCursor(s)}`,
      success: true,
    };
  }

  // ── 撤销 ──

  undo(id: string): { result: string; success: boolean } {
    const s = this.sessions.get(id);
    if (!s) return { result: `❌ 未找到会话：${id}`, success: false };
    if (s.patchHistory.length === 0) return { result: `⚠️ 没有可撤销的操作`, success: false };

    const last = s.patchHistory.pop()!;
    const prevLines = last.contentBefore.split('\n');
    s.currentLines = prevLines;
    s.cursorPos = prevLines.length;
    s.selection = null;
    s.cursorActive = true;

    return { result: `↩️ 已撤销：${last.description}\n光标已复位到末尾\n${renderWithCursor(s)}`, success: true };
  }

  // ── 保存 ──

  async saveSession(id: string): Promise<{ success: boolean; result: string }> {
    const s = this.sessions.get(id);
    if (!s) return { success: false, result: `❌ 未找到会话：${id}` };

    try {
      let content = s.currentLines.join('\n');
      if (s.trailingNewline && s.currentLines.length > 0) content += '\n';
      await fs.writeFile(s.filePath, content, 'utf-8');

      const changed = s.originalContent !== content;
      const count = s.patchHistory.length;
      this.sessions.delete(id);

      return {
        success: true,
        result: changed
          ? `✅ [${id}] 已保存（${count} 次操作）并退出\n📄 ${s.filePath}`
          : `✅ [${id}] 无变更，已退出\n📄 ${s.filePath}`,
      };
    } catch (err: any) {
      return { success: false, result: `❌ [${id}] 保存失败：${err.message}` };
    }
  }

  async saveAll(): Promise<{ success: boolean; result: string }> {
    if (!this.isActive()) return { success: false, result: '未处于编辑模式' };
    const results: string[] = [];
    let allOk = true;
    for (const sid of this.getActiveIds()) {
      const r = await this.saveSession(sid);
      if (!r.success) allOk = false;
      results.push(r.result);
    }
    return { success: allOk, result: results.join('\n') };
  }

}

export const deskEditManager = new DeskEditManager();

// ═════════════════════════════════════════════════════
// 编辑模式消息钉扎 Hook
// ═════════════════════════════════════════════════════

export function buildEditModePinningHook(): MessageHookFn {
  return (messages: ModelMessage[]): ModelMessage[] => {
    if (!deskEditManager.isActive()) return messages;

    const result = [...messages];
    for (const id of deskEditManager.getActiveIds()) {
      const fp = deskEditManager.getFilePath(id);
      const content = deskEditManager.getContentText(id);
      if (!fp || !content) continue;

      const prefix = `[ref] ${fp}`;
      const newMsg: ModelMessage = {
        role: 'user',
        content: `[ref] ${fp}\n\`\`\`\n${content}\n\`\`\``,
      };

      if (!deskEditManager.isRefPinned(id)) {
        const indices: number[] = [];
        for (let i = 0; i < result.length; i++) {
          const m = result[i];
          if (m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(prefix)) {
            indices.push(i);
          }
        }
        for (let i = indices.length - 1; i >= 0; i--) result.splice(indices[i], 1);
        result.push(newMsg);
        deskEditManager.markRefPinned(id);
      } else {
        let found = false;
        for (let i = 0; i < result.length; i++) {
          const m = result[i];
          if (m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(prefix)) {
            result[i] = newMsg;
            found = true;
            break;
          }
        }
        if (!found) {
          result.push(newMsg);
        }
      }
    }
    return result;
  };
}

// ═════════════════════════════════════════════════════
// 编辑模式可用工具列表
// ═════════════════════════════════════════════════════

export const DESK_EDIT_TOOLS = new Set([
  'desk_edit',
  'line_cursor',
  'line_paste',
  'ctrl_z',
  'desk_save',
  'desk_cancel',
  'desk_confirm_file',
  'desk-editor-prompt-get',
]);







