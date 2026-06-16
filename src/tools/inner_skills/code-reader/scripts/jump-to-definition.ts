/**
 * jump-to-definition 工具
 * 在文件中查找某个符号（函数、变量、类等）的定义位置并输出
 */
import fs from 'fs/promises';
import path from 'path';
import { resolvePath } from '../../../../workdir.js';
import { getParserByFileType, getSupportedFileTypes } from './aux_parser/index';

// ─── 定义搜索模式 ─────────────────────────────

interface DefinitionMatch {
  symbol: string;
  type: string;       // 'function' | 'class' | 'variable' | 'method' | 'interface' | 'type' | 'component'
  line: number;
  column: number;
  matchLine: string;
  contextBefore: string[];
  contextAfter: string[];
  filePath: string;
}

/**
 * 语言无关的通用定义搜索模式
 * 按优先级排序
 */
const DEFINITION_PATTERNS: Array<{
  type: string;
  pattern: RegExp;
  group: number;     // capture group for symbol name
  lang?: string[];   // 限制语言，undefined 表示通用
}> = [
  // ── TS/JS ──
  { type: 'function', pattern: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g, group: 1 },
  { type: 'arrow',    pattern: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\(|\w+\s*=>)/g, group: 1 },
  { type: 'class',    pattern: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g, group: 1 },
  { type: 'interface',pattern: /(?:export\s+)?interface\s+(\w+)/g, group: 1 },
  { type: 'type',     pattern: /(?:export\s+)?type\s+(\w+)\s*=/g, group: 1 },
  { type: 'enum',     pattern: /(?:export\s+)?enum\s+(\w+)/g, group: 1 },
  { type: 'variable', pattern: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::|=\s*(?!function|\w+\s*=>))/g, group: 1 },
  // 类方法
  { type: 'method',   pattern: /^\s*(?:public|private|protected|static|async|get|set)*\s*(\w+)\s*\(/gm, group: 1 },

  // ── Python ──
  { type: 'function', pattern: /(?:async\s+)?def\s+(\w+)\s*\(/g, group: 1, lang: ['py'] },
  { type: 'class',    pattern: /class\s+(\w+)\s*[:\(]/g, group: 1, lang: ['py'] },
  { type: 'variable', pattern: /^(\w+)\s*=\s*(?!(?:def|class|lambda)\s)/gm, group: 1, lang: ['py'] },

  // ── C / C++ / Java ──
  { type: 'function', pattern: /(\w+(?:\s*\*\s*)?)\s+(\w+)\s*\([^)]*\)\s*(?:const\s*)?\{/g, group: 2, lang: ['c', 'h', 'cpp', 'java'] },
  { type: 'class',    pattern: /(?:class|struct)\s+(\w+)/g, group: 1, lang: ['c', 'h', 'cpp', 'java'] },

  // ── HTML 组件（自定义元素 / Web Component） ──
  { type: 'component', pattern: /<(\w[\w-]*(?:-[-\w]+)+)[^>]*>/g, group: 1, lang: ['html', 'htm'] },
  // HTML id 锚点
  { type: 'id',       pattern: /id=["'](\w+)["']/g, group: 1, lang: ['html', 'htm'] },
  // HTML template / class 定义
  { type: 'class',    pattern: /class=["']([\w\s-]+)["']/g, group: 1, lang: ['html', 'htm'] },
];

// ─── 主工具函数 ───────────────────────────────

/**
 * 在单个文件中搜索符号定义
 */
async function findDefinitionInFile(
  filePath: string,
  symbolName: string,
): Promise<DefinitionMatch | null> {
  const rawcontent = await fs.readFile(filePath, 'utf-8');
  const lines = rawcontent.split('\n');
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();

  // 1. 先用通用模式匹配
  for (const def of DEFINITION_PATTERNS) {
    if (def.lang && !def.lang.includes(ext)) continue;

    def.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = def.pattern.exec(rawcontent)) !== null) {
      const name = match[def.group];
      if (name === symbolName) {
        const pos = match.index;
        const lineNum = getLineNumber(rawcontent, pos);
        const lineContent = lines[lineNum - 1];
        const col = pos - getLineStartOffset(rawcontent, lineNum - 1) + 1;

        const contextBefore = lines.slice(Math.max(0, lineNum - 4), lineNum - 1);
        const contextAfter = lines.slice(lineNum, Math.min(lines.length, lineNum + 3));

        return {
          symbol: symbolName,
          type: def.type,
          line: lineNum,
          column: col,
          matchLine: lineContent,
          contextBefore,
          contextAfter,
          filePath,
        };
      }
    }
  }

  // 2. 用解析器尝试（针对已注册的语言）
  const parser = getParserByFileType(ext);
  if (parser) {
    parser.setContent(rawcontent, filePath);
    const funcs = parser.parseCode(rawcontent);
    const matched = funcs.find(f => f.name === symbolName);
    if (matched) {
      const lineContent = lines[matched.startLine - 1];
      return {
        symbol: symbolName,
        type: matched.type === 'method' ? 'method' : 'function',
        line: matched.startLine,
        column: lineContent.indexOf(symbolName) + 1 || 1,
        matchLine: lineContent,
        contextBefore: lines.slice(Math.max(0, matched.startLine - 4), matched.startLine - 1),
        contextAfter: lines.slice(matched.startLine, Math.min(lines.length, matched.startLine + 3)),
        filePath,
      };
    }
  }

  return null;
}

/**
 * 跨文件搜索符号定义
 */
async function findDefinitionAcrossProject(
  symbolName: string,
  startDir: string,
  maxFiles: number = 20,
): Promise<DefinitionMatch[]> {
  const results: DefinitionMatch[] = [];
  const exts = ['ts', 'js', 'tsx', 'jsx', 'py', 'c', 'cpp', 'h', 'java', 'html', 'htm'];
  let count = 0;

  async function walk(dir: string): Promise<void> {
    if (count >= maxFiles) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (count >= maxFiles) break;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== 'build') {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase();
        if (exts.includes(ext)) {
          count++;
          try {
            const result = await findDefinitionInFile(fullPath, symbolName);
            if (result) {
              results.push(result);
            }
          } catch {
            // 跳过无法读取的文件
          }
        }
      }
    }
  }

  await walk(startDir);
  return results;
}

/**
 * 获取行号（从 1 开始）
 */
function getLineNumber(content: string, position: number): number {
  let line = 1;
  for (let i = 0; i < position && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * 获取某一行起始的字符偏移
 */
function getLineStartOffset(content: string, lineIndex: number): number {
  let offset = 0;
  for (let i = 0; i < lineIndex; i++) {
    const nl = content.indexOf('\n', offset);
    if (nl === -1) break;
    offset = nl + 1;
  }
  return offset;
}

// ─── 格式化输出 ───────────────────────────────

function formatDefinitionResult(result: DefinitionMatch): string {
  const border = '─'.repeat(50);
  const typeIcon: Record<string, string> = {
    function: 'ƒ',
    method: '◈',
    class: '◆',
    variable: '□',
    interface: '◎',
    type: '▤',
    component: '⚡',
    id: '#',
    enum: '⊡',
    arrow: 'λ',
  };

  const icon = typeIcon[result.type] || '•';
  const relativePath = result.filePath;

  const contextStr = [
    ...result.contextBefore.map(l => `  │ ${l}`),
    `  → ${result.matchLine}`,
    ...result.contextAfter.map(l => `  │ ${l}`),
  ].join('\n');

  return [
    `${border}`,
    `  ${icon} 定义: ${result.symbol}  (${result.type})`,
    `  文件: ${relativePath}`,
    `  位置: 第 ${result.line} 行，第 ${result.column} 列`,
    `${border}`,
    contextStr,
    `${border}`,
  ].join('\n');
}

// ─── 导出工具 ─────────────────────────────────

export const jumpToDefinition = async (
  filePath: string,
  symbolName: string,
  searchProject?: boolean,
  projectRoot?: string,
): Promise<string> => {
  try {
    // 1. 先在指定文件中搜索
    const result = await findDefinitionInFile(resolvePath(filePath), symbolName);
    if (result) {
      return formatDefinitionResult(result);
    }

    // 2. 如果在指定文件中没找到，且允许跨文件搜索
    if (searchProject && projectRoot) {
      const results = await findDefinitionAcrossProject(symbolName, resolvePath(projectRoot), 30);
      if (results.length > 0) {
        const output = results.slice(0, 5).map(r => formatDefinitionResult(r)).join('\n');
        const summary = results.length > 5
          ? `\n... 及另外 ${results.length - 5} 个匹配`
          : '';
        return `在项目中找到 ${results.length} 处定义:\n\n${output}${summary}`;
      }
    }

    // 3. 完全没找到
    let msg = `未在文件 "${filePath}" 中找到符号 "${symbolName}" 的定义。`;
    if (!searchProject) {
      msg += '\n提示：设置 searchProject=true 并指定 projectRoot 可在整个项目中搜索。';
    }
    return msg;
  } catch (error) {
    return `查找定义失败: ${(error as Error).message}`;
  }
};


