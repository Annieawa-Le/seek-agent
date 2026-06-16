import { FunctionInfo } from './types';
import { BaseParser } from './base-parser';
/**
 * C/C++/Java 风格函数解析器
 * 支持：
 * - C 函数
 * - C++ 函数（包括类方法、命名空间、const 修饰符等）
 * - Java 方法（包括注解、修饰符、泛型、throws 等）
 */
export class CFunctionParser extends BaseParser {
  constructor(content?: string, fileName?: string) {
    super();
    if (content !== undefined) {
      this.content = content;
      this.lines = content.split('\n');
    }
    if (fileName !== undefined) {
      this.fileName = fileName;
    }
  }

  protected parse(): FunctionInfo[] {
    const functions: FunctionInfo[] = [];

    // 1. 先提取所有可能的函数声明
    const functionMatches = this.findPotentialFunctions();
    for (const match of functionMatches) {
      const funcInfo = this.extractFunctionInfo(match);
      if (funcInfo && this.isValidFunctionInfo(funcInfo)) {
        functions.push(funcInfo);
      }
    }

    // 2. 提取类/结构体内的成员函数
    const classMethods = this.extractClassMethods();
    functions.push(...classMethods);

    // 3. 去重
    return this.deduplicateFunctions(functions);
  }

  /**
   * 查找所有潜在的函数定义位置
   */
  private findPotentialFunctions(): Array<{
    start: number;
    signature: string;
    returnType: string;
    name: string;
    params: string;
    modifiers: string[];
  }> {
    const matches: Array<{
      start: number;
      signature: string;
      returnType: string;
      name: string;
      params: string;
      modifiers: string[];
    }> = [];

    const regex =
      /^[ \t]*(?:(?:static|virtual|inline|extern|public|private|protected|constexpr|final|synchronized|abstract)\s+)*(?:(\w+(?:<[^>]+>)?(?:\s*\*?\s*)?)\s+)?(\w+)\s*\(([^)]*)\)\s*(?:const\s*)?(?:\s*throw\s*\([^)]*\))?\s*(?:override\s*)?(?:final\s*)?(?:\s*=\s*0)?\s*\{/gm;

    let match;
    while ((match = regex.exec(this.content)) !== null) {
      const fullMatch = match[0];
      const returnType = (match[1] || 'void').trim();
      const name = match[2];
      const params = match[3];

      if (this.isValidFunctionName(name, fullMatch)) {
        const modifiers = this.extractModifiers(fullMatch);
        matches.push({
          start: match.index,
          signature: fullMatch,
          returnType,
          name,
          params,
          modifiers,
        });
      }
    }

    return matches;
  }

  /**
   * 从匹配中提取完整的函数信息
   */
  private extractFunctionInfo(match: {
    start: number;
    signature: string;
    returnType: string;
    name: string;
    params: string;
    modifiers: string[];
  }): FunctionInfo | null {
    try {
      const bodyStart = match.start + match.signature.length - 1;
      const bodyEnd = this.findFunctionEnd(bodyStart);

      if (bodyEnd === -1) return null;

      const body = this.content.substring(bodyStart, bodyEnd);
      const parsedParams = this.parseParameters(match.params);

      const isMethod =
        match.modifiers.includes('public') ||
        match.modifiers.includes('private') ||
        match.modifiers.includes('protected');

      let className: string | undefined;
      if (isMethod) {
        className = this.extractClassName(match.start);
      }

      return {
        name: match.name,
        type: isMethod ? 'method' : 'function',
        params: parsedParams,
        returnType: this.normalizeReturnType(match.returnType),
        startLine: this.getLineNumber(match.start),
        endLine: this.getLineNumber(bodyEnd),
        body: this.cleanBody(body),
        isAsync: false,
        isPrivate: match.modifiers.includes('private'),
        isStatic: match.modifiers.includes('static'),
        className,
      };
    } catch (error) {
      console.warn(`Failed to parse function ${match.name}:`, error);
      return null;
    }
  }

  /**
   * 解析参数字符串
   */
  private parseParameters(paramsStr: string): string[] {
    if (!paramsStr.trim()) return [];

    const params: string[] = [];
    let current = '';
    let depth = 0;

    for (let i = 0; i < paramsStr.length; i++) {
      const char = paramsStr[i];

      if (char === '<') depth++;
      if (char === '>') depth--;

      if (char === ',' && depth === 0) {
        params.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      params.push(current.trim());
    }

    return params;
  }

  /**
   * 提取函数修饰符
   */
  private extractModifiers(signature: string): string[] {
    const modifiers: string[] = [];
    const modifierKeywords = [
      'static',
      'virtual',
      'inline',
      'extern',
      'public',
      'private',
      'protected',
      'constexpr',
      'final',
      'synchronized',
      'abstract',
    ];

    for (const keyword of modifierKeywords) {
      if (signature.includes(keyword)) {
        modifiers.push(keyword);
      }
    }

    return modifiers;
  }

  /**
   * 提取类名（如果函数是类方法）
   */
  private extractClassName(functionStart: number): string | undefined {
    const beforeFunction = this.content.substring(0, functionStart);
    const classMatch = /(?:class|struct)\s+(\w+)\s*\{[^}]*$/s.exec(beforeFunction);

    if (classMatch) {
      return classMatch[1];
    }

    return undefined;
  }

  /**
   * 清理函数体
   */
  private cleanBody(body: string): string {
    let cleaned = body.trim();
    cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n\n');
    return cleaned;
  }

  /**
   * 标准化返回类型
   */
  private normalizeReturnType(returnType: string): string {
    if (!returnType || returnType === '') return 'void';
    let normalized = returnType.trim();
    normalized = normalized.replace(/^(const|volatile)\s+/, '');
    return normalized;
  }

  /**
   * 验证函数名是否有效
   */
  private isValidFunctionName(name: string, fullMatch: string): boolean {
    const keywords = [
      'if',
      'else',
      'while',
      'for',
      'switch',
      'case',
      'class',
      'struct',
      'enum',
      'namespace',
      'template',
      'new',
      'delete',
      'sizeof',
      'typeof',
    ];

    if (keywords.includes(name)) return false;
    if (name === 'operator') return false;
    if (fullMatch.includes('class ') && fullMatch.includes('{') && !fullMatch.includes('('))
      return false;

    return true;
  }

  /**
   * 提取类/结构体中的成员函数（Java 风格）
   */
  private extractClassMethods(): FunctionInfo[] {
    const methods: FunctionInfo[] = [];

    const classRegex =
      /(?:class|struct)\s+(\w+)(?:\s*:\s*[^{]+)?\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/gs;

    let classMatch;
    while ((classMatch = classRegex.exec(this.content)) !== null) {
      const className = classMatch[1];
      const classBody = classMatch[2];

      const methodRegex =
        /^[ \t]*(?:public|private|protected|static|virtual|abstract|final|synchronized)?\s*(\w+(?:<[^>]+>)?(?:\s*\*?\s*)?)\s+(\w+)\s*\(([^)]*)\)\s*(?:const\s*)?(?:\s*throw\s*\([^)]*\))?\s*(?:override\s*)?\s*\{/gm;

      let methodMatch;
      while ((methodMatch = methodRegex.exec(classBody)) !== null) {
        const returnType = methodMatch[1].trim();
        const name = methodMatch[2];
        const params = methodMatch[3];

        const methodStart = classMatch.index + methodMatch.index;
        const methodEnd = this.findFunctionEnd(methodStart + methodMatch[0].length);

        if (methodEnd !== -1) {
          const body = this.content.substring(methodStart, methodEnd);
          const parsedParams = this.parseParameters(params);

          methods.push({
            name,
            type: 'method',
            params: parsedParams,
            returnType: this.normalizeReturnType(returnType),
            startLine: this.getLineNumber(methodStart),
            endLine: this.getLineNumber(methodEnd),
            body: this.cleanBody(body),
            isAsync: false,
            isPrivate: methodMatch[0].includes('private'),
            isStatic: methodMatch[0].includes('static'),
            className,
          });
        }
      }
    }

    return methods;
  }

  /**
   * 验证函数信息的有效性
   */
  private isValidFunctionInfo(func: FunctionInfo): boolean {
    if (!func.name || func.name.length === 0) return false;
    if (func.startLine > func.endLine) return false;
    if (func.name.startsWith('~')) return false;
    if (func.name === this.extractClassNameFromMethod(func)) return false;
    return true;
  }

  /**
   * 从方法中提取类名（用于过滤构造函数）
   */
  private extractClassNameFromMethod(func: FunctionInfo): string {
    if (func.className) return func.className;
    return '';
  }

  /**
   * 生成分析报告
   */
  generateReport(functions: FunctionInfo[]): string {
    let report = `=== C/C++/Java 函数分析报告 ===\n`;
    report += `文件: ${this.fileName}\n`;
    report += `总计: ${functions.length} 个函数\n\n`;

    const funcCount = functions.filter((f) => f.type === 'function').length;
    const methodCount = functions.filter((f) => f.type === 'method').length;

    report += `- 普通函数: ${funcCount}\n`;
    report += `- 类方法: ${methodCount}\n\n`;

    const publicMethods = functions.filter((f) => !f.isPrivate).length;
    const privateMethods = functions.filter((f) => f.isPrivate).length;

    report += `- Public/Internal: ${publicMethods}\n`;
    report += `- Private: ${privateMethods}\n\n`;

    report += `详细列表:\n`;
    report += `=${'='.repeat(80)}\n`;

    for (const func of functions) {
      report += `\n🔧 ${func.name}()\n`;
      report += `   类型: ${func.type}`;
      if (func.className) report += ` (类: ${func.className})`;
      report += `\n`;
      report += `   返回: ${func.returnType || 'void'}\n`;
      report += `   参数: (${func.params.join(', ')})\n`;
      report += `   位置: 第 ${func.startLine} - ${func.endLine} 行\n`;
      if (func.isStatic) report += `   静态: 是\n`;
      if (func.isPrivate) report += `   访问: private\n`;
      report += `   ${'-'.repeat(60)}\n`;
      report += `${func.body.substring(0, 200)}${func.body.length > 200 ? '...' : ''}\n`;
    }

    return report;
  }
}








