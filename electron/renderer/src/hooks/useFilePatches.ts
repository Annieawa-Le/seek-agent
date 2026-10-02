import { useCallback, useEffect, useMemo, useState } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import type { PatchRecord } from '@/types/index.ts';
import {
  GLOBAL_WATERMARK_KEY,
  normPath,
  parseWatermarks,
  pendingOf,
  raiseWatermark,
  type Watermarks,
} from '@/utils/review-watermark.ts';

/* ═══════════════════════════════════════════════════════════
   AI 改动记录数据源
   - 从主进程 fs:listPatches 拉取 .seek-agent/history/*.diff
   - 水位线按文件存 localStorage：某文件「已审查」后，它自己的水位线抬到
     该文件当前最大记录时间，其它文件不受影响（规则见 utils/review-watermark）
   - 低频轮询，AI 在后台改文件时列表能自己长出来
   ═══════════════════════════════════════════════════════════ */

/** 「已审查」水位线（按文件） */
const WATERMARK_KEY = 'seek-agent-review-watermark';
/** 旧版的全局水位线键（单一数字）：首次迁移时读一次，之后不再使用 */
const LEGACY_WATERMARK_KEY = 'seek-agent-review-watermark-global';

/** 轮询间隔 */
const POLL_MS = 8000;

/** 单次拉取条数上限（主进程另有正文预算兜底） */
const FETCH_LIMIT = 200;

export { normPath } from '@/utils/review-watermark.ts';

/** 按路径聚合后的改动文件条目 */
export interface ChangedFile {
  path: string;
  count: number;
  lastType: string;
  lastTs: number;
  /** 该文件未审查的记录，用于「只标当前文件」「只撤当前文件最近一条」 */
  records: PatchRecord[];
}

export interface FilePatches {
  /** 改动过的文件（最近改动在前） */
  files: ChangedFile[];
  /** 当前文件的相关 patch（按时间倒序，与主进程返回顺序一致） */
  patchesForActive: PatchRecord[];
  error: string | null;
  refresh: () => void;
  /** 标记某个文件已审查：只抬该文件的水位线 */
  finishFile: (path: string) => void;
  /** 标记全部已审查：每个文件各自抬到自己的最大记录时间 */
  finishAll: () => void;
}

/** 读取水位线；兼容旧版单一数字结构 */
function loadWatermarks(): Watermarks {
  const current = parseWatermarks(window.localStorage.getItem(WATERMARK_KEY));
  if (current) return current;
  // 旧版全局水位线：抬到那个时刻之前的记录一律视为已审查
  const legacy = Number(window.localStorage.getItem(LEGACY_WATERMARK_KEY));
  if (Number.isFinite(legacy) && legacy > 0) return { [GLOBAL_WATERMARK_KEY]: legacy };
  return {};
}

function saveWatermarks(w: Watermarks) {
  try {
    window.localStorage.setItem(WATERMARK_KEY, JSON.stringify(w));
  } catch {
    // 存储不可用（隐私模式等）时不阻塞功能，只是下次会话记不住水位线
  }
}

export function useFilePatches(activePath: string): FilePatches {
  const { listPatches } = useElectronAPI();
  const [patches, setPatches] = useState<PatchRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [watermarks, setWatermarks] = useState<Watermarks>(loadWatermarks);

  const refresh = useCallback(async () => {
    // 主进程按 since 过滤，取所有水位线的下界即可（多余的靠 pendingOf 兜掉）
    const values = Object.values(watermarks);
    const floor = values.length ? Math.min(...values) : 0;
    const res = await listPatches({ since: floor, limit: FETCH_LIMIT });
    if (res?.ok) {
      setPatches(res.entries);
      setError(null);
    } else {
      setError(res?.error || '读取改动记录失败');
    }
  }, [listPatches, watermarks]);

  // 首屏与水位线变化时刷新；随后低频轮询
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  /** 过滤掉各文件已审查的记录（每个文件按自己的水位线判定） */
  const pending = useMemo(() => pendingOf(patches, watermarks), [patches, watermarks]);

  const files = useMemo<ChangedFile[]>(() => {
    const map = new Map<string, ChangedFile>();
    for (const p of pending) {
      const key = normPath(p.filePath);
      const hit = map.get(key);
      if (hit) {
        hit.count += 1;
        hit.records.push(p);
        if (p.timestamp > hit.lastTs) { hit.lastTs = p.timestamp; hit.lastType = p.type; }
      } else {
        map.set(key, { path: p.filePath, count: 1, lastType: p.type, lastTs: p.timestamp, records: [p] });
      }
    }
    // 最近改动的文件排在前面
    return [...map.values()].sort((a, b) => b.lastTs - a.lastTs);
  }, [pending]);

  const patchesForActive = useMemo(
    () => pending.filter(p => normPath(p.filePath) === normPath(activePath)),
    [pending, activePath],
  );

  /** 按文件抬水位线并落盘；副作用（写 localStorage）刻意留在 updater 之外 */
  const applyWatermarks = useCallback((prev: Watermarks, targets: ChangedFile[]) => {
    let next = prev;
    for (const f of targets) next = raiseWatermark(next, f.path, f.records);
    if (next === prev) return prev;
    saveWatermarks(next);
    return next;
  }, []);

  const finishFile = useCallback((path: string) => {
    const target = files.find(f => normPath(f.path) === normPath(path));
    if (!target) return;
    setWatermarks(prev => applyWatermarks(prev, [target]));
  }, [files, applyWatermarks]);

  const finishAll = useCallback(() => {
    if (files.length === 0) return;
    setWatermarks(prev => applyWatermarks(prev, files));
  }, [files, applyWatermarks]);

  return { files, patchesForActive, error, refresh, finishFile, finishAll };
}

