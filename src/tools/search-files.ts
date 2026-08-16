import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'node:path';
import { resolvePath } from '../workdir.js';
import { ToolOutput } from './tool-output';
import type { SearchBulk, SearchContentBulk } from './raw-bulk-types';

type FileEntry = {
  name: string;
  path: string;
  /** 非递归模式下目录条目标记 */
  isDir?: boolean;
};

/** 递归遍历时默认跳过的依赖 / 版本库 / 构建产物目录 */
const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn',
  'dist', 'build', 'out', '.next', '.nuxt', '.output',
  '.cache', 'coverage', '.venv', 'venv', '__pycache__',
  '.idea', '.vscode', '.turbo', '.yarn',
  'sessions', 'release', 'repos',
]);

async function collectEntries(
  dirPath: string,
  opts: { recursion: boolean; ignoreDirs: Set<string> },
): Promise<FileEntry[]> {
  const results: FileEntry[] = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (opts.ignoreDirs.has(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (opts.recursion) {
        const sub = await collectEntries(fullPath, opts);
        results.push(...sub);
      } else {
        results.push({ name: entry.name, path: fullPath, isDir: true });
      }
    } else {
      results.push({ name: entry.name, path: fullPath });
    }
  }
  return results;
}

async function collectDirectories(dirPath: string, ignoreDirs: Set<string>): Promise<FileEntry[]> {
  const results: FileEntry[] = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (ignoreDirs.has(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push({ name: entry.name, path: fullPath });
      const sub = await collectDirectories(fullPath, ignoreDirs);
      results.push(...sub);
    }
  }
  return results;
}

function matchesWildcard(name: string, pattern: string): boolean {
  const regexStr = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*') + '$';
  return new RegExp(regexStr, 'i').test(name);
}

/** 编译用户正则；去掉 g 标志，避免 pattern.test() 的 lastIndex 状态陷阱 */
function compilePattern(src: string): RegExp {
  const p = new RegExp(src);
  return p.global ? new RegExp(p.source, p.flags.replace('g', '')) : p;
}

/** 相对搜索根的路径（统一正斜杠），用于按路径片段匹配 */
function toRelPath(fullPath: string, root: string): string {
  return path.relative(root, fullPath).split(path.sep).join('/');
}

/**
 * 统一匹配：文件名或相对路径，任一命中即算匹配。
 * 普通关键词大小写不敏感；正则尊重用户标志。
 */
function entryMatches(
  entry: FileEntry,
  relPath: string,
  fileName: string,
  useRegex: boolean,
  compiled?: RegExp,
): boolean {
  if (useRegex) {
    const pattern = compiled ?? compilePattern(fileName);
    return pattern.test(entry.name) || pattern.test(relPath);
  }
  if (fileName.includes('*')) {
    return matchesWildcard(entry.name, fileName) || matchesWildcard(relPath, fileName);
  }
  const kw = fileName.toLowerCase();
  return entry.name.toLowerCase().includes(kw) || relPath.toLowerCase().includes(kw);
}

function lineMatches(line: string, content: string, useRegex: boolean, compiled?: RegExp): boolean {
  if (useRegex) {
    const pattern = compiled ?? compilePattern(content);
    return pattern.test(line);
  }
  if (content.includes('*')) {
    return matchesWildcard(line, content);
  }
  return line.toLowerCase().includes(content.toLowerCase());
}

/** 匹配行截断上下文长度：匹配点前/后各保留的字符数 */
const MATCH_CONTEXT = 200;

/**
 * 匹配行过长时截断到匹配点前/后各 200 字符（带省略号），避免超长行撑爆输出。
 * 匹配点：正则取第一个匹配的起始下标；普通关键词取包含匹配的起始下标；
 * 通配符模式无法精确定位时回退到行首。
 */
function truncateMatchLine(
  line: string,
  content: string,
  useRegex: boolean,
  compiled?: RegExp,
): string {
  if (line.length <= MATCH_CONTEXT * 2 + 1) return line;
  let idx = 0;
  if (useRegex) {
    const pattern = compiled ?? compilePattern(content);
    idx = pattern.exec(line)?.index ?? 0;
  } else {
    const found = line.toLowerCase().indexOf(content.toLowerCase());
    if (found >= 0) idx = found;
  }
  const start = Math.max(0, idx - MATCH_CONTEXT);
  const end = Math.min(line.length, idx + MATCH_CONTEXT);
  return (start > 0 ? '…' : '') + line.slice(start, end) + (end < line.length ? '…' : '');
}

/** 读取文本文件；若头部含 NUL 字节视为二进制，返回 null */
async function readTextIfNotBinary(filePath: string): Promise<string | null> {
  const fd = await fs.open(filePath, 'r');
  try {
    const head = Buffer.alloc(8192);
    const { bytesRead } = await fd.read(head, 0, 8192, 0);
    if (head.subarray(0, bytesRead).includes(0)) return null;
  } finally {
    await fd.close();
  }
  return fs.readFile(filePath, 'utf-8');
}

function parseList(entryList: FileEntry[]): string {
  return JSON.stringify(entryList);
}

const searchSchema = z.object({
  filePath: z.string(),
  fileName: z.string(),
  useRegex: z.boolean(),
  maxResults: z.number().int().positive().optional(),
});

export const searchAllFile = tool({
  description: `递归搜索根目录下所有子文件夹中的文件（自动跳过 node_modules/.git 等依赖与版本库目录）。
  参数 filePath 类型string，是搜索的根文件夹路径；
  fileName 类型string，是要搜索的文件名或路径片段（如 "search.ts" 或 "src/tools"）；
  useRegex 类型boolean，为是否启用正则表达式搜索，false 为关闭（文件名/路径包含匹配，大小写不敏感；含 * 时按通配符匹配），true 为开启（匹配文件名或相对路径）；
  maxResults 类型number，可选，最多返回条数（默认 15）。
  返回的是一个包含文件名和路径信息的列表字符串。`,
  inputSchema: searchSchema,
  execute: async ({ filePath, fileName, useRegex, maxResults = 15 }) => {
    try {
      const resolved = resolvePath(filePath);
      const fileList = await collectEntries(resolved, { recursion: true, ignoreDirs: DEFAULT_IGNORE_DIRS });
      let compiled: RegExp | undefined;
      if (useRegex) {
        try {
          compiled = compilePattern(fileName);
        } catch (error) {
          const errMsg = `无效的正则表达式 ${(error as any).message}`;
          const bulk: SearchBulk = { type: 'search', filePath, pattern: fileName, results: [], totalCount: 0, truncated: false, error: errMsg };
          return new ToolOutput(bulk, errMsg);
        }
      }
      const allMatches = fileList.filter(f => entryMatches(f, toRelPath(f.path, resolved), fileName, useRegex, compiled));
      const filterList = allMatches.slice(0, maxResults);
      const resultText = parseList(filterList);
      const bulk: SearchBulk = { type: 'search', filePath, pattern: fileName, results: filterList, totalCount: allMatches.length, truncated: allMatches.length > maxResults };
      return new ToolOutput(bulk, resultText);
    } catch (error) {
      const errMsg = `读取文件失败: ${(error as any).message}`;
      const bulk: SearchBulk = { type: 'search', filePath, pattern: fileName, results: [], totalCount: 0, truncated: false, error: errMsg };
      return new ToolOutput(bulk, errMsg);
    }
  },
});

export const searchSubFile = tool({
  description: `仅搜索当前路径下的文件（不包含子文件夹；目录条目会以 isDir 标记，自动跳过 node_modules/.git 等依赖目录）。
  参数 filePath 类型string，是搜索的根文件夹路径；
  fileName 类型string，是要搜索的文件名（大小写不敏感；含 * 时按通配符匹配）；
  useRegex 类型boolean，为是否启用正则表达式搜索；
  maxResults 类型number，可选，最多返回条数（默认 15）。
  返回的是一个包含文件名和路径信息的列表字符串。`,
  inputSchema: searchSchema,
  execute: async ({ filePath, fileName, useRegex, maxResults = 15 }) => {
    try {
      const resolved = resolvePath(filePath);
      const fileList = await collectEntries(resolved, { recursion: false, ignoreDirs: DEFAULT_IGNORE_DIRS });
      let compiled: RegExp | undefined;
      if (useRegex) {
        try {
          compiled = compilePattern(fileName);
        } catch (error) {
          const errMsg = `无效的正则表达式 ${(error as any).message}`;
          const bulk: SearchBulk = { type: 'search', filePath, pattern: fileName, results: [], totalCount: 0, truncated: false, error: errMsg };
          return new ToolOutput(bulk, errMsg);
        }
      }
      const allMatches = fileList.filter(f => entryMatches(f, toRelPath(f.path, resolved), fileName, useRegex, compiled));
      const filterList = allMatches.slice(0, maxResults);
      const resultText = parseList(filterList);
      const bulk: SearchBulk = { type: 'search', filePath, pattern: fileName, results: filterList, totalCount: allMatches.length, truncated: allMatches.length > maxResults };
      return new ToolOutput(bulk, resultText);
    } catch (error) {
      const errMsg = `读取文件失败: ${(error as any).message}`;
      const bulk: SearchBulk = { type: 'search', filePath, pattern: fileName, results: [], totalCount: 0, truncated: false, error: errMsg };
      return new ToolOutput(bulk, errMsg);
    }
  },
});

export const searchDirectory = tool({
  description: `递归搜索指定路径下的所有子文件夹（自动跳过 node_modules/.git 等依赖与版本库目录）。
  参数 filePath 类型string，是搜索的根文件夹路径；
  返回的是一个包含文件夹名和路径信息的列表字符串。`,
  inputSchema: z.object({
    filePath: z.string(),
  }),
  execute: async ({ filePath }) => {
    try {
      const resolved = resolvePath(filePath);
      const dirList = await collectDirectories(resolved, DEFAULT_IGNORE_DIRS);
      let resultList: FileEntry[];
      if (dirList.length > 15) {
        const entries = await fs.readdir(resolved, { withFileTypes: true });
        resultList = [];
        for (const entry of entries) {
          if (DEFAULT_IGNORE_DIRS.has(entry.name)) continue;
          if (entry.isDirectory()) {
            resultList.push({
              name: entry.name,
              path: path.join(resolved, entry.name),
            });
          }
        }
      } else {
        resultList = dirList;
      }
      const resultText = parseList(resultList);
      const bulk: SearchBulk = { type: 'search', filePath, pattern: 'directory', results: resultList, totalCount: dirList.length, truncated: dirList.length > 15 };
      return new ToolOutput(bulk, resultText);
    } catch (error) {
      const errMsg = `读取文件夹失败: ${(error as any).message}`;
      const bulk: SearchBulk = { type: 'search', filePath, pattern: 'directory', results: [], totalCount: 0, truncated: false, error: errMsg };
      return new ToolOutput(bulk, errMsg);
    }
  },
});

const searchContentSchema = z.object({
  filePath: z.string(),
  content: z.string(),
  useRegex: z.boolean(),
  maxResults: z.number().int().positive().optional(),
});

export const searchContent = tool({
  description: `在指定文件或目录中搜索特定内容，返回所有匹配行及其行号。
  参数 filePath 类型string，是目标路径（文件或目录；目录时递归搜索其下所有文本文件，自动跳过 node_modules/.git 等依赖目录与二进制文件）；
  content 类型string，是要搜索的内容（普通字符串包含匹配，大小写不敏感；含 * 时按通配符匹配；useRegex 为 true 时按正则匹配）；
  useRegex 类型boolean，为是否启用正则表达式搜索；
  maxResults 类型number，可选，最多返回的匹配行数（默认 200；目录搜索时每个文件最多返回 50 行）。
  返回格式：单文件为 "行号: 行内容"；多文件为 "文件路径:行号: 行内容"。`,
  inputSchema: searchContentSchema,
  execute: async ({ filePath, content, useRegex, maxResults = 200 }) => {
    const MAX_LINES_PER_FILE = 50;
    try {
      const resolved = resolvePath(filePath);
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) {
        const entries = await collectEntries(resolved, { recursion: true, ignoreDirs: DEFAULT_IGNORE_DIRS });
        const targetFiles = entries.filter(e => !e.isDir).map(e => e.path);
        if (targetFiles.length === 0) {
          const bulk: SearchContentBulk = { type: 'search-content', filePath, pattern: content, totalCount: 0, matches: [], truncated: false };
          return new ToolOutput(bulk, `目录 ${filePath} 中没有可搜索的文本文件`);
        }
        const matches: Array<{ lineNum: number; line: string; filePath: string }> = [];
        let truncated = false;
        let compiled: RegExp | undefined;
        if (useRegex) {
          try {
            compiled = compilePattern(content);
          } catch (error) {
            const errMsg = `无效的正则表达式 ${(error as any).message}`;
            const bulk: SearchContentBulk = { type: 'search-content', filePath, pattern: content, totalCount: 0, matches: [], truncated: false, error: errMsg };
            return new ToolOutput(bulk, errMsg);
          }
        }
        for (const f of targetFiles) {
          const text = await readTextIfNotBinary(f).catch(() => null);
          if (text === null) continue;
          const lines = text.split('\n');
          let fileHits = 0;
          for (let i = 0; i < lines.length; i++) {
            if (lineMatches(lines[i], content, useRegex, compiled)) {
              matches.push({ lineNum: i + 1, line: truncateMatchLine(lines[i], content, useRegex, compiled), filePath: f });
              fileHits++;
              if (fileHits >= MAX_LINES_PER_FILE || matches.length >= maxResults) {
                truncated = true;
                break;
              }
            }
          }
          if (matches.length >= maxResults) break;
        }
        if (matches.length === 0) {
          const result = `未在目录 ${filePath} 中找到匹配内容"${content}"`;
          const bulk: SearchContentBulk = { type: 'search-content', filePath, pattern: content, totalCount: 0, matches: [], truncated: false };
          return new ToolOutput(bulk, result);
        }
        const shown = matches.length;
        const resultText = `在目录 ${filePath} 中搜索"${content}"，返回 ${shown} 处匹配${truncated ? '（已截断）' : ''}：\n` +
          matches.map(m => `${m.filePath}:${m.lineNum}: ${m.line}`).join('\n');
        const bulk: SearchContentBulk = { type: 'search-content', filePath, pattern: content, totalCount: shown, matches, truncated };
        return new ToolOutput(bulk, resultText);
      }

      // ── 单文件搜索（保持原格式） ──
      const fileContent = await fs.readFile(resolved, 'utf-8');
      const lines = fileContent.split('\n');
      const matches: Array<{ lineNum: number; line: string }> = [];
      let truncated = false;

      if (useRegex) {
        try {
          const pattern = compilePattern(content);
          for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i])) {
              matches.push({ lineNum: i + 1, line: truncateMatchLine(lines[i], content, true, pattern) });
              if (matches.length >= maxResults) { truncated = true; break; }
            }
          }
        } catch (error) {
          const errMsg = `无效的正则表达式 ${(error as any).message}`;
          const bulk: SearchContentBulk = { type: 'search-content', filePath, pattern: content, totalCount: 0, matches: [], truncated: false, error: errMsg };
          return new ToolOutput(bulk, errMsg);
        }
      } else {
        for (let i = 0; i < lines.length; i++) {
          if (lineMatches(lines[i], content, false)) {
            matches.push({ lineNum: i + 1, line: truncateMatchLine(lines[i], content, false) });
            if (matches.length >= maxResults) { truncated = true; break; }
          }
        }
      }

      if (matches.length === 0) {
        const result = `未在文件 ${filePath} 中找到匹配内容"${content}"`;
        const bulk: SearchContentBulk = { type: 'search-content', filePath, pattern: content, totalCount: 0, matches: [], truncated: false };
        return new ToolOutput(bulk, result);
      }

      const resultText = `在文件 ${filePath} 中找到 ${matches.length} 处匹配${truncated ? '（已截断）' : ''}：\n` + matches.map(m => `${m.lineNum}: ${m.line}`).join('\n');
      const bulk: SearchContentBulk = { type: 'search-content', filePath, pattern: content, totalCount: matches.length, matches, truncated };
      return new ToolOutput(bulk, resultText);
    } catch (error) {
      const errMsg = `读取或搜索文件失败: ${(error as any).message}`;
      const bulk: SearchContentBulk = { type: 'search-content', filePath, pattern: content, totalCount: 0, matches: [], truncated: false, error: errMsg };
      return new ToolOutput(bulk, errMsg);
    }
  },
});




