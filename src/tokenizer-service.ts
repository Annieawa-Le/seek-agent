/**
 * tokenizer-service.ts — 与 Python tokenizer 后台进程通信
 *
 * 启动一个长驻的 Python 进程，通过 stdin/stdout JSON 行协议
 * 获取消息列表的真实 token 数。
 */

import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const SERVICE_SCRIPT = path.join(ROOT, 'tokenizer', 'tokenizer_service.py');

interface TokenizerResponse {
  tokens: number;
  error: string | null;
}

export class TokenizerService {
  private proc: ChildProcess | null = null;
  private pendingResolve: ((v: number) => void) | null = null;
  private pendingReject: ((e: Error) => void) | null = null;
  private buffer = '';

  async start(): Promise<void> {
    if (this.proc) return;

    return new Promise<void>((resolve, reject) => {
      const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
      const child = spawn(pythonCmd, ['-u', SERVICE_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.proc = child;

      child.stdout?.on('data', (data: Buffer) => {
        this.buffer += data.toString('utf-8');
        this.tryResolvePending();
      });

      child.on('error', (err: Error) => {
        console.error(`[tokenizer] process error: ${err.message}`);
        this.proc = null;
        reject(err);
      });

      child.on('exit', (code: number | null) => {
        if (this.pendingReject) {
          this.pendingReject(new Error(`tokenizer exited with code ${code}`));
        }
        this.proc = null;
      });

      // Give it a moment to start
      setTimeout(() => resolve(), 500);
    });
  }

  private tryResolvePending(): void {
    if (!this.pendingResolve) return;

    const nlIdx = this.buffer.indexOf('\n');
    if (nlIdx === -1) return;

    const line = this.buffer.slice(0, nlIdx).trim();
    this.buffer = this.buffer.slice(nlIdx + 1);

    try {
      const resp: TokenizerResponse = JSON.parse(line);
      if (resp.error) {
        this.pendingReject?.(new Error(resp.error));
      } else {
        this.pendingResolve(resp.tokens);
      }
    } catch (e) {
      this.pendingReject?.(new Error(`parse error: ${e}`));
    }

    this.pendingResolve = null;
    this.pendingReject = null;
  }

  async countTokens(text: string): Promise<number> {
    if (!this.proc) {
      return Math.max(1, Math.round(text.length / 4));
    }

    return new Promise<number>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      const request = JSON.stringify({ text }) + '\n';
      this.proc!.stdin?.write(request, 'utf-8');
    });
  }

  stop(): void {
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill();
      this.proc = null;
    }
  }
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}


