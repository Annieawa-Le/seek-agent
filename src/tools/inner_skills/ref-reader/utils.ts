import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 所有 skill 的根目录 */
export const SKILLS_ROOT = path.join(__dirname, '..');

/**
 * 校验 skillName 是否合法（无路径穿越、无特殊字符）
 * 只允许字母、数字、短横线、下划线
 */
export function isValidSkillName(name: string): boolean {
  if (!name) return false;
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

/**
 * 校验 fileName 是否合法（无路径穿越、不以点开头）
 */
export function isValidFileName(name: string): boolean {
  if (!name) return false;
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  if (name.startsWith('.')) return false;
  return true;
}

/**
 * 获取指定 skill 的 references/ 目录路径
 */
export function getRefDir(skillName: string): string {
  return path.join(SKILLS_ROOT, skillName, 'references');
}

/**
 * 列出所有已启用且存在 references/ 目录的 skill 名称
 */
export async function listSkillsWithRefs(): Promise<string[]> {
  const entries = await fs.readdir(SKILLS_ROOT, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  const result: string[] = [];

  for (const dir of dirs) {
    try {
      const enablePath = path.join(SKILLS_ROOT, dir, 'enable.json');
      const configRaw = await fs.readFile(enablePath, 'utf-8');
      const config = JSON.parse(configRaw);
      if (!config.enable) continue;

      const refDir = getRefDir(dir);
      const refEntries = await fs.readdir(refDir);
      if (refEntries.length > 0) result.push(dir);
    } catch {
      // 没有 enable.json、references/ 目录不存在或为空 → 跳过
      continue;
    }
  }

  return result;
}

/**
 * 读取 references/ 下所有文件及其大小
 */
export async function readRefDir(skillName: string): Promise<{ name: string; size: number }[]> {
  const refDir = getRefDir(skillName);
  const entries = await fs.readdir(refDir, { withFileTypes: true });
  const files = entries.filter(e => e.isFile());
  const result: { name: string; size: number }[] = [];

  for (const file of files) {
    const stat = await fs.stat(path.join(refDir, file.name));
    result.push({ name: file.name, size: stat.size });
  }

  return result;
}
