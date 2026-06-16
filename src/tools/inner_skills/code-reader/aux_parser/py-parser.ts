import { FunctionInfo } from './types';
import { BaseParser } from './base-parser';
/**
 * Python 函数解析器
 * 支持：函数定义、类方法、lambda 函数、装饰器、文档字符串
 */
export class PyFunctionParser extends BaseParser {
  protected parse(): FunctionInfo[] {
    return this.extractAllFunctions();
  }

  private extractAllFunctions(): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    functions.push(...this.extractFunctionDefinitions());
    functions.push(...this.extractClassMethods());
    functions.push(...this.extractLambdaFunctions());
    return this.deduplicateFunctions(functions);
  }

  /**
   * 1. 提取函数定义: def func_name(params):
   */
  private extractFunctionDefinitions(): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    const funcRegex = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?\s*:/;

    let i = 0;
    while (i < this.lines.length) {
      const line = this.lines[i];
      const match = line.match(funcRegex);

      if (match) {
        const indent = match[1].length;
        const name = match[2];
        const params = this.parsePythonParams(match[3]);
        const returnType = match[4]?.trim();
        const isAsync = line.includes('async def');
        const isPrivate = name.startsWith('_') && !name.startsWith('__');

        // 收集装饰器
        const decorators = this.collectDecorators(i, indent);

        // 查找函数结束位置
        const startLine = i + 1;
        const { endLine, body, docstring } = this.extractPythonFunctionBody(i + 1, indent);

        functions.push({
          name,
          type: 'function',
          params,
          returnType,
          startLine,
          endLine,
          body,
          isAsync,
          isPrivate,
          decorators,
          docstring,
        });

        i = endLine;
      } else {
        i++;
      }
    }

    return functions;
  }

  /**
   * 2. 提取类方法
   */
  private extractClassMethods(): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    const classRegex = /^class\s+(\w+)\s*:/;

    let i = 0;
    while (i < this.lines.length) {
      const line = this.lines[i];
      const classMatch = line.match(classRegex);

      if (classMatch) {
        const className = classMatch[1];
        const classIndent = line.search(/\S/);
        const classEndLine = this.findBlockEnd(i + 1, classIndent);
        const methods = this.extractMethodsInClass(i + 1, classEndLine, className, classIndent);
        functions.push(...methods);
        i = classEndLine;
      } else {
        i++;
      }
    }

    return functions;
  }

  /**
   * 在类内部提取方法
   */
  private extractMethodsInClass(
    startLine: number,
    endLine: number,
    className: string,
    classIndent: number
  ): FunctionInfo[] {
    const methods: FunctionInfo[] = [];
    const methodRegex = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?\s*:/;

    for (let i = startLine; i < endLine; i++) {
      const line = this.lines[i];
      const match = line.match(methodRegex);

      if (match) {
        const indent = match[1].length;
        if (indent > classIndent) {
          const name = match[2];
          const params = this.parsePythonParams(match[3]);
          const returnType = match[4]?.trim();
          const isAsync = line.includes('async def');
          const isPrivate = name.startsWith('_') && !name.startsWith('__');

          const decorators = this.collectDecorators(i, indent);
          const isStatic = decorators.includes('staticmethod');
          const isClassMethod = decorators.includes('classmethod');

          const { endLine: methodEndLine, body, docstring } = this.extractPythonFunctionBody(
            i + 1,
            indent
          );

          methods.push({
            name,
            type: 'method',
            params,
            returnType,
            startLine: i + 1,
            endLine: methodEndLine,
            body,
            isAsync,
            isPrivate,
            isStatic,
            isClassMethod,
            className,
            decorators,
            docstring,
          });

          i = methodEndLine - 1;
        }
      }
    }

    return methods;
  }

  /**
   * 3. 提取 lambda 函数
   */
  private extractLambdaFunctions(): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    const lambdaRegex = /^(\w+)\s*=\s*lambda\s+([^:]+)\s*:(.+)$/;

    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i].trim();
      const match = line.match(lambdaRegex);

      if (match) {
        const name = match[1];
        const params = this.parsePythonParams(match[2]);
        const expression = match[3].trim();

        functions.push({
          name,
          type: 'lambda',
          params,
          startLine: i + 1,
          endLine: i + 1,
          body: expression,
          isAsync: false,
        });
      }
    }

    return functions;
  }

  /**
   * 提取函数体（处理 Python 缩进）
   */
  private extractPythonFunctionBody(
    startLineIdx: number,
    baseIndent: number
  ): { endLine: number; body: string; docstring?: string } {
    let body = '';
    let endLine = startLineIdx;
    let docstring = '';
    let inDocstring = false;
    let docstringDelimiter = '';

    for (let i = startLineIdx; i < this.lines.length; i++) {
      const line = this.lines[i];
      const lineIndent = line.search(/\S/);

      if (lineIndent < baseIndent && line.trim() !== '') {
        break;
      }

      if (line.trim() === '') {
        if (!inDocstring) {
          endLine = i + 1;
          continue;
        }
      }

      // 检测文档字符串（单行）
      const singleDocstringMatch = line.match(/^\s*("""|''')(.*?)\1/);
      if (singleDocstringMatch && !inDocstring) {
        docstring = singleDocstringMatch[2];
        continue;
      }

      // 处理多行文档字符串
      if (line.includes('"""') || line.includes("'''")) {
        if (!inDocstring) {
          inDocstring = true;
          docstringDelimiter = line.includes('"""') ? '"""' : "'''";
          const startQuote = line.indexOf(docstringDelimiter);
          const endQuote = line.indexOf(docstringDelimiter, startQuote + 3);
          if (endQuote !== -1) {
            inDocstring = false;
            docstring = line.substring(startQuote + 3, endQuote);
          } else {
            docstring = line.substring(startQuote + 3);
          }
        } else {
          const endQuote = line.indexOf(docstringDelimiter);
          if (endQuote !== -1) {
            docstring += '\n' + line.substring(0, endQuote);
            inDocstring = false;
          } else {
            docstring += '\n' + line;
          }
        }
        continue;
      }

      if (inDocstring) {
        docstring += '\n' + line;
        continue;
      }

      if (lineIndent >= baseIndent) {
        body += line + '\n';
      }

      endLine = i + 1;
    }

    return {
      endLine,
      body: body.trim(),
      docstring: docstring || undefined,
    };
  }

  /**
   * 收集函数/方法的装饰器
   */
  private collectDecorators(lineIdx: number, indent: number): string[] {
    const decorators: string[] = [];
    let i = lineIdx - 1;

    while (i >= 0) {
      const line = this.lines[i];
      const lineIndent = line.search(/\S/);
      const trimmed = line.trim();

      if (lineIndent !== indent) break;

      const decoratorMatch = trimmed.match(/^@(\w+(?:\.\w+)?)/);
      if (decoratorMatch) {
        decorators.unshift(decoratorMatch[1]);
        i--;
      } else {
        break;
      }
    }

    return decorators;
  }

  /**
   * 查找代码块的结束位置（基于缩进）
   */
  private findBlockEnd(startIdx: number, baseIndent: number): number {
    for (let i = startIdx; i < this.lines.length; i++) {
      const line = this.lines[i];
      const lineIndent = line.search(/\S/);
      if (lineIndent < baseIndent && line.trim() !== '') {
        return i;
      }
    }
    return this.lines.length;
  }

  /**
   * 解析 Python 参数字符串
   */
  private parsePythonParams(paramsStr: string): string[] {
    if (!paramsStr.trim()) return [];

    const params: string[] = [];
    let current = '';
    let depth = 0;
    let inDefault = false;

    for (let i = 0; i < paramsStr.length; i++) {
      const char = paramsStr[i];

      if (char === '[' || char === '(') depth++;
      if (char === ']' || char === ')') depth--;

      if (char === ',' && depth === 0 && !inDefault) {
        params.push(this.cleanParam(current.trim()));
        current = '';
      } else {
        current += char;
        if (char === '=' && depth === 0) {
          inDefault = true;
        }
      }
    }

    if (current.trim()) {
      params.push(this.cleanParam(current.trim()));
    }

    return params.filter((p) => p && !['self', 'cls'].includes(p));
  }

  /**
   * 清理参数（移除类型注解和默认值）
   */
  private cleanParam(param: string): string {
    const colonIndex = param.indexOf(':');
    if (colonIndex !== -1) {
      param = param.substring(0, colonIndex);
    }
    const equalIndex = param.indexOf('=');
    if (equalIndex !== -1) {
      param = param.substring(0, equalIndex);
    }
    return param.trim();
  }

  /**
   * 生成报告
   */
  generateReport(functions: FunctionInfo[]): string {
    let report = '=== Python 函数分析报告 ===\n\n';

    const grouped = {
      function: functions.filter((f) => f.type === 'function'),
      method: functions.filter((f) => f.type === 'method'),
      lambda: functions.filter((f) => f.type === 'lambda'),
    };

    report += `总计: ${functions.length} 个函数\n`;
    report += `- 普通函数: ${grouped.function.length}\n`;
    report += `- 类方法: ${grouped.method.length}\n`;
    report += `- Lambda: ${grouped.lambda.length}\n\n`;

    report += '详细列表:\n';
    report += '='.repeat(80) + '\n';

    for (const func of functions) {
      report += `\n名称: ${func.name}\n`;
      report += `类型: ${func.type}`;
      if (func.className) report += ` (类: ${func.className})`;
      report += `\n`;
      report += `参数: (${func.params.join(', ')})\n`;
      if (func.returnType) report += `返回类型: ${func.returnType}\n`;
      report += `位置: 第 ${func.startLine} - ${func.endLine} 行\n`;
      report += `异步: ${func.isAsync ? '是' : '否'}\n`;
      if (func.isPrivate) report += `访问: private\n`;
      if (func.isStatic) report += `静态方法: 是\n`;
      if (func.isClassMethod) report += `类方法: 是\n`;
      if (func.decorators && func.decorators.length > 0) {
        report += `装饰器: ${func.decorators.join(', ')}\n`;
      }
      if (func.docstring) {
        report += `文档: ${func.docstring.substring(0, 100)}${
          func.docstring.length > 100 ? '...' : ''
        }\n`;
      }
      report += '-'.repeat(40) + '\n';
    }

    return report;
  }
}








