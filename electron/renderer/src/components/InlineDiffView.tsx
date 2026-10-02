import { useLayoutEffect, useMemo, useRef } from 'react';
import { highlightLines } from '@/utils/code-highlight.ts';
import type { MergedHunk } from '@/utils/patch-merge.ts';

/* ═══════════════════════════════════════════════════════════
   内联差异视图（VSCode 式）
   把合并后的 patch 当作装饰直接铺在文件内容上：
   - 新增行：绿底，行号沿用当前文件行号
   - 删除行：红底的「幽灵行」插在改动位置之前，不占行号
   整篇一次性拼接后写入容器，几千行也不卡。

   为什么不用 dangerouslySetInnerHTML：
   React 在父组件重渲染时会重新提交这段 HTML（即便 __html 字符串一字未变），
   而给 innerHTML 赋值会让浏览器销毁重建全部子节点——用户拖选出来的选区
   随之塌陷。审查时「选中代码→浮出追问工具栏」正好会触发一次父级重渲染，
   于是刚选好的文本立刻就没了。这里改为 ref 手动写入，并记住上次的内容，
   只有真正变化时才碰 DOM，选区得以在无关重渲染中存活。
   ═══════════════════════════════════════════════════════════ */

/** 展开后的一行：上下文 / 新增 / 删除幽灵行 */
interface RenderRow {
  kind: 'ctx' | 'add' | 'del';
  /** 原文件行号（1-based）；删除行不属于当前内容，为 null */
  lineNo: number | null;
  /** 已高亮转义的 HTML 片段 */
  html: string;
}

interface Props {
  /** 合并后的改动段（已按位置排序、互不重叠） */
  hunks: MergedHunk[];
  /** 当前文件内容（按行拆开） */
  lines: string[];
}

/** 只在内容变化时写入 innerHTML，避免无谓地重建子节点（会清掉选区） */
function useHtml(ref: React.RefObject<HTMLElement | null>, html: string) {
  const lastRef = useRef<string | null>(null);
  // layout effect：在浏览器绘制前写入，避免闪一下旧内容
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || lastRef.current === html) return;
    el.innerHTML = html;
    lastRef.current = html;
  }, [ref, html]);
}

export function InlineDiffView({ hunks, lines }: Props) {
  const gutterRef = useRef<HTMLPreElement | null>(null);
  const codeRef = useRef<HTMLPreElement | null>(null);

  const { gutterHtml, codeHtml } = useMemo(() => {
    // 先展开成「当前文件 + 幽灵删除行」的线性序列，再统一高亮
    const rows: Array<{ kind: RenderRow['kind']; lineNo: number | null; text: string }> = [];
    let cursor = 0;
    for (const hunk of hunks) {
      for (let i = cursor; i < hunk.start; i++) rows.push({ kind: 'ctx', lineNo: i + 1, text: lines[i] });
      for (const text of hunk.removed) rows.push({ kind: 'del', lineNo: null, text });
      for (let i = hunk.start; i < hunk.end; i++) rows.push({ kind: 'add', lineNo: i + 1, text: lines[i] });
      cursor = hunk.end;
    }
    for (let i = cursor; i < lines.length; i++) rows.push({ kind: 'ctx', lineNo: i + 1, text: lines[i] });

    const highlighted = highlightLines(rows.map(r => r.text));
    const gutter = rows.map(r => `<span class="inline-diff-lineno ${r.kind}">${r.lineNo ?? ''}</span>`);
    const code = rows.map((r, i) => {
      const mark = r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : '';
      // data-line / data-kind：宿主靠它从 DOM 选区反查真实文件行号（删除的幽灵行不带行号）
      const attrs = `data-kind="${r.kind}"${r.lineNo !== null ? ` data-line="${r.lineNo}"` : ''}`;
      return `<span class="inline-diff-row ${r.kind}" ${attrs}>`
        + `<span class="inline-diff-mark">${mark}</span>`
        + `<span class="inline-diff-text">${highlighted[i] || ' '}</span>`
        + '</span>';
    });
    // 子元素均为 block，直接拼接即可分行（pre 里若夹 \n 会多出空行）
    return { gutterHtml: gutter.join(''), codeHtml: code.join('') };
  }, [hunks, lines]);

  useHtml(gutterRef, gutterHtml);
  useHtml(codeRef, codeHtml);

  return (
    <div className="inline-diff">
      <pre className="inline-diff-gutter" aria-hidden="true" ref={gutterRef} />
      <pre className="inline-diff-code" ref={codeRef} />
    </div>
  );
}

