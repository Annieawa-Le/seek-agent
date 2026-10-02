import type { PatchRecord } from '@/types/index.ts';

/* ═══════════════════════════════════════════════════════════
   审查水位线（按文件）

   从 useFilePatches 抽出的纯逻辑：不碰 localStorage、不碰 React，
   便于单测，也让「已审查」的判定规则集中在一处。

   规则：每个文件一条独立水位线（归一化路径 → 毫秒时间戳）。
   某文件「已审查」= 把它自己的水位线抬到该文件当前最大记录时间，
   而不是 Date.now()——后者会把同一毫秒内刚写入的记录一并跳过。
   ═══════════════════════════════════════════════════════════ */

/** 归一化路径 → 毫秒时间戳 */
export type Watermarks = Record<string, number>;

/** 迁移来的全局水位线键：对未单列的文件生效 */
export const GLOBAL_WATERMARK_KEY = '*';

/** 路径归一化：统一分隔符 + 小写（Windows 下盘符/文件名大小写不敏感） */
export const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase();

/** 某文件的生效水位线：显式记录优先，其次回落到迁移来的全局值 */
export function watermarkOf(w: Watermarks, path: string): number {
  return w[normPath(path)] ?? w[GLOBAL_WATERMARK_KEY] ?? 0;
}

/** 过滤出「尚未审查」的记录（每个文件按自己的水位线判定） */
export function pendingOf(patches: PatchRecord[], w: Watermarks): PatchRecord[] {
  return patches.filter(p => p.timestamp > watermarkOf(w, p.filePath));
}

/**
 * 按文件抬水位线：取该文件当前最大记录时间，而不是 now。
 * 水位线单调不回退（更小的记录不会把它压回去）。
 */
export function raiseWatermark(w: Watermarks, path: string, records: PatchRecord[]): Watermarks {
  if (records.length === 0) return w;
  const maxTs = Math.max(...records.map(r => r.timestamp));
  const key = normPath(path);
  const next = { ...w, [key]: Math.max(w[key] ?? 0, maxTs) };
  // 迁移来的全局值一旦被按文件的值取代就没有意义了，清掉避免继续压低下拉取的下界
  if (next[GLOBAL_WATERMARK_KEY] !== undefined) delete next[GLOBAL_WATERMARK_KEY];
  return next;
}

/** 解析持久化的水位线结构；任何异常都退回空表（等同「全部未审查」） */
export function parseWatermarks(raw: string | null): Watermarks | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: Watermarks = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}
