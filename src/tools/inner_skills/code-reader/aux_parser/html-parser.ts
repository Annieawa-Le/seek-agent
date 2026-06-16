/**
 * HTML 解析器
 * 支持：HTML 标签扫描、脚本提取、类/ID 查询
 */
import { FunctionInfo } from './types';
import { BaseParser } from './base-parser';
import { TsFunctionParser } from './ts-parser';

export interface TagInfo {
  tagName: string;
  attributes: Record<string, string>;
  id?: string;
  classes: string[];
  selfClosing: boolean;
  startLine: number;
  endLine: number;
  contentPreview?: string;
}

export interface ScriptBlockInfo {
  language: string;
  src?: string;
  code: string;
  startLine: number;
  endLine: number;
}

export class HtmlParser extends BaseParser {
  protected parse(): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    const scriptBlocks = this.extractAllScriptBlocks();

    for (const block of scriptBlocks) {
      if (block.language === '' || block.language === 'javascript' || block.language === 'typescript' || block.language === 'module') {
        const tsParser = new TsFunctionParser();
        tsParser.setContent(block.code, `${this.fileName}:script@L${block.startLine}`);
        const subFuncs = tsParser.parseCode(block.code);

        // 调整行号偏移到原始文件
        for (const f of subFuncs) {
          f.startLine += block.startLine - 1;
          f.endLine += block.startLine - 1;
        }
        functions.push(...subFuncs);
      }
    }

    return this.deduplicateFunctions(functions);
  }

  // ─── 脚本提取 ─────────────────────────────────

  /**
   * 提取 HTML 中所有 <script> 块
   */
  extractAllScriptBlocks(): ScriptBlockInfo[] {
    const blocks: ScriptBlockInfo[] = [];
    const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    let match: RegExpExecArray | null;

    while ((match = scriptRegex.exec(this.content)) !== null) {
      const attrStr = match[1];
      const code = match[2].trim();
      const attrs = this.parseAttributes(attrStr);
      const language = (attrs.type || attrs.lang || attrs.language || '').replace(/^text\//, '').toLowerCase();
      const src = attrs.src;

      if (src) continue; // 外部脚本，跳过

      const startLine = this.getLineNumber(match.index);
      const endLine = this.getLineNumber(match.index + match[0].length);

      blocks.push({
        language,
        src,
        code,
        startLine,
        endLine,
      });
    }

    return blocks;
  }

  // ─── 标签提取 ─────────────────────────────────

  /**
   * 提取所有 HTML 标签信息
   */
  extractAllTags(): TagInfo[] {
    const tags: TagInfo[] = [];
    // 匹配各种标签（排除注释、DOCTYPE、script 内部内容等）
    const tagRegex = /<(\/?)(\w[\w-]*)\b((?:[^>"'=\s]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?\s*)*)\s*(\/?)>/gi;

    let match: RegExpExecArray | null;
    const scriptRanges = this.getScriptRanges();

    while ((match = tagRegex.exec(this.content)) !== null) {
      const isClosing = match[1] === '/';
      const tagName = match[2].toLowerCase();
      const attrStr = match[3].trim();
      const selfClosing = match[4] === '/' || isClosing;
      const tagStart = match.index;

      // 跳过在 <script> 内容中的标签匹配
      if (this.isInsideRange(tagStart, scriptRanges)) continue;
      // 跳过关闭标签
      if (isClosing) continue;

      const startLine = this.getLineNumber(tagStart);
      const attrs = this.parseAttributes(attrStr);
      const id = attrs.id;
      const classes = (attrs.class || '').split(/\s+/).filter(Boolean);

      // 估算结束行：找匹配的关闭标签或自闭合
      let endLine = startLine;
      if (!selfClosing) {
        const closeTagRegex = new RegExp(`<\\/${tagName}\\s*>`, 'i');
        const closeMatch = closeTagRegex.exec(this.content.substring(tagStart + match[0].length));
        if (closeMatch) {
          endLine = this.getLineNumber(tagStart + match[0].length + closeMatch.index + closeMatch[0].length);
        }
      }

      // 内容预览（标签之间的文本前 80 字符）
      let contentPreview: string | undefined;
      if (!selfClosing) {
        const afterTag = match.index + match[0].length;
        const nextTag = this.content.indexOf('<', afterTag);
        if (nextTag > afterTag) {
          const rawContent = this.content.substring(afterTag, nextTag).trim();
          if (rawContent) {
            contentPreview = rawContent.substring(0, 80) + (rawContent.length > 80 ? '...' : '');
          }
        }
      }

      tags.push({
        tagName,
        attributes: attrs,
        id,
        classes,
        selfClosing,
        startLine,
        endLine,
        contentPreview,
      });
    }

    return tags;
  }

  /**
   * 按标签名提取
   */
  extractTagsByType(tagName: string): TagInfo[] {
    return this.extractAllTags().filter(t => t.tagName === tagName.toLowerCase());
  }

  /**
   * 按 CSS 类名提取
   */
  extractByClass(className: string): TagInfo[] {
    return this.extractAllTags().filter(t => t.classes.includes(className));
  }

  /**
   * 按 ID 提取
   */
  extractById(id: string): TagInfo[] {
    return this.extractAllTags().filter(t => t.id === id);
  }

  // ─── 辅助方法 ─────────────────────────────────

  /**
   * 解析属性字符串
   */
  private parseAttributes(attrStr: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const attrRegex = /([^\s"'>=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
    let match: RegExpExecArray | null;

    while ((match = attrRegex.exec(attrStr)) !== null) {
      const name = match[1].toLowerCase();
      const value = match[2] ?? match[3] ?? match[4] ?? '';
      attrs[name] = value;
    }

    return attrs;
  }

  /**
   * 获取所有 <script> 标签的范围（偏移区间）
   */
  private getScriptRanges(): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
    let match: RegExpExecArray | null;

    while ((match = scriptRegex.exec(this.content)) !== null) {
      ranges.push([match.index, match.index + match[0].length]);
    }

    return ranges;
  }

  /**
   * 检查位置是否在指定范围内
   */
  private isInsideRange(pos: number, ranges: Array<[number, number]>): boolean {
    return ranges.some(([start, end]) => pos >= start && pos < end);
  }

  /**
   * 生成报告（HTML 结构概览）
   */
  generateReport(functions: FunctionInfo[]): string {
    const tags = this.extractAllTags();
    const scripts = this.extractAllScriptBlocks();

    let report = '=== HTML 分析报告 ===\n';
    report += `文件: ${this.fileName}\n`;
    report += `标签总数: ${tags.length}\n`;
    report += `脚本块数: ${scripts.length}\n`;
    report += `脚本中函数数: ${functions.length}\n\n`;

    // 标签统计
    const tagCount = new Map<string, number>();
    for (const t of tags) {
      tagCount.set(t.tagName, (tagCount.get(t.tagName) || 0) + 1);
    }

    report += '--- 标签统计 ---\n';
    for (const [name, count] of [...tagCount.entries()].sort((a, b) => b[1] - a[1])) {
      report += `  <${name}> × ${count}\n`;
    }

    // 脚本块概览
    if (scripts.length > 0) {
      report += '\n--- 脚本块 ---\n';
      for (const s of scripts) {
        report += `  [第 ${s.startLine}-${s.endLine} 行] ${s.language || 'javascript'} (${s.code.length} 字符)\n`;
      }
    }

    return report;
  }
}
