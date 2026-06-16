import { FunctionInfo } from './types';
import { BaseParser } from './base-parser';

export class TsFunctionParser extends BaseParser {
  protected parse(): FunctionInfo[] {
    return this.extractAllFunctions();
  }

  private extractAllFunctions(): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    this.extractTopLevelFunctions(functions);
    this.extractClassMethods(functions);
    return this.deduplicateFunctions(functions);
  }

  // ─── 偏移量辅助 ────────────────────────────────

  /** 第 lineIdx 行（0-based）在 content 中的起始偏移 */
  private lineStartOffset(lineIdx: number): number {
    let off = 0;
    for (let i = 0; i < lineIdx && i < this.lines.length; i++) {
      off += this.lines[i].length + 1;
    }
    return off;
  }

  // ─── 通用提取原语 ──────────────────────────────

  /** 从 fromIdx 找到匹配的 ) 返回参数字符串和结束位置 */
  private extractParens(fromIdx: number): { paramsStr: string; endIdx: number } | null {
    let pos = fromIdx;
    while (pos < this.content.length && this.content[pos] !== '(') {
      if (';{}'.includes(this.content[pos])) return null;
      pos++;
    }
    if (pos >= this.content.length) return null;
    const start = pos + 1;
    let depth = 1;
    pos = start;
    while (pos < this.content.length && depth > 0) {
      const ch = this.content[pos];
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      pos++;
    }
    if (depth !== 0) return null;
    return { paramsStr: this.content.substring(start, pos - 1), endIdx: pos };
  }

  /** 从 fromIdx 找到 { 并匹配 }，返回 body 和结束位置（含花括号） */
  private extractBody(fromIdx: number): { body: string; endIdx: number } | null {
    let pos = fromIdx;
    while (pos < this.content.length && this.content[pos] !== '{') {
      if (';}'.includes(this.content[pos])) return null;
      pos++;
    }
    if (pos >= this.content.length) return null;
    const bodyEnd = this.findFunctionEnd(pos + 1);
    if (bodyEnd === -1) return null;
    return { body: this.content.substring(pos, bodyEnd), endIdx: bodyEnd };
  }

  /**
   * 从签名文本中提取返回类型（最后一个 ) 之后的 : type）
   * "function foo(a: string): Promise<Bar[]>" → "Promise<Bar[]>"
   */
  private extractReturnType(text: string): string | undefined {
    const parenIdx = text.lastIndexOf(')');
    if (parenIdx === -1) return undefined;
    const after = text.substring(parenIdx + 1).trim();
    const m = after.match(/^:\s*([^{;]+)/);
    return m ? m[1].trim() : undefined;
  }

  private extractModifiers(text: string) {
    return {
      isAsync: /\basync\b/.test(text),
      isPrivate: /\bprivate\b/.test(text),
      isStatic: /\bstatic\b/.test(text),
      isProtected: /\bprotected\b/.test(text),
      isGetter: /\bget\b/.test(text),
      isSetter: /\bset\b/.test(text),
    };
  }

  /**
   * 解析参数列表，保留完整 name: type 格式
   * 正确处理嵌套泛型 <Array<Foo>> 中的逗号
   */
  private parseParamsWithTypes(paramsStr: string): string[] {
    if (!paramsStr.trim()) return [];
    const result: string[] = [];
    let cur = '';
    let depth = 0;
    for (let i = 0; i < paramsStr.length; i++) {
      const ch = paramsStr[i];
      if ('(<['.includes(ch)) depth++;
      if (')>]'.includes(ch)) depth--;
      if (ch === ',' && depth === 0) { result.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    if (cur.trim()) result.push(cur.trim());
    return result;
  }

  /** 合并第 lineIdx 行前的 JSDoc */
  private collectJSDoc(lineIdx: number): string | undefined {
    const parts: string[] = [];
    for (let i = lineIdx - 1; i >= 0; i--) {
      const t = this.lines[i].trim();
      if (t.startsWith('/**')) { parts.unshift(t); break; }
      if (t.startsWith('*')) { parts.unshift(t); continue; }
      if (t === '' || t.startsWith('//')) break;
      break;
    }
    if (!parts.length) return undefined;
    return parts.join('\n')
      .replace(/^\s*\/\*\*?\s*|\s*\*\/\s*$/g, '')
      .replace(/^\s*\*\s?/gm, '').trim() || undefined;
  }

  // ─── 顶层函数声明/表达式 ─────────────────────────

  private extractTopLevelFunctions(result: FunctionInfo[]): void {
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
      if (/^\s*(import|export\s+(type|interface|enum|namespace|class)|interface|enum|namespace|type\s)/.test(line)) continue;
      if (/^\s*class\s+/.test(line)) continue;

      const fd = t.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (fd) { this.addFunc(i, fd[1], 'function', result); continue; }

      const ed = t.match(/^export\s+default\s+(?:async\s+)?function\s+(\w+)/);
      if (ed) { this.addFunc(i, ed[1], 'function', result); continue; }

      const as = t.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*/);
      if (as) {
        const afterEq = line.substring(line.indexOf('=') + 1).trim();
        if (/^(?:async\s+)?(?:function\s*\(|\(|\w+\s*=>)/.test(afterEq)) {
          this.addAssignFunc(i, as[1], result);
        }
      }
    }
  }

  private addFunc(lineIdx: number, name: string, type: 'function' | 'arrow', result: FunctionInfo[]): void {
    const lineStart = this.lineStartOffset(lineIdx);
    const lineText = this.lines[lineIdx];
    const parenStart = lineStart + lineText.indexOf('(');
    if (lineText.indexOf('(') < 0) return;
    const paren = this.extractParens(parenStart);
    if (!paren) return;
    const params = this.parseParamsWithTypes(paren.paramsStr);
    const body = this.extractBody(paren.endIdx);
    const endPos = body ? body.endIdx : paren.endIdx;
    const sigText = this.content.substring(lineStart, paren.endIdx);
    const returnType = this.extractReturnType(sigText);
    const mod = this.extractModifiers(lineText);
    const jsdoc = this.collectJSDoc(lineIdx);
    result.push({
      name, type, params, returnType,
      startLine: lineIdx + 1,
      endLine: body ? this.getLineNumber(endPos) : lineIdx + 1,
      body: body ? body.body : '',
      isAsync: mod.isAsync,
      docstring: jsdoc,
    });
  }

  private addAssignFunc(lineIdx: number, name: string, result: FunctionInfo[]): void {
    const lineStart = this.lineStartOffset(lineIdx);
    const lineText = this.lines[lineIdx];
    const eqIdx = lineText.indexOf('=');
    if (eqIdx < 0) return;

    // 在 = 之后找 ( 或 =>
    const afterEq = lineText.substring(eqIdx + 1);
    const parenPos = afterEq.indexOf('(');
    const arrowPos = afterEq.indexOf('=>');

    let paren: { paramsStr: string; endIdx: number } | null = null;
    let isArrow = false;
    let bodyStartOffset = 0;

    if (parenPos >= 0) {
      paren = this.extractParens(lineStart + eqIdx + 1 + parenPos);
      if (!paren) return;
      // 检查 ) 后面是否有 =>
      const afterParen = this.content.substring(paren.endIdx, paren.endIdx + 5).trim();
      isArrow = afterParen.startsWith('=>');
      bodyStartOffset = paren.endIdx + (isArrow ? afterParen.indexOf('=>') + 2 : 0);
    } else if (arrowPos >= 0) {
      isArrow = true;
      bodyStartOffset = lineStart + eqIdx + 1 + arrowPos + 2;
    } else {
      return;
    }

    const params = paren ? this.parseParamsWithTypes(paren.paramsStr) : [];
    const body = this.extractBody(bodyStartOffset);
    const endPos = body ? body.endIdx : bodyStartOffset;
    const sigText = paren ? this.content.substring(lineStart, paren.endIdx) : '';
    const returnType = paren ? this.extractReturnType(sigText) : undefined;
    const mod = this.extractModifiers(lineText);
    const jsdoc = this.collectJSDoc(lineIdx);

    result.push({
      name,
      type: isArrow ? 'arrow' : 'function',
      params, returnType,
      startLine: lineIdx + 1,
      endLine: body ? this.getLineNumber(endPos) : lineIdx + 1,
      body: body ? body.body : (paren ? '' : this.content.substring(bodyStartOffset, bodyStartOffset + 80).split('\n')[0].trim()),
      isAsync: mod.isAsync,
      docstring: jsdoc,
    });
  }

  // ─── 类方法提取 ──────────────────────────────────

  private extractClassMethods(result: FunctionInfo[]): void {
    for (let i = 0; i < this.lines.length; i++) {
      const m = this.lines[i].match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
      if (!m) continue;

      const className = m[1];
      const classStart = this.lineStartOffset(i);
      const bracePos = this.content.indexOf('{', classStart);
      if (bracePos < 0) continue;

      const classEnd = this.findFunctionEnd(bracePos + 1);
      if (classEnd < 0) continue;

      // 类体去掉最外层 {}，剩下所有行
      const bodyStr = this.content.substring(bracePos + 1, classEnd - 1);
      const bodyLines = bodyStr.split('\n');

      let accOff = 0; // 已扫描 bodyStr 的累计字符数
      for (let j = 0; j < bodyLines.length; j++) {
        const bl = bodyLines[j];
        const tBl = bl.trim();
        if (!tBl || tBl.startsWith('//') || tBl.startsWith('/*') || tBl.startsWith('*')) {
          accOff += bl.length + 1; continue;
        }

        // 匹配方法签名行
        const sig = tBl.match(/^(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|abstract\s+|async\s+|get\s+|set\s+)*(\w+)\s*\(/);
        if (!sig || sig[0].includes('=')) { accOff += bl.length + 1; continue; }

        const methodName = sig[1];
        const localParenIdx = tBl.indexOf('(');
        if (localParenIdx < 0) { accOff += bl.length + 1; continue; }

        // 全局偏移 = 类体起始 + 累计偏移 + 该行中 '(' 的位置
        const parenOff = bracePos + 1 + accOff + bl.indexOf('(');
        const paren = this.extractParens(parenOff);
        if (!paren) { accOff += bl.length + 1; continue; }

        const params = this.parseParamsWithTypes(paren.paramsStr);
        const body = this.extractBody(paren.endIdx);
        const methodEnd = body ? body.endIdx : paren.endIdx;
        const sigText = this.content.substring(bracePos + 1 + accOff, paren.endIdx);
        const returnType = this.extractReturnType(sigText);
        const mod = this.extractModifiers(tBl);
        const globalLine = this.getLineNumber(bracePos + 1 + accOff) - 1;
        const jsdoc = this.collectJSDoc(globalLine);

        result.push({
          name: methodName,
          type: 'method',
          params, returnType,
          startLine: globalLine + 1,
          endLine: body ? this.getLineNumber(methodEnd) : globalLine + 1,
          body: body ? body.body : '',
          isAsync: mod.isAsync,
          isPrivate: mod.isPrivate,
          isStatic: mod.isStatic,
          className,
          docstring: jsdoc,
        });

        // 跳过已处理的方法体行
        if (body) {
          const consumedTotal = methodEnd - (bracePos + 1);
          let newAcc = 0, skip = 0;
          for (let k = 0; k < bodyLines.length; k++) {
            if (newAcc >= consumedTotal) break;
            newAcc += bodyLines[k].length + 1;
            skip++;
          }
          j += skip - 1; // for 循环会 j++
          accOff = newAcc;
        } else {
          accOff += bl.length + 1;
        }
      }
    }
  }

  generateReport(functions: FunctionInfo[]): string {
    let report = '=== 函数定义分析报告 ===\n\n';
    const grouped = {
      function: functions.filter(f => f.type === 'function'),
      method: functions.filter(f => f.type === 'method'),
      arrow: functions.filter(f => f.type === 'arrow'),
    };
    report += `总计: ${functions.length} 个函数\n`;
    report += `- 普通函数: ${grouped.function.length}\n`;
    report += `- 类方法: ${grouped.method.length}\n`;
    report += `- 箭头函数: ${grouped.arrow.length}\n\n`;
    report += '详细列表:\n';
    report += '='.repeat(80) + '\n';
    for (const func of functions) {
      let extra = `\n名称: ${func.name}\n类型: ${func.type}`;
      if (func.className) extra += ` (类: ${func.className})`;
      extra += `\n参数: (${func.params.join(', ')})\n`;
      if (func.returnType) extra += `返回: ${func.returnType}\n`;
      extra += `位置: 第 ${func.startLine} - ${func.endLine} 行\n`;
      extra += `异步: ${func.isAsync ? '是' : '否'}\n`;
      if (func.isPrivate) extra += `访问: private\n`;
      if (func.isStatic) extra += `静态: 是\n`;
      if (func.docstring) extra += `文档: ${func.docstring.substring(0, 100)}${func.docstring.length > 100 ? '...' : ''}\n`;
      report += extra + '-'.repeat(40) + '\n';
    }
    return report;
  }
}

