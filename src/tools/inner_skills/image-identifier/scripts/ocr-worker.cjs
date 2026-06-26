/**
 * OCR Worker 子进程脚本
 * 以纯 CJS 模式运行，完全隔离 tsx 的模块解析 hook。
 * 通过 stdin/stdout JSON-Lines 与父进程通信。
 *
 * 协议：
 *   父进程 → 子进程: { id, filePath, language } （每行一个 JSON）
 *   子进程 → 父进程: { id, ok: true, text, lines, words, confidence }
 *                      { id, ok: false, error }
 */
'use strict';

// 在子进程顶层捕获所有未处理错误，防止进程意外退出
process.on('uncaughtException', (err) => {
  console.error('[ocr-worker] uncaughtException:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[ocr-worker] unhandledRejection:', reason);
});

let tesseractModule = null;
async function getTesseract() {
  if (!tesseractModule) {
    tesseractModule = await import('tesseract.js');
  }
  return tesseractModule;
}

async function runOCR(filePath, language) {
  const { createWorker } = await getTesseract();
  const worker = await createWorker(language);
  try {
    const { data } = await worker.recognize(filePath);
    const text = (data.text || '').trim();
    const words = data.words || [];
    const lines = data.lines || [];
    const avgConfidence = words.length > 0
      ? (words.reduce((sum, w) => sum + (w.confidence || 0), 0) / words.length).toFixed(1)
      : 'N/A';

    await worker.terminate();
    return {
      ok: true,
      text,
      lineCount: lines.length,
      wordCount: words.length,
      confidence: avgConfidence,
    };
  } catch (err) {
    await worker.terminate();
    throw err;
  }
}

// 从 stdin 读入 JSON-Lines
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    // 非 JSON 行忽略
    return;
  }

  const { id, filePath, language } = request;
  if (!id || !filePath) return;

  try {
    const result = await runOCR(filePath, language || 'chi_sim+eng');
    process.stdout.write(JSON.stringify({ id, ...result }) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({ id, ok: false, error: err.message || String(err) }) + '\n');
  }
});

// 告诉父进程准备就绪
process.stdout.write(JSON.stringify({ type: 'ready' }) + '\n');
