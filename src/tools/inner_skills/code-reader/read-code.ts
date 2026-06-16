import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolvePath } from '../../../workdir.js';
import { getParserByFileType, getSupportedFileTypes } from './aux_parser/index';

// ─── 工具函数 ───────────────────────────────────────────────

/**
 * 格式化函数签名为简短字符串格式: funcName(paramType1, paramType2): ReturnType
 */
function formatFuncSignature(func: {
  name: string;
  params: string[];
  returnType?: string;
  isAsync?: boolean;
  isPrivate?: boolean;
  isStatic?: boolean;
  className?: string;
}): string {
  const prefix = func.isPrivate ? '🔒' : func.isStatic ? '⚡' : '';
  const asyncMark = func.isAsync ? 'async ' : '';
  const scope = func.className ? `${func.className}.` : '';
  const params = func.params.join(', ');
  const ret = func.returnType ? `: ${func.returnType}` : '';
  return `${prefix}${asyncMark}${scope}${func.name}(${params})${ret}`;
}

/**
 * 提取参数的类型部分（移除参数名，保留类型注解等）
 * 例如 "int a" → "int", "name: string" → "string", "age" → "Any"
 */
function extractParamTypes(params: string[]): string[] {
  return params.map((p) => {
    // 处理 "名称: 类型" 格式（TS/Python风格），优先检查
    const colonIdx = p.indexOf(':');
    if (colonIdx !== -1) {
      return p.substring(colonIdx + 1).trim();
    }
    // 处理 "类型 名称" 格式（C/Java风格）
    const parts = p.trim().split(/\s+/);
    if (parts.length >= 2 && !parts[0].includes('.')) {
      return parts.slice(0, -1).join(' ');
    }
    // 只有名称，无法推断类型
    return 'Any';
  });
}


/**
 * 生成扫描用的短签名: funcName(Type1, Type2): RetType
 */
function makeShortSignature(func: {
  name: string;
  params: string[];
  returnType?: string;
  isAsync?: boolean;
  isPrivate?: boolean;
  isStatic?: boolean;
  className?: string;
}): string {
  const paramTypes = extractParamTypes(func.params);
  const prefix = func.isPrivate ? '🔒' : func.isStatic ? '⚡' : '';
  const asyncMark = func.isAsync ? 'async ' : '';
  const scope = func.className ? `${func.className}.` : '';
  const params = paramTypes.join(', ');
  const ret = func.returnType ? `: ${func.returnType}` : '';
  return `${prefix}${asyncMark}${scope}${func.name}(${params})${ret}`;
}

// ─── scanningFunction: 扫描全部函数，仅输出签名概览 ──────────

export const scanningFunction = tool({
  description: `扫描代码文件中所有函数的签名概览。适合快速了解文件提供了哪些函数。
  输出格式每行如：funcName(Type1, Type2): ReturnType
  参数 filePath 是文件的绝对路径或相对当前工作目录的路径。
  fileType 是文件的解析类型（即扩展名小写）。`,
  inputSchema: z.object({
    filePath: z.string().describe('要扫描的代码文件路径'),
    fileType: z.string().describe('文件类型（扩展名小写），如 ts, js, py, c, cpp, java'),
  }),
  execute: async ({ filePath, fileType }): Promise<string> => {
    try {
      const rawcontent = await fs.readFile(resolvePath(filePath), 'utf-8');
      const parser = getParserByFileType(fileType);

      if (!parser) {
        return `不支持解析的文件类型："${fileType}"，支持的类型：${getSupportedFileTypes().join(', ')}`;
      }

      parser.setContent(rawcontent, filePath);
      const funcs = parser.parseCode(rawcontent);

      if (funcs.length === 0) {
        return `在文件 ${filePath} 中未发现任何函数定义。`;
      }

      const lines = funcs.map((f, i) => `${String(i + 1).padStart(3)}. ${makeShortSignature(f)}`);
      return [
        `📋 函数扫描 (${filePath})`,
        `总计: ${funcs.length} 个函数/方法\n`,
        ...lines,
      ].join('\n');
    } catch (error) {
      return `扫描失败: ${(error as Error).message}`;
    }
  },
});

// ─── readFunction: 读取指定函数的详细信息 ──────────────────

export const readFunction = tool({
  description: `根据函数名称读取指定函数的详细信息，包括参数、返回值、位置、完整代码体。
  参数 filePath 是文件的绝对路径或相对当前工作目录的路径。
  fileType 是文件的解析类型（即扩展名小写）。
  functionName 是函数名（支持 ClassName.methodName 格式指定类方法）。`,
  inputSchema: z.object({
    filePath: z.string().describe('要分析的代码文件路径'),
    fileType: z.string().describe('文件类型（扩展名小写）'),
    functionName: z.string().describe('函数名，使用 ClassName.methodName 格式可指定类方法'),
  }),
  execute: async ({ filePath, fileType, functionName }): Promise<string> => {
    try {
      const rawcontent = await fs.readFile(resolvePath(filePath), 'utf-8');
      const parser = getParserByFileType(fileType);

      if (!parser) {
        return `不支持解析的文件类型："${fileType}"`;
      }

      parser.setContent(rawcontent, filePath);
      const funcs = parser.parseCode(rawcontent);

      // 解析函数名：支持 "ClassName.methodName" 格式
      let targetName = functionName;
      let targetClass: string | undefined;
      const dotIdx = functionName.indexOf('.');
      if (dotIdx !== -1) {
        targetClass = functionName.substring(0, dotIdx);
        targetName = functionName.substring(dotIdx + 1);
      }

      // 查找匹配的函数
      const matched = funcs.filter((f) => {
        const nameMatch = f.name === targetName;
        const classMatch = targetClass ? f.className === targetClass : true;
        return nameMatch && classMatch;
      });

      if (matched.length === 0) {
        if (targetClass) {
          return `未找到函数 ${targetClass}.${targetName}()`;
        }
        return `未找到函数 ${targetName}()`;
      }

      if (matched.length > 1) {
        // 有多个同名函数，列出所有候选
        const candidates = matched.map(
          (f) => `  ${f.className ? f.className + '.' : ''}${f.name}(${f.params.join(', ')}) (第 ${f.startLine} 行)`
        );
        return `发现多个同名函数，请使用 ClassName.methodName 指定:\n${candidates.join('\n')}`;
      }

      const func = matched[0];

      // 构建详细报告
      const bodyLines = func.body.split('\n');
      const bodyPreview = bodyLines.slice(0, 30);
      const bodyStr = bodyPreview.join('\n') + (bodyLines.length > 30 ? '\n... (已截断)' : '');

      const detail = [
        `─`.repeat(50),
        `─`.repeat(50),
        `  类型: ${func.type}`,
        `  位置: 第 ${func.startLine} - ${func.endLine} 行`,
        func.isAsync ? `  异步: 是` : null,
        func.isPrivate ? `  访问权限: private` : null,
        func.isStatic ? `  静态: 是` : null,
        func.isClassMethod ? `  类方法: 是` : null,
        func.className ? `  所属类: ${func.className}` : null,
        func.decorators && func.decorators.length > 0 ? `  装饰器: ${func.decorators.join(', ')}` : null,
        func.docstring ? `\n  📝 文档:\n${func.docstring}` : null,
        `\n  📄 代码体 (${bodyLines.length} 行):`,
        bodyStr,
      ]
        .filter(Boolean)
        .join('\n');

      return detail;
    } catch (error) {
      return `读取失败: ${(error as Error).message}`;
    }
  },
});

// ─── scanningClass: 扫描类，仅输出类名及方法签名 ──────────

export const scanningClass = tool({
  description: `扫描代码文件中的类/结构体定义概览。每个类输出其名称、位置和方法签名列表。
  参数 filePath 是文件的绝对路径或相对当前工作目录的路径。
  fileType 是文件的解析类型（即扩展名小写）。`,
  inputSchema: z.object({
    filePath: z.string().describe('要扫描的代码文件路径'),
    fileType: z.string().describe('文件类型（扩展名小写）'),
  }),
  execute: async ({ filePath, fileType }): Promise<string> => {
    try {
      const rawcontent = await fs.readFile(resolvePath(filePath), 'utf-8');
      const parser = getParserByFileType(fileType);

      if (!parser) {
        return `不支持解析的文件类型："${fileType}"，支持的类型：${getSupportedFileTypes().join(', ')}`;
      }

      parser.setContent(rawcontent, filePath);
      const funcs = parser.parseCode(rawcontent);
      const onlyMethods = funcs.filter((f) => f.type === 'method' && f.className);

      if (onlyMethods.length === 0) {
        // 即使没有类方法，也尝试用正则扫描类定义
        const lines = rawcontent.split('\n');
        const classDefs: string[] = [];
        const classPattern = /^\s*(?:export\s+)?(?:abstract\s+)?(?:class|struct|interface)\s+(\w+)/;
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(classPattern);
          if (m) classDefs.push(`${m[1]} (第 ${i + 1} 行)`);
        }
        if (classDefs.length > 0) {
          return [`📋 类扫描 (${filePath})`, '未发现类方法，但检测到以下类定义：', ...classDefs.map((d) => `  📦 ${d}`)].join('\n');
        }
        return `在文件 ${filePath} 中未发现类/结构体定义。`;
      }

      // 按类名分组
      const classMap = new Map<string, typeof onlyMethods>();
      for (const m of onlyMethods) {
        const cn = m.className!;
        if (!classMap.has(cn)) classMap.set(cn, []);
        classMap.get(cn)!.push(m);
      }

      const result: string[] = [`📋 类扫描 (${filePath})`, `总计: ${classMap.size} 个类/结构体\n`];

      for (const [className, methods] of classMap) {
        result.push(`📦 ${className} (${methods.length} 个方法)`);
        for (const m of methods) {
          result.push(`   ${makeShortSignature(m)}`);
        }
        result.push('');
      }

      return result.join('\n');
    } catch (error) {
      return `扫描失败: ${(error as Error).message}`;
    }
  },
});

// ─── readClass: 读取指定类的详细信息 ──────────────────────

export const readClass = tool({
  description: `读取指定类的详细信息，包括类中所有方法的详细签名、位置、代码体。
  参数 filePath 是文件的绝对路径或相对当前工作目录的路径。
  fileType 是文件的解析类型（即扩展名小写）。
  className 是要读取的类/结构体名称。`,
  inputSchema: z.object({
    filePath: z.string().describe('要分析的代码文件路径'),
    fileType: z.string().describe('文件类型（扩展名小写）'),
    className: z.string().describe('要读取详细信息的类/结构体名称'),
  }),
  execute: async ({ filePath, fileType, className }): Promise<string> => {
    try {
      const rawcontent = await fs.readFile(resolvePath(filePath), 'utf-8');
      const parser = getParserByFileType(fileType);

      if (!parser) {
        return `不支持解析的文件类型："${fileType}"`;
      }

      parser.setContent(rawcontent, filePath);
      const funcs = parser.parseCode(rawcontent);
      const classMethods = funcs.filter((f) => f.type === 'method' && f.className === className);

      if (classMethods.length === 0) {
        return `在文件 ${filePath} 中未找到类 "${className}" 或其没有任何方法。`;
      }

      const result: string[] = [
        `📦 类详情: ${className}`,
        `文件: ${filePath}`,
        `方法总数: ${classMethods.length}`,
        `${'='.repeat(60)}`,
      ];

      for (const m of classMethods) {
        const bodyLines = m.body.split('\n');
        const bodyPreview = bodyLines.slice(0, 15).join('\n');
        const bodyStr = bodyPreview + (bodyLines.length > 15 ? '\n    ... (已截断)' : '');

        result.push('');
        result.push(`  ${formatFuncSignature(m)}`);
        result.push(`    位置: 第 ${m.startLine} - ${m.endLine} 行`);
        result.push(`    异步: ${m.isAsync ? '是' : '否'}`);
        if (m.isPrivate) result.push(`    访问: private`);
        if (m.isStatic) result.push(`    静态: 是`);
        if (m.decorators && m.decorators.length > 0) result.push(`    装饰器: ${m.decorators.join(', ')}`);
        if (m.docstring) result.push(`    文档: ${m.docstring.substring(0, 120)}${m.docstring.length > 120 ? '...' : ''}`);
        result.push(`    代码体:`);
        result.push(bodyStr.split('\n').map((l) => `      ${l}`).join('\n'));
        result.push(`${'-'.repeat(50)}`);
      }

      return result.join('\n');
    } catch (error) {
      return `读取失败: ${(error as Error).message}`;
    }
  },
});

// ─── readPackage: 读取导入的包/库 ─────────────────────────

export const readPackage = tool({
  description: `读取代码文件中导入的软件包、库等，并返回名称列表和所在行位置。
  参数 filePath 是文件的绝对路径或相对当前工作目录的路径。`,
  inputSchema: z.object({
    filePath: z.string().describe('要分析的代码文件路径'),
  }),
  execute: async ({ filePath }): Promise<string> => {
    try {
      const rawcontent = await fs.readFile(resolvePath(filePath), 'utf-8');
      const lines = rawcontent.split('\n');
      const imports = new Map<string, string[]>();

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // ES6/TS import
        let match = line.match(/import\s+(?:\{[^}]*\}\s+from\s+)?['"]([^'"]+)['"]/);
        if (match) {
          const source = match[1];
          if (!imports.has(source)) imports.set(source, []);
          imports.get(source)!.push(`第 ${i + 1} 行`);
          continue;
        }

        // require
        match = line.match(/(?:const|let|var)\s+\w+\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
        if (match) {
          const source = match[1];
          if (!imports.has(source)) imports.set(source, []);
          imports.get(source)!.push(`第 ${i + 1} 行`);
          continue;
        }

        // Python import
        match = line.match(/^(?:from\s+(\S+)\s+)?import\s+(\S+)/);
        if (match) {
          const source = match[1] || match[2];
          if (!imports.has(source)) imports.set(source, []);
          imports.get(source)!.push(`第 ${i + 1} 行`);
          continue;
        }

        // Java import
        match = line.match(/^import\s+([\w.]+);/);
        if (match) {
          const source = match[1];
          if (!imports.has(source)) imports.set(source, []);
          imports.get(source)!.push(`第 ${i + 1} 行`);
          continue;
        }

        // C/C++ include
        match = line.match(/^#include\s+[<"]([^>"]+)[>"]/);
        if (match) {
          const source = match[1];
          if (!imports.has(source)) imports.set(source, []);
          imports.get(source)!.push(`第 ${i + 1} 行`);
        }
      }

      if (imports.size === 0) {
        return `在文件 ${filePath} 中未发现导入语句。`;
      }

      let report = `=== 导入包/库分析 ===\n`;
      report += `文件: ${filePath}\n`;
      report += `总计: ${imports.size} 个导入\n\n`;

      for (const [source, locations] of imports) {
        report += `📦 ${source}\n`;
        for (const loc of locations) {
          report += `   └─ ${loc}\n`;
        }
      }

      return report;
    } catch (error) {
      return `读取失败: ${(error as Error).message}`;
    }
  },
});

// ─── codeReaderPromptGet: 获取本技能的 SKILL.md ─────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const codeReaderPromptGet = tool({
  description: `获取 code-reader 技能的详细说明文档（SKILL.md），包含可用工具列表、使用流程建议和支持的文件类型。`,
  inputSchema: z.object({}),
  execute: async (): Promise<string> => {
    try {
      const skillPath = path.join(__dirname, 'SKILL.md');
      const content = await fs.readFile(skillPath, 'utf-8');
      return content;
    } catch (error) {
      return `读取失败: ${(error as Error).message}`;
    }
  },
});






// ─── scanning_tag: HTML 标签扫描 ────────────────────────

export const scanningTag = tool({
  description: `扫描 HTML 文件中的所有标签结构，返回标签名、属性、类/ID 等。
  参数 filePath 是文件的绝对路径或相对当前工作目录的路径。
  tagName 可选，指定只扫描特定标签（如 div, script）。`,
  inputSchema: z.object({
    filePath: z.string().describe('要分析的 HTML 文件路径'),
    tagName: z.string().optional().describe('可选，只扫描指定标签名（小写）'),
  }),
  execute: async ({ filePath, tagName }): Promise<string> => {
    try {
      const { HtmlParser } = await import('./aux_parser/html-parser');
      const rawcontent = await fs.readFile(resolvePath(filePath), 'utf-8');
      const parser = new HtmlParser();
      parser.setContent(rawcontent, filePath);
      let tags = parser.extractAllTags();

      if (tagName) {
        tags = tags.filter(t => t.tagName === tagName.toLowerCase());
      }

      if (tags.length === 0) {
        return `在文件 ${filePath} 中未${tagName ? `找到 <${tagName}> 标签` : '发现任何标签'}。`;
      }

      // 按标签名统计
      const tagCount = new Map<string, number>();
      for (const t of tags) {
        tagCount.set(t.tagName, (tagCount.get(t.tagName) || 0) + 1);
      }

      const lines: string[] = [`📋 HTML 标签扫描 (${filePath})`];
      lines.push(`总计: ${tags.length} 个标签\n`);

      // 标签统计概览
      lines.push('--- 标签统计 ---');
      for (const [name, count] of [...tagCount.entries()].sort((a, b) => b[1] - a[1])) {
        lines.push(`  <${name}> × ${count}`);
      }
      lines.push('');

      // 详细列表
      lines.push('--- 标签详情 ---');
      for (const t of tags.slice(0, 50)) {
        const attrStr = Object.entries(t.attributes)
          .filter(([k]) => k !== 'id' && k !== 'class')
          .map(([k, v]) => v ? `${k}="${v}"` : k)
          .join(' ');
        const info = [`<${t.tagName}`];
        if (t.id) info.push(`#${t.id}`);
        if (t.classes.length) info.push(`.${t.classes.join('.')}`);
        if (attrStr) info.push(` [${attrStr}]`);
        if (t.selfClosing) info.push(' /');
        info.push('>');
        lines.push(`  L${t.startLine} ${info.join(' ')}`);
        if (t.contentPreview) {
          lines.push(`      内容: "${t.contentPreview.substring(0, 60)}"`);
        }
      }

      if (tags.length > 50) {
        lines.push(`... 及另外 ${tags.length - 50} 个标签`);
      }

      return lines.join('\n');
    } catch (error) {
      return `标签扫描失败: ${(error as Error).message}`;
    }
  },
});

// ─── scanning_script: HTML 脚本块扫描 ────────────────────

export const scanningScript = tool({
  description: `扫描 HTML 文件中的 <script> 块，提取其语言类型、行号范围和代码内容。
  参数 filePath 是文件的绝对路径或相对当前工作目录的路径。`,
  inputSchema: z.object({
    filePath: z.string().describe('要分析的 HTML 文件路径'),
  }),
  execute: async ({ filePath }): Promise<string> => {
    try {
      const { HtmlParser } = await import('./aux_parser/html-parser');
      const rawcontent = await fs.readFile(resolvePath(filePath), 'utf-8');
      const parser = new HtmlParser();
      parser.setContent(rawcontent, filePath);
      const blocks = parser.extractAllScriptBlocks();

      if (blocks.length === 0) {
        return `在文件 ${filePath} 中未发现 <script> 块。`;
      }

      const lines: string[] = [`📜 HTML 脚本块扫描 (${filePath})`];
      lines.push(`总计: ${blocks.length} 个脚本块\n`);

      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        const lang = b.language || 'javascript';
        const codePreview = b.code.split('\n').slice(0, 5).join('\n');
        const codeStr = codePreview + (b.code.split('\n').length > 5 ? '\n  ... (已截断)' : '');

        lines.push(`── 脚本块 #${i + 1} ──`);
        lines.push(`  语言: ${lang}`);
        lines.push(`  位置: 第 ${b.startLine} - ${b.endLine} 行`);
        lines.push(`  代码 (${b.code.length} 字符):`);
        lines.push(codeStr.split('\n').map(l => `    ${l}`).join('\n'));
        lines.push('');
      }

      return lines.join('\n');
    } catch (error) {
      return `脚本扫描失败: ${(error as Error).message}`;
    }
  },
});

// ─── jump_to_definition: 跳转至定义 ──────────────────────

export const jumpToDefinition = tool({
  description: `在代码文件中查找某个符号（函数名、变量名、类名等）的定义位置。
  支持多语言：TS/JS, Python, C/C++, Java, HTML。
  首先在指定文件中搜索；如未找到且 searchProject 为 true，
  则在 projectRoot 目录中递归搜索。
  参数 filePath 是文件的绝对路径或相对当前工作目录的路径。
  symbolName 是要查找的符号名称。`,
  inputSchema: z.object({
    filePath: z.string().describe('要搜索的文件路径'),
    symbolName: z.string().describe('要查找的符号名称（函数名、变量名、类名等）'),
    searchProject: z.boolean().optional().default(false).describe('是否在项目中递归搜索'),
    projectRoot: z.string().optional().describe('项目根目录路径（searchProject=true 时需要）'),
  }),
  execute: async ({ filePath, symbolName, searchProject, projectRoot }): Promise<string> => {
    try {
      const { jumpToDefinition: findDef } = await import('./jump-to-definition');
      return await findDef(filePath, symbolName, searchProject, projectRoot);
    } catch (error) {
      return `跳转至定义失败: ${(error as Error).message}`;
    }
  },
});




