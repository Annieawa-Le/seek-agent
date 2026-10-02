/**
 * kb_build_index — 构建/重建项目知识库索引（增量感知）
 *
 * 流程:
 *   force=true  → 清空全部，全量重建
 *   force=false → 用 FileTracker 对比 mtime+size，只处理变更的文件
 *
 * 增量流程：
 *   1. 扫描文件系统，获取所有文件列表
 *   2. 与 FileTracker 历史状态对比，分出 added/modified/deleted
 *   3. 删除文件中已删除的块
 *   4. 对有变动的文件重新分块 + 嵌入 + 写入
 *   5. 更新 FileTracker 状态
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getStore, resetStore } from './store/factory';
import { type RawChunk } from './chunker';
import { embedder } from './embedder';
import { FileTracker } from './file-tracker';
import { getWorkspaceRoot } from '../../../../../src/workdir';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'node:url';

export const kbBuildIndex = tool({
  description: `构建/重建项目知识库索引。扫描整个项目的源码和文档文件，进行向量化处理并存入存储后端。`,
  inputSchema: z.object({
    force: z.boolean().default(false).describe('是否强制重建（清空已有索引后重新构建）'),
  }),
  execute: async ({ force }): Promise<string> => {
    const startTime = Date.now();
    const projectRoot = getWorkspaceRoot();

    // ── 0. 探测维度 ──
    process.stdout.write('📐 探测嵌入模型维度...\n');
    let dim: number;
    try {
      dim = await embedder.getDim();
    } catch (e: any) {
      return `❌ 无法连接到 embedding API (${embedder.model})：${e.message}\n请检查 .env 中 EMBEDDING_BASE_URL 和 EMBEDDING_API_KEY 是否正确配置。`;
    }
    process.stdout.write(`   → 模型维度: ${dim}\n`);

    // ── 1. 初始化存储 ──
    let store = await getStore(dim);

    if (force) {
      await store.clear();
      resetStore();
      store = await getStore(dim);
    }

    // ── 2. 扫描文件并检测变更 ──
    const tracker = new FileTracker();
    const currentFiles = await collectFiles(projectRoot);
    const changes = force
      ? { added: currentFiles, modified: [], deleted: [], unchanged: [] }
      : await tracker.getChanges(currentFiles);

    process.stdout.write(`📊 文件变更: +${changes.added.length} ~${changes.modified.length} -${changes.deleted.length} =${changes.unchanged.length}\n`);

    // 无变更时快速跳过
    if (changes.added.length === 0 && changes.modified.length === 0 && changes.deleted.length === 0 && !force) {
      const stats = await store.stats();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      return [
        `✅ 知识库已是最新，无需更新`,
        `  总块数: ${stats.totalChunks}  源文件: ${stats.files.length}`,
        `  耗时: ${elapsed}s`,
      ].join('\n');
    }

    // ── 3. 处理删除的文件 ──
    if (changes.deleted.length > 0) {
      process.stdout.write(`🗑️  删除 ${changes.deleted.length} 个已移除文件中的块...\n`);
      let deletedCount = 0;
      for (const file of changes.deleted) {
        const relPath = path.relative(projectRoot, file).replace(/\\/g, '/');
        const n = await store.delete({ filePath: relPath });
        deletedCount += n;
      }
      process.stdout.write(`   → 删除了 ${deletedCount} 个块\n`);
      tracker.removeRecords(changes.deleted);
    }

    // ── 4. 处理新增/修改的文件 ──
    const changedFiles = [...changes.added, ...changes.modified];
    if (changedFiles.length > 0) {
      process.stdout.write(`📦 扫描 ${changedFiles.length} 个变更文件...\n`);

      // 先删除旧数据（修改的文件需要重新索引）
      for (const file of changes.modified) {
        const relPath = path.relative(projectRoot, file).replace(/\\/g, '/');
        await store.delete({ filePath: relPath });
      }

      const rawChunks: RawChunk[] = [];
      for (const file of changedFiles) {
        try {
          const chunks = await chunkFileByPath(file, projectRoot);
          rawChunks.push(...chunks);
        } catch (e: any) {
          process.stdout.write(`  ⚠ 跳过 ${file}: ${e.message}\n`);
        }
      }

      process.stdout.write(`   → 提取了 ${rawChunks.length} 个块\n`);

      // 5. 过滤空块
      const filtered: { chunk: RawChunk; text: string }[] = [];
      for (const rc of rawChunks) {
        const text = (rc.content || '').trim();
        if (text.length > 0) {
          filtered.push({ chunk: rc, text: text.slice(0, 8000) });
        }
      }
      process.stdout.write(`   → 过滤后 ${filtered.length} 个有效块\n`);

      if (filtered.length > 0) {
        // 6. 批量嵌入
        process.stdout.write('🧠 生成向量嵌入...\n');
        const texts = filtered.map(f => f.text);
        const embeddings = await embedder.embedBatch(texts);

        // 7. 写入存储
        process.stdout.write('💾 写入向量存储...\n');
        const chunks = filtered.map((f, i) => ({
          id: f.chunk.id,
          content: f.chunk.content,
          embedding: embeddings[i],
          metadata: f.chunk.metadata,
        }));
        await store.insertBatch(chunks);
      }

      // 更新文件追踪状态
      await tracker.updateRecords(changedFiles);
    }

    // ── 8. 持久化文件状态 ──
    await tracker.save();

    // ── 9. 统计 ──
    const stats = await store.stats();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    return [
      `✅ 知识库增量构建完成！`,
      ``,
      `存储后端: ${stats.storeType}`,
      `嵌入模型: ${embedder.model}`,
      `向量维度: ${stats.embeddingDim}`,
      `总块数:   ${stats.totalChunks}`,
      `源文件数: ${stats.files.length}`,
      `新增文件: ${changes.added.length}`,
      `修改文件: ${changes.modified.length}`,
      `删除文件: ${changes.deleted.length}`,
      `耗时:     ${elapsed}s`,
      `最后更新: ${stats.lastUpdated}`,
    ].join('\n');
  },
});

/** 递归扫描项目文件（与 chunker.scanFiles 逻辑一致） */
const SOURCE_EXTS = new Set(['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs', '.css', '.html', '.json']);
const DOC_EXTS = new Set(['.md', '.mdx', '.txt', '.pdf', '.docx', '.pptx']);
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.seek-agent', '.todo-data',
  'dist', 'build', 'out', 'coverage', 'repos',
  'sessions', 'tokenizer', '.pnpm-store', 'electron', 'extension',
  'packages', 'test', 'ai-ide',
]);

/** 单次索引允许扫描的文件数上限：防止工作区指向盘根/系统目录时把整块盘拉进内存 */
const MAX_SCAN_FILES = (() => {
  const v = Number(process.env.KB_MAX_FILES);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 20000;
})();

/** 待扫描文件数超上限时抛出，交由上层显式中止索引 */
class ScanLimitExceededError extends Error {
  constructor(limit: number) {
    super(`待索引文件数超过上限 ${limit}（当前工作区疑似为磁盘根目录或包含大量系统文件），已中止索引以避免内存溢出。请缩小工作区范围，或设置环境变量 KB_MAX_FILES 调整上限。`);
    this.name = 'ScanLimitExceededError';
  }
}

async function collectFiles(dir: string, acc: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await import('node:fs/promises').then(fs => fs.readdir(dir, { withFileTypes: true }));
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (acc.length > MAX_SCAN_FILES) throw new ScanLimitExceededError(MAX_SCAN_FILES);
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        await collectFiles(fullPath, acc);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SOURCE_EXTS.has(ext) || DOC_EXTS.has(ext)) {
        acc.push(fullPath);
      }
    }
  }
  return acc;
}

/** 对单个文件分块（复用 chunker 的逻辑但只处理一个文件）
    支持 PDF、纯文本等多种格式。UTF-16/GBK 文件自动检测编码。 */
async function chunkFileByPath(filePath: string, projectRoot: string): Promise<RawChunk[]> {
  const ext = path.extname(filePath).toLowerCase();
  let content: string;

  if (ext === '.pdf') {
    // PDF：用 pdf-parse 提取文本
    try {
      const { readFile } = await import('node:fs/promises');
      const pdfBuffer = await readFile(filePath);
      const { PDFParse, VerbosityLevel } = await import('pdf-parse');
      const parser = new PDFParse({ data: pdfBuffer, verbosity: VerbosityLevel.ERRORS });
      const textResult = await parser.getText();
      content = textResult.text || '';
      await parser.destroy();
    } catch (e: any) {
      throw new Error('PDF 解析失败: ' + e.message);
    }
  } else if (ext === '.docx' || ext === '.pptx') {
    // Office 文档：用 Python stdlib (zipfile + XML) 提取文本
    try {
      content = await extractOfficeText(filePath);
    } catch (e: any) {
      throw new Error('Office 解析失败: ' + e.message);
    }
  } else {
    // 常规文本文件：尝试 utf-8，失败后尝试其他编码
    try {
      const { readFile } = await import('node:fs/promises');
      content = await readFile(filePath, 'utf-8');
    } catch (e: any) {
      // 如果 utf-8 失败，尝试作为二进制读取后用 iconv-lite 解码
      try {
        const { readFile } = await import('node:fs/promises');
        const buf = await readFile(filePath);
        const iconv = await import('iconv-lite');
        content = iconv.decode(buf, 'utf-8');
        // 如果解码后仍然包含大量非文本字符，标记为不可索引
        const printableRatio = content.split('').filter(c => c >= ' ' || c === '\n' || c === '\r' || c === '\t').length / content.length;
        if (printableRatio < 0.7) {
          throw new Error('二进制文件，跳过');
        }
      } catch {
        throw new Error('无法读取文件内容（可能为二进制文件）');
      }
    }
  }

  const relPath = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  const lines = content.split('\n');

  const chunks: RawChunk[] = [];

  // 文件级分块
  chunks.push({
    id: `file:${relPath}`,
    content,
    metadata: {
      filePath: relPath,
      type: 'file',
      name: path.basename(filePath),
      startLine: 1,
      endLine: lines.length,
      description: lines.slice(0, 3).join('; ').slice(0, 200),
    },
  });

  // 函数/类级分块
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) {
    const funcRegex = /^(?:(?:export\s+)?(?:async\s+)?function\s+(\w+)|(\w+)\s*[=:]\s*(?:async\s+)?(?:\(|[\w\s]+\)\s*=>))/gm;
    for (const match of content.matchAll(funcRegex)) {
      const funcName = match[1] || match[2];
      const idx = content.indexOf(match[0]);
      if (idx === -1) continue;
      const startLine = content.substring(0, idx).split('\n').length;
      const funcContent = extractBlock(lines.slice(startLine - 1));
      const funcLines = funcContent.split('\n');
      if (funcContent.trim()) {
        chunks.push({
          id: `func:${relPath}::${funcName}`,
          content: funcContent,
          metadata: { filePath: relPath, type: 'function', name: funcName, startLine, endLine: startLine + funcLines.length - 1, description: `函数 ${funcName}，位于 ${relPath}:${startLine}` },
        });
      }
    }

    const classRegex = /^(?:(?:export\s+)?(?:abstract\s+)?class\s+(\w+))/gm;
    for (const match of content.matchAll(classRegex)) {
      const className = match[1];
      const idx = content.indexOf(match[0]);
      if (idx === -1) continue;
      const startLine = content.substring(0, idx).split('\n').length;
      const classContent = extractBlock(lines.slice(startLine - 1));
      const classLines = classContent.split('\n');
      if (classContent.trim()) {
        chunks.push({
          id: `class:${relPath}::${className}`,
          content: classContent,
          metadata: { filePath: relPath, type: 'class', name: className, startLine, endLine: startLine + classLines.length - 1, description: `类 ${className}，位于 ${relPath}:${startLine}` },
        });
      }
    }
  }

  return chunks;
}

/** 大括号匹配提取块 */
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




const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFilePromise = promisify(execFile);

/**
 * 使用 Python stdlib 提取 Office 文档（.docx/.pptx）中的纯文本。
 * 零额外依赖，仅用 zipfile + xml.etree.ElementTree。
 */
async function extractOfficeText(filePath: string): Promise<string> {
  const scriptPath = path.join(__dirname, 'extract_office_text.py');
  const { stdout } = await execFilePromise('python', [scriptPath, filePath], {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  if (result.error) throw new Error(result.error);
  return result.text || '';
}




