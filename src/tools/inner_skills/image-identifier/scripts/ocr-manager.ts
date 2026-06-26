/**
 * OCR 子进程管理器
 *
 * 维护一个常驻的 CJS 子进程来执行 tesseract.js OCR，
 * 解决 tsx 环境下 tesseract.js 的 worker_threads 因模块解析 hook 崩溃的问题。
 *
 * 通信方式：JSON-Lines over stdin/stdout
 */

import { ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface OCRRequest {
  id: string;
  filePath: string;
  language: string;
}

interface OCRSuccessResult {
  ok: true;
  text: string;
  lineCount: number;
  wordCount: number;
  confidence: string;
}

interface OCRErrorResult {
  ok: false;
  error: string;
}

type OCRResult = OCRSuccessResult | OCRErrorResult;

interface PendingRequest {
  resolve: (result: OCRResult) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

class OCRManager {
  private process: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private rl: ReturnType<typeof createInterface> | null = null;
  private workerPath: string;
  private ready = false;
  private spawnLock = false;
  private requestCounter = 0;
  private static instance: OCRManager;

  static getInstance(): OCRManager {
    if (!OCRManager.instance) {
      OCRManager.instance = new OCRManager();
    }
    return OCRManager.instance;
  }

  private constructor() {
    // worker 脚本路径
    this.workerPath = path.resolve(
      __dirname,
      'ocr-worker.cjs',
    );
  }

  private async ensureProcess(): Promise<void> {
    if (this.process && this.ready) return;
    if (this.spawnLock) {
      // 等一会儿再试
      await new Promise<void>((resolve) => {
        const check = () => {
          if (this.ready) return resolve();
          setTimeout(check, 100);
        };
        check();
      });
      return;
    }

    this.spawnLock = true;

    // 清理旧进程
    this.killProcess();

    return new Promise<void>((resolve, reject) => {
      const proc = spawn(process.execPath, [this.workerPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // 不要继承 tsx 环境
        env: {
          ...process.env,
          // 关键：确保 NODE_OPTIONS 不包含 tsx loader
          NODE_OPTIONS: '',
          // 确保没有 tsx 注册
          TSX_TSCONFIG_PATH: undefined,
        },
      });

      proc.on('error', (err) => {
        this.ready = false;
        this.spawnLock = false;
        reject(err);
      });

      proc.on('exit', (code) => {
        this.ready = false;
        this.process = null;
        // 如果有待处理的请求，全部 reject
        if (this.pending.size > 0) {
          for (const [, pending] of this.pending) {
            clearTimeout(pending.timeout);
            pending.reject(new Error(`OCR worker exited with code ${code}`));
          }
          this.pending.clear();
        }
      });

      // stderr 直接输出到父进程 stderr
      proc.stderr?.pipe(process.stderr);

      const rl = createInterface({ input: proc.stdout! });
      rl.on('line', (line: string) => {
        let data: any;
        try {
          data = JSON.parse(line);
        } catch {
          return;
        }

        // 就绪信号
        if (data.type === 'ready') {
          this.ready = true;
          this.spawnLock = false;
          this.process = proc;
          this.rl = rl;
          resolve();
          return;
        }

        // OCR 结果
        const { id } = data;
        if (id && this.pending.has(id)) {
          const pending = this.pending.get(id)!;
          clearTimeout(pending.timeout);
          this.pending.delete(id);

          if (data.ok) {
            pending.resolve(data as OCRSuccessResult);
          } else {
            pending.resolve(data as OCRErrorResult);
          }
        }
      });

      this.process = proc;
      // 如果进程退出了，ready 状态会被上面 exit 事件处理
    });
  }

  private killProcess(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // 忽略
      }
      this.process = null;
    }
    this.ready = false;
  }

  /**
   * 执行 OCR 识别
   */
  async recognize(filePath: string, language: string = 'chi_sim+eng'): Promise<OCRResult> {
    await this.ensureProcess();

    const id = `ocr_${++this.requestCounter}`;

    return new Promise<OCRResult>((resolve, reject) => {
      // 60 秒超时
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        // 超时时 kill 并重启 worker
        this.killProcess();
        reject(new Error('OCR 识别超时 (60s)'));
      }, 60000);

      this.pending.set(id, { resolve, reject, timeout });

      // 发送请求
      const request: OCRRequest = { id, filePath, language };
      this.process!.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  /**
   * 关闭 OCR 子进程
   */
  shutdown(): void {
    this.killProcess();
  }

  /**
   * 重启 OCR 子进程
   */
  restart(): void {
    this.killProcess();
  }
}

export const ocrManager = OCRManager.getInstance();

