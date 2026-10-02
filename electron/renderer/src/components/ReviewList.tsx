import { useState } from 'react';
import type { PatchRecord } from '@/types/index.ts';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import { TYPE_LABEL, formatClock, shortPath } from '@/utils/display-format.ts';

/* ═══════════════════════════════════════════════════════════
   审查视图 · 列表形态
   按时间倒序把该文件的每条 patch 各铺一张卡（`-` 行红底、`+` 行绿底，
   左侧独立符号列保证对齐）。与「内联形态」（InlineDiffView，把合并后的
   最终 patch 直接铺在文件内容上）互为切换项，覆盖在编辑器主体之上。
   ═══════════════════════════════════════════════════════════ */

interface Props {
  /** 当前文件绝对路径（仅用于标题展示） */
  path: string;
  /** 该文件的 patch 记录 */
  patches: PatchRecord[];
  /** 某条记录被回退后：宿主刷新改动列表并重载文件内容 */
  onReverted?: () => void;
}

export function ReviewList({ path, patches, onReverted }: Props) {
  const { undoPatch } = useElectronAPI();
  /** 正在回退的记录 id（按钮转圈/禁用） */
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 回退失败提示：贴在对应卡片上，点其他卡片自动清掉 */
  const [failMsg, setFailMsg] = useState<{ id: string; text: string } | null>(null);

  // 无行级差异的记录（如纯写入空内容）没有展示价值
  const items = patches.filter(p => p.diff.trim());

  /** 回退单条改动：把文件还原到该 patch 之前，并把这条记录从历史里归档掉 */
  const revert = async (record: PatchRecord) => {
    if (busyId) return;
    setBusyId(record.id);
    setFailMsg(null);
    try {
      const res = await undoPatch({ recordId: record.id });
      if (res?.ok) onReverted?.();
      else setFailMsg({ id: record.id, text: res?.error || '回退失败' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="review-diff">
      <div className="review-diff-head">
        <span className="review-diff-badge">审查</span>
        <span className="review-diff-path" title={path}>{shortPath(path)}</span>
        <span className="review-diff-count">{items.length} 处改动</span>
      </div>

      <div className="review-diff-body">
        {items.length === 0 ? (
          <div className="review-menu-empty">该文件暂无可展示的行级差异</div>
        ) : items.map(p => (
          <div key={p.id} className="review-patch">
            <div className="review-patch-head">
              <span className={`review-item-type ${p.type}`}>{TYPE_LABEL[p.type] || p.type}</span>
              <span className="review-patch-desc" title={p.description}>{p.description}</span>
              <span className="review-patch-time">{formatClock(p.timestamp)}</span>
              {/* 卡片角落的回退：只把这一条改动还原掉，不影响同文件的其他 patch */}
              <button
                className="review-patch-undo"
                title="回退这一条改动"
                disabled={busyId === p.id}
                onClick={() => revert(p)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="9 14 4 9 9 4" />
                  <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                </svg>
                <span>{busyId === p.id ? '回退中…' : '回退'}</span>
              </button>
            </div>
            {failMsg?.id === p.id && <div className="review-patch-error">{failMsg.text}</div>}
            <div className="review-patch-diff">
              {p.diff.split('\n').map((line, i) => {
                const sign = line[0];
                const cls = sign === '+' ? 'add' : sign === '-' ? 'del' : 'ctx';
                return (
                  <div key={i} className={`review-diff-line ${cls}`}>
                    <span className="review-diff-sign">{sign === '+' || sign === '-' ? sign : ' '}</span>
                    <span className="review-diff-text">{line.length > 0 ? line.slice(1) : ''}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
