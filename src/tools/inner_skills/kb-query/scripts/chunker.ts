/**
 * Chunker — 项目代码分块
 *
 * 策略：按文件粒度 + 函数/类粒度分层分块，同时扫描文档文件（.md）
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export interface RawChunk {
  id: string;
  content: string;
  metadata: {
    filePath: string;
    type: 'file' | 'function' | 'class' | 'doc';
    name?: string;
    startLine?: number;
    endLine?: number;
    description?: string;
  };
}

/** 需要索引的源码扩展名 */
const SOURCE_EXTS = new Set(['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs', '.css', '.html', '.json']);
/** 需要索引的文档扩展名 */
const DOC_EXTS = new Set(['.md', '.mdx', '.txt']);
/** 忽略的目录/文件 */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.seek-agent', '.todo-data',
  'dist', 'build', 'out', 'coverage', 'repos',
  'sessions', 'tokenizer', '.pnpm-store', 'electron', 'extension',
  'packages', 'test', 'ai-ide',
])
const IGNORE_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json']);

/**
 * 扫描并分块整个项目
 */
export async function chunkProject(projectRoot: string): Promise<RawChunk[]> {
  const allChunks: RawChunk[] = [];
  const files = await scanFiles(projectRoot);

  for (const filePath of files) {
    try {
      const chunks = await chunkFile(filePath, projectRoot);
      allChunks.push(...chunks);
    } catch (e: any) {
      console.warn(`⚠ 跳过 ${filePath}: ${e.message}`);
    }
  }

  return allChunks;
}

/**
 * 递归扫描项目中所有需要索引的文件
 */
async function scanFiles(dir: string, root: string = dir): Promise<string[]> {
  const result: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(root, fullPath);

    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        result.push(...(await scanFiles(fullPath, root)));
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if ((SOURCE_EXTS.has(ext) || DOC_EXTS.has(ext)) && !IGNORE_FILES.has(entry.name)) {
        result.push(fullPath);
      }
    }
  }

  return result;
}

/**
 * 对单个文件进行分块
 */
async function chunkFile(filePath: string, projectRoot: string): Promise<RawChunk[]> {
  const content = await readFile(filePath, 'utf-8');
  const relPath = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  const lines = content.split('\n');
  const ext = path.extname(filePath).toLowerCase();

  const chunks: RawChunk[] = [];

  // 1. 文件级分块（总览）
  const description = summarizeFile(content, ext);
  chunks.push({
    id: `file:${relPath}`,
    content,
    metadata: {
      filePath: relPath,
      type: 'file',
      name: path.basename(filePath),
      startLine: 1,
      endLine: lines.length,
      description,
    },
  });

  // 2. 对 TS/JS 文件进一步按函数和类分块
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) {
    chunks.push(...extractFunctions(relPath, lines));
    chunks.push(...extractClasses(relPath, lines));
  }

  return chunks;
}

/**
 * 从 TS/JS 源码中提取函数定义
 */
function extractFunctions(relPath: string, lines: string[]): RawChunk[] {
  const chunks: RawChunk[] = [];
  // 匹配函数定义：function name(...) 或 name => 或 async name(
  const funcRegex = /^(?:(?:export\s+)?(?:async\s+)?function\s+(\w+)|(\w+)\s*[=:]\s*(?:async\s+)?(?:\(|[\w\s]+\)\s*=>))/gm;

  for (const match of lines.join('\n').matchAll(funcRegex)) {
    const funcName = match[1] || match[2];
    // 找到函数体起始行
    const fullText = lines.join('\n');
    const idx = fullText.indexOf(match[0]);
    if (idx === -1) continue;

    const startLine = fullText.substring(0, idx).split('\n').length;
    // 尝试找函数结束（简单方式：匹配大括号）
    const funcContent = extractBlock(lines.slice(startLine - 1));

    const funcLines = funcContent.split('\n');
    chunks.push({
      id: `func:${relPath}::${funcName}`,
      content: funcContent,
      metadata: {
        filePath: relPath,
        type: 'function',
        name: funcName,
        startLine,
        endLine: startLine + funcLines.length - 1,
        description: `函数 ${funcName}，位于 ${relPath}:${startLine}`,
      },
    });
  }

  return chunks;
}

/**
 * 从 TS/JS 源码中提取类定义
 */
function extractClasses(relPath: string, lines: string[]): RawChunk[] {
  const chunks: RawChunk[] = [];
  const classRegex = /^(?:(?:export\s+)?(?:abstract\s+)?class\s+(\w+))/gm;
  const fullText = lines.join('\n');

  for (const match of fullText.matchAll(classRegex)) {
    const className = match[1];
    const idx = fullText.indexOf(match[0]);
    if (idx === -1) continue;

    const startLine = fullText.substring(0, idx).split('\n').length;
    const classContent = extractBlock(lines.slice(startLine - 1));

    const classLines = classContent.split('\n');
    chunks.push({
      id: `class:${relPath}::${className}`,
      content: classContent,
      metadata: {
        filePath: relPath,
        type: 'class',
        name: className,
        startLine,
        endLine: startLine + classLines.length - 1,
        description: `类 ${className}，位于 ${relPath}:${startLine}`,
      },
    });
  }

  return chunks;
}

/**
 * 简单的大括号匹配提取块内容
 */
function extractBlock(lines: string[]): string {
  let braceCount = 0;
  let started = false;
  const result: string[] = [];

  for (const line of lines) {
    result.push(line);
    for (const ch of line) {
      if (ch === '{') { braceCount++; started = true; }
      if (ch === '}') { braceCount--; }
    }
    if (started && braceCount === 0) break;
  }

  return result.join('\n');
}

/**
 * 对文件内容生成简短摘要描述
 */
function summarizeFile(content: string, ext: string): string {
  const lines = content.split('\n').filter(l => l.trim());
  const imports = lines.filter(l => /^(import|const|let|var|function|class|export|interface|type)/.test(l.trim()));

  if (imports.length > 0) {
    const summary = imports.slice(0, 5).map(l => l.trim()).join('; ');
    return summary.length > 200 ? summary.slice(0, 200) + '...' : summary;
  }

  return lines.slice(0, 3).join('; ').slice(0, 200);
}

