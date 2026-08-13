/**
 * 扫描 sessions/ 下所有会话文件（session.json / payload.json），
 * 检查 messages 中是否存在「孤儿 tool-call」：
 *   assistant 消息中的 tool-call 没有对应的 tool-result（toolCallId 失配）。
 * 这是 MissingToolResultsError (AI SDK v6 convertToLanguageModelPrompt) 的直接成因。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(process.cwd(), 'sessions');

interface Part {
  type?: string;
  toolCallId?: string;
}

function checkMessages(msgs: any[], label: string): string[] {
  const problems: string[] = [];
  const pendingCalls = new Map<string, string>(); // toolCallId -> 位置描述
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const p of m.content as Part[]) {
        if (p?.type === 'tool-call' && p.toolCallId) {
          pendingCalls.set(p.toolCallId, `assistant#${i}`);
        }
      }
    } else if (m.role === 'tool' && Array.isArray(m.content)) {
      for (const p of m.content as Part[]) {
        if (p?.type === 'tool-result' && p.toolCallId) {
          pendingCalls.delete(p.toolCallId);
        }
      }
    }
  }
  for (const [id, pos] of pendingCalls) {
    problems.push(`${label}: 孤儿 tool-call ${id} (${pos})，无对应 tool-result`);
  }
  return problems;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name === 'session.json' || name === 'payload.json') out.push(p);
  }
  return out;
}

let total = 0;
const files = walk(ROOT);
for (const f of files) {
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    const problems: string[] = [];
    if (Array.isArray(data.payloads)) {
      data.payloads.forEach((pl: any, pi: number) => {
        if (Array.isArray(pl?.messages)) {
          problems.push(...checkMessages(pl.messages, `${path.basename(path.dirname(f))} payload#${pi}`));
        }
      });
    }
    if (Array.isArray(data.agentMessages)) {
      problems.push(...checkMessages(data.agentMessages, `${path.basename(path.dirname(f))} agentMessages`));
    } else if (Array.isArray(data.messages)) {
      problems.push(...checkMessages(data.messages, `${path.basename(path.dirname(f))} messages`));
    }
    if (problems.length) {
      total += problems.length;
      console.log(`\n=== ${f} ===`);
      for (const p of problems) console.log('  ' + p);
    }
  } catch (e: any) {
    console.log(`[解析失败] ${f}: ${e.message}`);
  }
}
console.log(`\n扫描 ${files.length} 个文件，共发现 ${total} 个孤儿 tool-call`);
