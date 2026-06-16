import * as fs from 'fs';
import { FunctionInfo } from './types';

/**
 * 基础解析器抽象类
 * 提供通用的文件读取、行号计算、报告生成等基础功能
 */
export abstract class BaseParser {
  protected content: string = '';
  protected lines: string[] = [];
  protected fileName: string = '';

  /**
   * 从文件解析
   */
  parseFile(filePath: string): FunctionInfo[] {
    this.content = fs.readFileSync(filePath, 'utf-8');
    this.lines = this.content.split('\n');
    this.fileName = filePath;
    return this.parse();
  }

  /**
   * 从代码字符串解析
   */
  parseCode(code: string): FunctionInfo[] {
    this.content = code;
    this.lines = code.split('\n');
    this.fileName = 'memory';
    return this.parse();
  }

  /**
   * 设置内容（用于测试或特殊场景）
   */
  setContent(content: string, fileName?: string): void {
    this.content = content;
    this.lines = content.split('\n');
    this.fileName = fileName || 'unknown';
  }

  /**
   * 获取当前内容
   */
  getContent(): string {
    return this.content;
  }

  /**
   * 根据字符位置获取行号（从1开始）
   */
  protected getLineNumber(position: number): number {
    let lineCount = 1;
    for (let i = 0; i < position && i < this.content.length; i++) {
      if (this.content[i] === '\n') {
        lineCount++;
      }
    }
    return lineCount;
  }

  /**
   * 查找函数体结束位置（处理嵌套花括号）
   */
  protected findFunctionEnd(startPos: number): number {
    let braceCount = 1;
    let pos = startPos;

    while (pos < this.content.length && braceCount > 0) {
      const char = this.content[pos];
      if (char === '{') braceCount++;
      if (char === '}') braceCount--;
      pos++;
    }

    return braceCount === 0 ? pos : -1;
  }

  /**
   * 获取子字符串
   */
  protected substring(start: number, end: number): string {
    return this.content.substring(start, end);
  }

  /**
   * 生成报告（默认实现，可覆盖）
   */
  generateReport(functions: FunctionInfo[]): string {
    let report = `=== 函数分析报告 ===\n`;
    report += `文件: ${this.fileName}\n`;
    report += `总计: ${functions.length} 个函数\n\n`;

    for (const func of functions) {
      report += `\n函数: ${func.name}()\n`;
      report += `  类型: ${func.type}\n`;
      report += `  位置: 第 ${func.startLine} - ${func.endLine} 行\n`;
      report += `  ${'-'.repeat(40)}\n`;
    }

    return report;
  }

  /**
   * 去重函数
   */
  protected deduplicateFunctions(functions: FunctionInfo[]): FunctionInfo[] {
    const seen = new Map<string, FunctionInfo>();
    for (const func of functions) {
      const key = `${func.name}:${func.startLine}:${func.className || ''}`;
      if (!seen.has(key)) {
        seen.set(key, func);
      }
    }
    return Array.from(seen.values());
  }

  /**
   * 抽象方法：子类必须实现具体的解析逻辑
   */
  protected abstract parse(): FunctionInfo[];
}
