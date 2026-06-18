/**
 * tool-output.ts — 工具执行返回值包装器
 *
 * 工具 execute() 返回 ToolOutput 实例，同时携带：
 *   - rawBulk: 结构化功能数据（供 TUI/WebUI 渲染）
 *   - AI 文本: 保持现有 AI 友好的格式（通过 toString()）
 *
 * 用法：
 *   return new ToolOutput(rawBulk, aiText);
 *   // String(output) → aiText
 *   // output.rawBulk → 结构化数据
 */

import type { RawBulk } from './raw-bulk-types';
import { toAIText } from './raw-bulk-formatters';

export class ToolOutput {
  public rawBulk: RawBulk;
  private _aiText: string;

  constructor(rawBulk: RawBulk, aiText?: string) {
    this.rawBulk = rawBulk;
    this._aiText = aiText ?? toAIText(rawBulk);
  }

  /** AI 友好的工具结果文本（保持现有格式） */
  get aiText(): string {
    return this._aiText;
  }

  /** String(output) 返回 AI 文本，保持向后兼容 */
  toString(): string {
    return this._aiText;
  }
}

/**
 * 检测返回值是否为 ToolOutput 实例
 */
export function isToolOutput(val: unknown): val is ToolOutput {
  return val instanceof ToolOutput;
}

/**
 * 从 ToolOutput 或字符串中提取 rawBulk（字符串时生成通用 RawBulk）
 */
export function extractBulk(val: unknown): { rawBulk?: RawBulk; text: string } {
  if (val instanceof ToolOutput) {
    return { rawBulk: val.rawBulk, text: val.aiText };
  }
  return { text: String(val ?? '') };
}
