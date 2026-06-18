import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'node:path';
import { match } from 'node:assert';
import { resolvePath } from '../workdir.js';
import { ToolOutput } from './tool-output';
import type { SearchBulk, SearchContentBulk } from './raw-bulk-types';

type FileEntry = {
  name: string;
  path: string;
};

async function getAllFiles(dirPath: string, recursion: boolean): Promise<FileEntry[]> {
  let results: FileEntry[] = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (recursion){
        const subFiles = await getAllFiles(fullPath, true);
        results = results.concat(subFiles);
      }else{
        results.push({
          name: "[文件夹]" + entry.name,
          path: fullPath
        });
      }
      } else {
        results.push({
          name: entry.name,
          path: fullPath
        });
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

function parseList(entryList: FileEntry[]): string {
  return JSON.stringify(entryList);
}

export const searchAllFile = tool({
  description: `搜索包括子文件夹在内的所有相关的文件。
  参数 filePath 类型string，是搜索的根文件夹路径；
  fileName 类型string，是要搜索的文件名或者正则表达式；
  useRegex 类型boolean, 为是否启用正则表达式搜索，false为关闭（使用文件名匹配），true为开启（使用正则表达式）
  返回的是一个包含文件名和路径信息的列表字符串。`,
  inputSchema: z.object({
    filePath: z.string(),
    fileName: z.string(),
    useRegex: z.boolean(),
  }),
  execute: async ({ filePath, fileName, useRegex }) => {
    try {
      const resolved = resolvePath(filePath);
      const fileList = await getAllFiles(resolved, true);
      let filterList: FileEntry[];
      if (useRegex) {
        try {
          const pattern = new RegExp(fileName);
          filterList = fileList.filter(file => match(file.name, pattern)).slice(0, 15);
        } catch (error) {
          const errMsg = `无效的正则表达式 ${(error as any).message}`;
          const bulk: SearchBulk = { type: 'search', filePath, pattern: fileName, results: [], totalCount: 0, truncated: false, error: errMsg };
          return new ToolOutput(bulk, errMsg);
        }
      } else if (fileName.includes('*')) {
        filterList = fileList.filter(file => matchesWildcard(file.name, fileName)).slice(0, 15);
      } else {
        filterList = fileList.filter(file => file.name.includes(fileName)).slice(0, 15);
      }
      const resultText = parseList(filterList);
      const bulk: SearchBulk = { type: 'search', filePath, pattern: fileName, results: filterList, totalCount: filterList.length, truncated: fileList.length > 15 };
      return new ToolOutput(bulk, resultText);
    } catch (error) {
      const errMsg = `读取文件失败: ${(error as any).message}`;
      const bulk: SearchBulk = { type: 'search', filePath, pattern: fileName, results: [], totalCount: 0, truncated: false, error: errMsg };
      return new ToolOutput(bulk, errMsg);
    }
  },
});

export const searchSubFile = tool({
  description: `仅搜索当前路径下的文件（不包含子文件夹）
  参数 filePath 类型string，是搜索的根文件夹路径；
  fileName 类型string，是要搜索的文件名或者正则表达式；
  useRegex 类型boolean, 为是否启用正则表达式搜索，false为关闭（使用文件名匹配），true为开启（使用正则表达式）
  返回的是一个包含文件名和路径信息的列表字符串。`,
  inputSchema: z.object({
    filePath: z.string(),
    fileName: z.string(),
    useRegex: z.boolean(),
  }),
  execute: async ({ filePath, fileName, useRegex }) => {
    try {
      const resolved = resolvePath(filePath);
      const fileList = await getAllFiles(resolved, false);
      let filterList: FileEntry[];
      if (useRegex) {
        try {
          const pattern = new RegExp(fileName);
          filterList = fileList.filter(file => match(file.name, pattern));
        } catch (error) {
          const errMsg = `无效的正则表达式 ${(error as any).message}`;
          const bulk: SearchBulk = { type: 'search', filePath, pattern: fileName, results: [], totalCount: 0, truncated: false, error: errMsg };
          return new ToolOutput(bulk, errMsg);
        }
      } else if (fileName.includes('*')) {
        filterList = fileList.filter(file => matchesWildcard(file.name, fileName));
      } else {
        filterList = fileList.filter(file => file.name.includes(fileName));
      }
      const resultText = parseList(filterList);
      const bulk: SearchBulk = { type: 'search', filePath, pattern: fileName, results: filterList, totalCount: filterList.length, truncated: false };
      return new ToolOutput(bulk, resultText);
    } catch (error) {
      const errMsg = `读取文件失败: ${(error as any).message}`;
      const bulk: SearchBulk = { type: 'search', filePath, pattern: fileName, results: [], totalCount: 0, truncated: false, error: errMsg };
      return new ToolOutput(bulk, errMsg);
    }
  },
});

async function getAllDirectories(dirPath: string): Promise<FileEntry[]> {
  let results: FileEntry[] = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push({ name: entry.name, path: fullPath });
      const subDirs = await getAllDirectories(fullPath);
      results = results.concat(subDirs);
    }
  }
  return results;
}

export const searchDirectory = tool({
  description: `递归搜索指定路径下的所有子文件夹。
  参数 filePath 类型string，是搜索的根文件夹路径；
  返回的是一个包含文件夹名和路径信息的列表字符串。`,
  inputSchema: z.object({
    filePath: z.string(),
  }),
  execute: async ({ filePath }) => {
    try {
      const resolved = resolvePath(filePath);
      const dirList = await getAllDirectories(resolved);
      let resultList: FileEntry[];
      if (dirList.length > 15) {
        const entries = await fs.readdir(resolved, { withFileTypes: true });
        resultList = [];
        for (const entry of entries) {
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

export const searchContent = tool({
  description: `在指定文件中搜索特定内容，返回所有匹配行及其行号。
  参数 filePath 类型string，是目标文件的路径（绝对路径或相对当前工作目录的路径）；
  content 类型string，是要搜索的内容（支持普通字符串匹配）；
  useRegex 类型boolean, 为是否启用正则表达式搜索，false为关闭（使用普通字符串包含匹配），true为开启（使用正则表达式）
  返回的是一个字符串，每行包含"行号: 行内容"的格式。`,
  inputSchema: z.object({
    filePath: z.string(),
    content: z.string(),
    useRegex: z.boolean(),
  }),
  execute: async ({ filePath, content, useRegex }) => {
    try {
      const resolved = resolvePath(filePath);
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        const errMsg = `路径 "${filePath}" 是一个目录，不是文件。请在 filePath 参数中传入文件路径。`;
        const bulk: SearchContentBulk = { type: 'search-content', filePath, pattern: content, totalCount: 0, matches: [], error: errMsg };
        return new ToolOutput(bulk, errMsg);
      }
      const fileContent = await fs.readFile(resolved, 'utf-8');
      const lines = fileContent.split('\n');
      const matches: Array<{ lineNum: number; line: string }> = [];

      if (useRegex) {
        try {
          const pattern = new RegExp(content);
          for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i])) {
              matches.push({ lineNum: i + 1, line: lines[i] });
            }
          }
        } catch (error) {
          const errMsg = `无效的正则表达式 ${(error as any).message}`;
          const bulk: SearchContentBulk = { type: 'search-content', filePath, pattern: content, totalCount: 0, matches: [], error: errMsg };
          return new ToolOutput(bulk, errMsg);
        }
      } else if (content.includes('*')) {
        for (let i = 0; i < lines.length; i++) {
          if (matchesWildcard(lines[i], content)) {
            matches.push({ lineNum: i + 1, line: lines[i] });
          }
        }
      } else {
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(content)) {
            matches.push({ lineNum: i + 1, line: lines[i] });
          }
        }
      }

      if (matches.length === 0) {
        const result = `未在文件 ${filePath} 中找到匹配内容"${content}"`;
        const bulk: SearchContentBulk = { type: 'search-content', filePath, pattern: content, totalCount: 0, matches: [] };
        return new ToolOutput(bulk, result);
      }

      const resultText = `在文件 ${filePath} 中找到 ${matches.length} 处匹配：\n` + matches.map(m => `${m.lineNum}: ${m.line}`).join('\n');
      const bulk: SearchContentBulk = { type: 'search-content', filePath, pattern: content, totalCount: matches.length, matches };
      return new ToolOutput(bulk, resultText);
    } catch (error) {
      const errMsg = `读取或搜索文件失败: ${(error as any).message}`;
      const bulk: SearchContentBulk = { type: 'search-content', filePath, pattern: content, totalCount: 0, matches: [], error: errMsg };
      return new ToolOutput(bulk, errMsg);
    }
  },
});
