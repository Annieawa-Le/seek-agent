// @ts-nocheck 此文件是工具代码，忽略类型检查
// @ts-nocheck 此文件是工具代码，忽略类型检查
import * as fs from 'fs';
// import * as path from 'path';

// 函数信息接口
interface FunctionInfo {
  name: string;
  type: 'function' | 'method' | 'lambda' | 'arrow' | 'anonymous';
  params: string[];
  returnType?: string;  // Python 中可选，因为动态类型
  startLine: number;
  endLine: number;
  body: string;
  isAsync: boolean;
  isPrivate?: boolean;   // Python 中以 _ 开头的方法
  isStatic?: boolean;    // Python 中的 @staticmethod
  isClassMethod?: boolean; // Python 中的 @classmethod
  className?: string;    // 如果是类方法
  decorators?: string[];  // Python 装饰器
  docstring?: string;     // 文档字符串
}

abstract class BaseParser {
  protected content: string = '';
  protected lines: string[] = [];
  protected fileName: string = '';
  
  /**
   * 从文件解析（复用逻辑）
   */
  parseFile(filePath: string): FunctionInfo[] {
    this.content = fs.readFileSync(filePath, 'utf-8');
    this.lines = this.content.split('\n');
    this.fileName = filePath;
    return this.parse();
  }
  
  /**
   * 从代码字符串解析（复用逻辑）
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
   * 获取行数
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
   * 抽象方法：子类必须实现具体的解析逻辑
   */
  protected abstract parse(): FunctionInfo[];
}

class tsFunctionParser {
  private content: string;
  private lines: string[];
  
  constructor(content: string) {
    this.content = content;
    this.lines = content.split('\n');
  }
  
  /**
   * 解析文件并提取所有函数
   */
  parseFile(filePath: string): FunctionInfo[] {
    this.content = fs.readFileSync(filePath, 'utf-8');
    this.lines = this.content.split('\n');
    return this.extractAllFunctions();
  }
  
  /**
   * 从代码字符串中提取所有函数
   */
  parseCode(code: string): FunctionInfo[] {
    this.content = code;
    this.lines = code.split('\n');
    return this.extractAllFunctions();
  }
  
  /**
   * 主提取方法
   */
  private extractAllFunctions(): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    
    // 正则表达式模式
    const patterns = [
      this.extractFunctionDeclarations.bind(this),      // function name() {}
      this.extractFunctionExpressions.bind(this),       // const name = function() {}
      this.extractArrowFunctions.bind(this),            // const name = () => {}
      this.extractClassMethods.bind(this),              // class { method() {} }
      this.extractAsyncFunctions.bind(this),            // async function name() {}
      this.extractGeneratorFunctions.bind(this)         // function* name() {}
    ];
    
    for (const pattern of patterns) {
      functions.push(...pattern());
    }
    
    // 去重（按名称和行号）
    return this.deduplicateFunctions(functions);
  }
  
  /**
   * 1. 提取函数声明: function name(params) { body }
   */
  private extractFunctionDeclarations(): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    // 匹配: function name(params) 或 async function name(params)
    const regex = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*(\w+))?\s*\{/gm;
    
    let match;
    while ((match = regex.exec(this.content)) !== null) {
      const fullMatch = match[0];
      const name = match[1];
      const params = this.parseParams(match[2]);
      const returnType = match[3];
      const startLine = this.getLineNumber(match.index);
      const endLine = this.findFunctionEnd(match.index + fullMatch.length);
      const body = this.getFunctionBody(match.index, endLine);
      
      functions.push({
        name,
        type: 'function',
        params,
        returnType,
        startLine,
        endLine,
        body,
        isAsync: fullMatch.includes('async')
      });
    }
    
    return functions;
  }
  
  /**
   * 2. 提取函数表达式: const name = function(params) {}
   */
  private extractFunctionExpressions(): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    const regex = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function\s*\(([^)]*)\)\s*(?::\s*(\w+))?\s*\{/g;
    
    let match;
    while ((match = regex.exec(this.content)) !== null) {
      const name = match[1];
      const params = this.parseParams(match[2]);
      const returnType = match[3];
      const startLine = this.getLineNumber(match.index);
      const endLine = this.findFunctionEnd(match.index + match[0].length);
      const body = this.getFunctionBody(match.index, endLine);
      
      functions.push({
        name,
        type: 'function',
        params,
        returnType,
        startLine,
        endLine,
        body,
        isAsync: match[0].includes('async')
      });
    }
    
    return functions;
  }
  
  /**
   * 3. 提取箭头函数: const name = (params) => {}
   */
  private extractArrowFunctions(): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    // 匹配箭头函数的多种形式
    const regex = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?([^)=]*)\)?\s*:\s*(\w+)?\s*=>\s*(\{?)/g;
    
    let match;
    while ((match = regex.exec(this.content)) !== null) {
      const name = match[1];
      let params = match[2].trim();
      const returnType = match[3];
      const hasBody = match[4] === '{';
      
      // 处理无括号的参数: const fn = x => x + 1
      if (params && !params.includes(',') && !params.includes('(') && !params.includes(')')) {
        params = params;
      }
      
      const parsedParams = this.parseParams(params);
      const startLine = this.getLineNumber(match.index);
      
      let endLine: number;
      let body: string;
      
      if (hasBody) {
        // 有花括号的函数体
        endLine = this.findFunctionEnd(match.index + match[0].length - 1);
        body = this.getFunctionBody(match.index, endLine);
      } else {
        // 单表达式箭头函数
        endLine = startLine;
        body = this.content.substring(match.index + match[0].length, 
               this.findNextLineBreak(match.index + match[0].length));
      }
      
      functions.push({
        name,
        type: 'arrow',
        params: parsedParams,
        returnType,
        startLine,
        endLine,
        body,
        isAsync: match[0].includes('async')
      });
    }
    
    return functions;
  }
  
  /**
   * 4. 提取类方法
   */
  private extractClassMethods(): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    // 匹配类定义，然后提取方法
    const classRegex = /class\s+(\w+)\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/gs;
    
    let classMatch;
    while ((classMatch = classRegex.exec(this.content)) !== null) {
      const className = classMatch[1];
      const classBody = classMatch[2];
      
      // 匹配方法: methodName(params) {} 或 async methodName(params) {}
      const methodRegex = /^\s*(?:async\s+)?(?:private\s+)?(?:static\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*(\w+))?\s*\{/gm;
      
      let methodMatch;
      while ((methodMatch = methodRegex.exec(classBody)) !== null) {
        const name = methodMatch[1];
        const params = this.parseParams(methodMatch[2]);
        const returnType = methodMatch[3];
        
        // 计算在整个文件中的位置
        const methodStart = classMatch.index + methodMatch.index;
        const methodStartLine = this.getLineNumber(methodStart);
        const methodEnd = this.findFunctionEnd(methodStart + methodMatch[0].length);
        const body = this.getFunctionBody(methodStart, methodEnd);
        
        functions.push({
          name,
          type: 'method',
          params,
          returnType,
          startLine: methodStartLine,
          endLine: this.getLineNumber(methodEnd),
          body,
          isAsync: methodMatch[0].includes('async'),
          isPrivate: methodMatch[0].includes('private'),
          isStatic: methodMatch[0].includes('static'),
          className
        });
      }
    }
    
    return functions;
  }
  
  /**
   * 5. 提取异步函数（如果还没被前面捕获）
   */
  private extractAsyncFunctions(): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    const regex = /^\s*export\s+async\s+function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*Promise<(\w+)>)?\s*\{/gm;
    
    let match;
    while ((match = regex.exec(this.content)) !== null) {
      const name = match[1];
      const params = this.parseParams(match[2]);
      const returnType = match[3];
      const startLine = this.getLineNumber(match.index);
      const endLine = this.findFunctionEnd(match.index + match[0].length);
      const body = this.getFunctionBody(match.index, endLine);
      
      functions.push({
        name,
        type: 'function',
        params,
        returnType: returnType ? `Promise<${returnType}>` : 'Promise<any>',
        startLine,
        endLine,
        body,
        isAsync: true
      });
    }
    
    return functions;
  }
  
  /**
   * 6. 提取生成器函数
   */
  private extractGeneratorFunctions(): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    const regex = /^\s*function\*\s*(\w+)\s*\(([^)]*)\)\s*(?::\s*(\w+))?\s*\{/gm;
    
    let match;
    while ((match = regex.exec(this.content)) !== null) {
      const name = match[1];
      const params = this.parseParams(match[2]);
      const returnType = match[3];
      const startLine = this.getLineNumber(match.index);
      const endLine = this.findFunctionEnd(match.index + match[0].length);
      const body = this.getFunctionBody(match.index, endLine);
      
      functions.push({
        name,
        type: 'function',
        params,
        returnType,
        startLine,
        endLine,
        body,
        isAsync: false
      });
    }
    
    return functions;
  }
  
  /**
   * 解析参数字符串为参数数组
   */
  private parseParams(paramsStr: string): string[] {
    if (!paramsStr.trim()) return [];
    
    // 简单解析，处理默认值和类型注解
    const params = [];
    let current = '';
    let depth = 0;
    
    for (let i = 0; i < paramsStr.length; i++) {
      const char = paramsStr[i];
      
      if (char === '(' || char === '<') depth++;
      if (char === ')' || char === '>') depth--;
      
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
    
    // 提取参数名（忽略类型和默认值）
    return params.map(param => {
      const colonIndex = param.indexOf(':');
      const equalIndex = param.indexOf('=');
      let endIndex = param.length;
      
      if (colonIndex > 0) endIndex = Math.min(endIndex, colonIndex);
      if (equalIndex > 0) endIndex = Math.min(endIndex, equalIndex);
      
      return param.substring(0, endIndex).trim();
    }).filter(p => p && !p.includes('...')); // 忽略剩余参数
  }
  
  /**
   * 查找函数体的结束位置
   */
  private findFunctionEnd(startPos: number): number {
    let braceCount = 1;
    let pos = startPos;
    
    while (pos < this.content.length && braceCount > 0) {
      const char = this.content[pos];
      if (char === '{') braceCount++;
      if (char === '}') braceCount--;
      pos++;
    }
    
    return pos;
  }
  
  /**
   * 获取函数体内容
   */
  private getFunctionBody(startPos: number, endPos: number): string {
    // 找到第一个 {
    let bodyStart = startPos;
    while (bodyStart < this.content.length && this.content[bodyStart] !== '{') {
      bodyStart++;
    }
    
    if (bodyStart >= this.content.length) return '';
    
    // 提取函数体（包括花括号）
    return this.content.substring(bodyStart, endPos);
  }
  
  /**
   * 获取行号
   */
  private getLineNumber(position: number): number {
    for (let i = 0; i < this.lines.length; i++) {
      position -= this.lines[i].length + 1;
      if (position <= 0) return i + 1;
    }
    return 1;
  }
  
  /**
   * 查找下一个换行符位置
   */
  private findNextLineBreak(position: number): number {
    const nextNewline = this.content.indexOf('\n', position);
    return nextNewline === -1 ? this.content.length : nextNewline;
  }
  
  /**
   * 去重函数
   */
  private deduplicateFunctions(functions: FunctionInfo[]): FunctionInfo[] {
    const seen = new Map<string, FunctionInfo>();
    
    for (const func of functions) {
      const key = `${func.name}:${func.startLine}`;
      if (!seen.has(key)) {
        seen.set(key, func);
      }
    }
    
    return Array.from(seen.values());
  }
  
  /**
   * 生成报告
   */
  generateReport(functions: FunctionInfo[]): string {
    let report = '=== 函数定义分析报告 ===\n\n';
    
    // 按类型分组
    const grouped = {
      function: functions.filter(f => f.type === 'function'),
      method: functions.filter(f => f.type === 'method'),
      arrow: functions.filter(f => f.type === 'arrow')
    };
    
    report += `总计: ${functions.length} 个函数\n`;
    report += `- 普通函数: ${grouped.function.length}\n`;
    report += `- 类方法: ${grouped.method.length}\n`;
    report += `- 箭头函数: ${grouped.arrow.length}\n\n`;
    
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
      if (func.isStatic) report += `静态: 是\n`;
      report += '-' .repeat(40) + '\n';
    }
    
    return report;
  }
}


class PyFunctionParser {
  private lines: string[];
  private content: string;

  constructor(content: string) {
    this.content = content;
    this.lines = content.split('\n');
  }

  /**
   * 从文件解析
   */
  parseFile(filePath: string): FunctionInfo[] {
    this.content = fs.readFileSync(filePath, 'utf-8');
    this.lines = this.content.split('\n');
    return this.extractAllFunctions();
  }

  /**
   * 从代码字符串解析
   */
  parseCode(code: string): FunctionInfo[] {
    this.content = code;
    this.lines = code.split('\n');
    return this.extractAllFunctions();
  }

  /**
   * 主提取方法
   */
  private extractAllFunctions(): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    
    // 提取普通函数和类方法
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
    // 匹配 Python 函数定义，包括装饰器
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
        
        // 查找函数结束位置和函数体
        const startLine = i + 1; // 行号从1开始
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
          docstring
        });
        
        i = endLine; // 跳过已处理的函数体
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
        const classStartLine = i;
        
        // 找到类结束位置
        let classEndLine = this.findBlockEnd(i + 1, classIndent);
        
        // 在类内部提取方法
        const methods = this.extractMethodsInClass(classStartLine + 1, classEndLine, className, classIndent);
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
  private extractMethodsInClass(startLine: number, endLine: number, className: string, classIndent: number): FunctionInfo[] {
    const methods: FunctionInfo[] = [];
    const methodRegex = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?\s*:/;
    
    for (let i = startLine; i < endLine; i++) {
      const line = this.lines[i];
      const match = line.match(methodRegex);
      
      if (match) {
        const indent = match[1].length;
        // 确保这是类内部的方法（缩进大于类）
        if (indent > classIndent) {
          const name = match[2];
          const params = this.parsePythonParams(match[3]);
          const returnType = match[4]?.trim();
          const isAsync = line.includes('async def');
          const isPrivate = name.startsWith('_') && !name.startsWith('__');
          
          // 检查装饰器
          const decorators = this.collectDecorators(i, indent);
          const isStatic = decorators.includes('staticmethod');
          const isClassMethod = decorators.includes('classmethod');
          
          // 提取方法体
          const { endLine: methodEndLine, body, docstring } = this.extractPythonFunctionBody(i + 1, indent);
          
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
            docstring
          });
          
          i = methodEndLine - 1; // 跳过方法体
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
    // 匹配 lambda 赋值: var_name = lambda params: expr
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
          isAsync: false
        });
      }
    }
    
    return functions;
  }

  /**
   * 提取函数体（处理 Python 缩进）
   */
  private extractPythonFunctionBody(startLineIdx: number, baseIndent: number): {
    endLine: number;
    body: string;
    docstring?: string;
  } {
    let body = '';
    let endLine = startLineIdx;
    let docstring = '';
    let inDocstring = false;
    let docstringDelimiter = '';
    
    for (let i = startLineIdx; i < this.lines.length; i++) {
      const line = this.lines[i];
      const lineIndent = line.search(/\S/);
      
      // 如果缩进小于等于基础缩进，说明函数结束了
      if (lineIndent < baseIndent && line.trim() !== '') {
        break;
      }
      
      // 跳过空行
      if (line.trim() === '') {
        if (!inDocstring) {
          endLine = i + 1;
          continue;
        }
      }
      
      // 检测文档字符串
      const docstringMatch = line.match(/^\s*("""|''')(.*?)\1/);
      if (docstringMatch && !inDocstring) {
        docstring = docstringMatch[2];
        inDocstring = false;
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
      
      // 收集函数体
      if (lineIndent >= baseIndent) {
        body += line + '\n';
      }
      
      endLine = i + 1;
    }
    
    return {
      endLine,
      body: body.trim(),
      docstring: docstring || undefined
    };
  }

  /**
   * 收集函数/方法的装饰器
   */
  private collectDecorators(lineIdx: number, indent: number): string[] {
    const decorators: string[] = [];
    let i = lineIdx - 1;
    
    // 向上查找装饰器
    while (i >= 0) {
      const line = this.lines[i];
      const lineIndent = line.search(/\S/);
      const trimmed = line.trim();
      
      // 如果缩进不匹配，停止查找
      if (lineIndent !== indent) break;
      
      // 匹配装饰器 @decorator
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
      
      // 处理嵌套括号（如类型注解中的 Tuple[...]）
      if (char === '[' || char === '(') depth++;
      if (char === ']' || char === ')') depth--;
      
      // 处理默认值中的逗号
      if (char === ',' && depth === 0 && !inDefault) {
        params.push(this.cleanParam(current.trim()));
        current = '';
      } else {
        current += char;
        // 检测默认值开始
        if (char === '=' && depth === 0) {
          inDefault = true;
        }
      }
    }
    
    if (current.trim()) {
      params.push(this.cleanParam(current.trim()));
    }
    
    // 处理 self/cls 参数（通常不显示在参数列表中）
    return params.filter(p => p && !['self', 'cls'].includes(p));
  }

  /**
   * 清理参数（移除类型注解和默认值）
   */
  private cleanParam(param: string): string {
    // 移除类型注解
    const colonIndex = param.indexOf(':');
    if (colonIndex !== -1) {
      param = param.substring(0, colonIndex);
    }
    
    // 移除默认值
    const equalIndex = param.indexOf('=');
    if (equalIndex !== -1) {
      param = param.substring(0, equalIndex);
    }
    
    return param.trim();
  }

  /**
   * 去重
   */
  private deduplicateFunctions(functions: FunctionInfo[]): FunctionInfo[] {
    const seen = new Map<string, FunctionInfo>();
    
    for (const func of functions) {
      const key = `${func.name}:${func.startLine}`;
      if (!seen.has(key)) {
        seen.set(key, func);
      }
    }
    
    return Array.from(seen.values());
  }

  /**
   * 生成报告
   */
  generateReport(functions: FunctionInfo[]): string {
    let report = '=== Python 函数分析报告 ===\n\n';
    
    // 按类型分组
    const grouped = {
      function: functions.filter(f => f.type === 'function'),
      method: functions.filter(f => f.type === 'method'),
      lambda: functions.filter(f => f.type === 'lambda')
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
        report += `文档: ${func.docstring.substring(0, 100)}${func.docstring.length > 100 ? '...' : ''}\n`;
      }
      report += '-' .repeat(40) + '\n';
    }
    
    return report;
  }
}


/**
 * C/C++/Java 风格函数解析器
 * 支持：
 * - C 函数
 * - C++ 函数（包括类方法、命名空间、const 修饰符等）
 * - Java 方法（包括注解、修饰符、泛型、throws 等）
 */

class CFunctionParser {
  private content: string;
  private lines: string[];
  private fileName: string;

  constructor(content: string, fileName: string = 'source.c') {
    this.content = content;
    this.lines = content.split('\n');
    this.fileName = fileName;
  }

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
    return this.parse();
  }

  /**
   * 主解析方法
   */
  private parse(): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    
    // 1. 先提取所有可能的函数声明
    const functionMatches = this.findPotentialFunctions();
    
    for (const match of functionMatches) {
      const funcInfo = this.extractFunctionInfo(match);
      if (funcInfo && this.isValidFunctionInfo(funcInfo)) {
        functions.push(funcInfo);
      }
    }
    
    // 2. 提取类/结构体内的成员函数（如果还没被捕获）
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
    const matches = [];
    
    // 简化的函数匹配正则
    // 匹配模式: [修饰符] 返回类型 函数名(参数) [修饰符] {
    // 例如: 
    //   int add(int a, int b) {
    //   static void process() {
    //   virtual int compute() const {
    //   public String getName() throws Exception {
    const regex = /^[ \t]*(?:(?:static|virtual|inline|extern|public|private|protected|constexpr|final|synchronized|abstract)\s+)*(?:(\w+(?:<[^>]+>)?(?:\s*\*?\s*)?)\s+)?(\w+)\s*\(([^)]*)\)\s*(?:const\s*)?(?:\s*throw\s*\([^)]*\))?\s*(?:override\s*)?(?:final\s*)?(?:\s*=\s*0)?\s*\{/gm;
    
    let match;
    while ((match = regex.exec(this.content)) !== null) {
      const fullMatch = match[0];
      const returnType = (match[1] || 'void').trim();
      const name = match[2];
      const params = match[3];
      
      // 过滤掉关键字和明显不是函数的情况
      if (this.isValidFunctionName(name, fullMatch)) {
        // 提取修饰符
        const modifiers = this.extractModifiers(fullMatch);
        
        matches.push({
          start: match.index,
          signature: fullMatch,
          returnType,
          name,
          params,
          modifiers
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
      // 找到函数体的结束位置
      const bodyStart = match.start + match.signature.length - 1; // 从 { 开始
      const bodyEnd = this.findFunctionEnd(bodyStart);
      
      if (bodyEnd === -1) return null;
      
      // 提取函数体
      const body = this.content.substring(bodyStart, bodyEnd);
      
      // 解析参数
      const parsedParams = this.parseParameters(match.params);
      
      // 判断是否为类方法
      const isMethod = match.modifiers.includes('public') || 
                       match.modifiers.includes('private') || 
                       match.modifiers.includes('protected');
      
      // 提取类名（如果有）
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
        isAsync: false, // C/C++/Java 没有原生的 async 函数（Java 有 CompletableFuture 但不算）
        isPrivate: match.modifiers.includes('private'),
        isStatic: match.modifiers.includes('static'),
        className
      };
    } catch (error) {
      console.warn(`Failed to parse function ${match.name}:`, error);
      return null;
    }
  }

  /**
   * 查找函数体的结束位置（处理嵌套花括号）
   */
  private findFunctionEnd(startPos: number): number {
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
   * 解析参数字符串
   * 例如: "int a, int b" -> ["int a", "int b"]
   *      "string name" -> ["string name"]
   */
  private parseParameters(paramsStr: string): string[] {
    if (!paramsStr.trim()) return [];
    
    const params: string[] = [];
    let current = '';
    let depth = 0;
    
    for (let i = 0; i < paramsStr.length; i++) {
      const char = paramsStr[i];
      
      // 处理泛型括号 <>
      if (char === '<') depth++;
      if (char === '>') depth--;
      
      // 处理参数分隔符
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
    const modifierKeywords = ['static', 'virtual', 'inline', 'extern', 
                               'public', 'private', 'protected', 'constexpr',
                               'final', 'synchronized', 'abstract'];
    
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
    // 向前搜索，查找最近的 class 或 struct 定义
    const beforeFunction = this.content.substring(0, functionStart);
    const classMatch = /(?:class|struct)\s+(\w+)\s*\{[^}]*$/s.exec(beforeFunction);
    
    if (classMatch) {
      return classMatch[1];
    }
    
    return undefined;
  }

  /**
   * 清理函数体（移除多余空白）
   */
  private cleanBody(body: string): string {
    // 保留基本结构，但清理首尾空白
    let cleaned = body.trim();
    
    // 移除过多的空行（保留最多一个空行）
    cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n\n');
    
    return cleaned;
  }

  /**
   * 标准化返回类型
   */
  private normalizeReturnType(returnType: string): string {
    if (!returnType || returnType === '') return 'void';
    
    // 处理指针和引用
    let normalized = returnType.trim();
    
    // 移除多余的修饰符
    normalized = normalized.replace(/^(const|volatile)\s+/, '');
    
    return normalized;
  }

  /**
   * 验证函数名是否有效
   */
  private isValidFunctionName(name: string, fullMatch: string): boolean {
    // 过滤关键字
    const keywords = ['if', 'else', 'while', 'for', 'switch', 'case', 
                      'class', 'struct', 'enum', 'namespace', 'template',
                      'new', 'delete', 'sizeof', 'typeof'];
    
    if (keywords.includes(name)) return false;
    
    // 过滤 C++ 操作符重载
    if (name === 'operator') return false;
    
    // 过滤明显的非函数（如类定义）
    if (fullMatch.includes('class ') && fullMatch.includes('{') && 
        !fullMatch.includes('(')) return false;
    
    return true;
  }

  /**
   * 提取类/结构体中的成员函数（Java 风格）
   */
  private extractClassMethods(): FunctionInfo[] {
    const methods: FunctionInfo[] = [];
    
    // 匹配类/结构体定义
    const classRegex = /(?:class|struct)\s+(\w+)(?:\s*:\s*[^{]+)?\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/gs;
    
    let classMatch;
    while ((classMatch = classRegex.exec(this.content)) !== null) {
      const className = classMatch[1];
      const classBody = classMatch[2];
      
      // 在类体内匹配方法定义
      const methodRegex = /^[ \t]*(?:public|private|protected|static|virtual|abstract|final|synchronized)?\s*(\w+(?:<[^>]+>)?(?:\s*\*?\s*)?)\s+(\w+)\s*\(([^)]*)\)\s*(?:const\s*)?(?:\s*throw\s*\([^)]*\))?\s*(?:override\s*)?\s*\{/gm;
      
      let methodMatch;
      while ((methodMatch = methodRegex.exec(classBody)) !== null) {
        const returnType = methodMatch[1].trim();
        const name = methodMatch[2];
        const params = methodMatch[3];
        
        // 计算在整个文件中的位置
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
            className
          });
        }
      }
    }
    
    return methods;
  }

  /**
   * 获取行号
   */
  private getLineNumber(position: number): number {
    let lineCount = 1;
    for (let i = 0; i < position && i < this.content.length; i++) {
      if (this.content[i] === '\n') {
        lineCount++;
      }
    }
    return lineCount;
  }

  /**
   * 去重函数
   */
  private deduplicateFunctions(functions: FunctionInfo[]): FunctionInfo[] {
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
   * 验证函数信息的有效性
   */
  private isValidFunctionInfo(func: FunctionInfo): boolean {
    // 基本验证
    if (!func.name || func.name.length === 0) return false;
    if (func.startLine > func.endLine) return false;
    
    // 过滤构造函数/析构函数（C++）
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
    
    // 按类型统计
    const funcCount = functions.filter(f => f.type === 'function').length;
    const methodCount = functions.filter(f => f.type === 'method').length;
    
    report += `- 普通函数: ${funcCount}\n`;
    report += `- 类方法: ${methodCount}\n\n`;
    
    // 按访问权限统计
    const publicMethods = functions.filter(f => !f.isPrivate).length;
    const privateMethods = functions.filter(f => f.isPrivate).length;
    
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

export{
  CFunctionParser,
  PyFunctionParser,
  tsFunctionParser,
}

// 使用示例
export function analyzeCSource(filePath: string) {
  const parser = new CFunctionParser('');
  const functions = parser.parseFile(filePath);
  const report = parser.generateReport(functions);
  
  console.log(report);
  return functions;
}

export function analyzePythonFile(filePath: string) {
  const parser = new PyFunctionParser('');
  const functions = parser.parseFile(filePath);
  const report = parser.generateReport(functions);
  
  console.log(report);
  return functions;
}

export function analyzeTsCodeFile(filePath: string) {
  const parser = new tsFunctionParser('');
  const functions = parser.parseFile(filePath);
  const report = parser.generateReport(functions);
  
  console.log(report);
  return functions;
}


