/**
 * Code Completion Handler
 *
 * 根据光标前的代码上下文，通过 LLM 生成内联补全建议。
 * 采用 Fill-in-the-Middle（FIM）风格提示。
 */

import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import 'dotenv/config';

// ── 类型 ──

export interface CompletionParams {
  /** 光标前面的文本 */
  prefix: string;
  /** 光标后面的文本（可选，用于 FIM） */
  suffix: string;
  /** 编程语言 */
  language: string;
  /** 触发类型：0=自动, 1=手动 */
  triggerKind: number;
}

export interface CompletionCandidate {
  text: string;
  range?: { start: number; end: number };
  filterText?: string;
}

// ── 模型提供者 ──

function createProvider() {
  const baseUrl = process.env.OPENAI_BASE_URL || '';
  return createOpenAICompatible({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: baseUrl,
    name: 'opencode',
  });
}

// ── 补全提示 ──

function buildCompletionPrompt(params: CompletionParams): string {
  const { prefix, suffix, language } = params;

  const lines = [
    `你是一个 ${language} 代码补全助手。根据光标前的代码，续写接下来最可能的内容。`,
    '',
    '要求：',
    '- 只输出代码，不要解释或注释。',
    '- 保持缩进风格一致。',
    '- 自然衔接光标前的代码。',
    '- 补全内容应直接跟在现有代码之后。',
    '- 如果光标后有代码，确保补全与其兼容。',
    '- 输出要完整（完整的语句、闭合括号、分号等）。',
    '',
    '=== 光标前代码 ===',
    prefix,
  ];

  if (suffix) {
    lines.push('', '=== 光标后代码 ===', suffix);
  }

  lines.push('', '=== 补全 ===');
  return lines.join('\n');
}

// ── 执行补全 ──

export interface CompletionOptions {
  model?: string;
  temperature?: number;
}

/**
 * 根据上下文生成代码补全候选。
 */
export async function generateCompletion(
  params: CompletionParams,
  options: CompletionOptions = {},
): Promise<CompletionCandidate[]> {
  const modelName = options.model || process.env.OPENAI_MODEL || 'deepseek-v4-flash';
  const provider = createProvider();
  const model = provider(modelName);

  const prompt = buildCompletionPrompt(params);

  // 从 prefix 末尾提取当前行缩进
  const lastLine = params.prefix.split('\n').pop() || '';
  const indentMatch = lastLine.match(/^(\s*)/);
  const currentIndent = indentMatch ? indentMatch[1] : '';

  const result = await generateText({
    model,
    prompt,
    temperature: options.temperature ?? 0.3,
  });

  // 清理补全文本
  let text = result.text.trimEnd();

  // 如果补全以当前行的缩进开头，保留它
  if (!text.startsWith(currentIndent) && currentIndent.length > 0) {
    // 可能模型没有包含缩进，这是合理的
  }

  return [
    {
      text,
      filterText: lastLine.trim(),
    },
  ];
}
