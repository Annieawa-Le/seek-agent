import { useCallback, useEffect, useRef, useState } from 'react';

/* ═══════════════════════════════════════════════════════════
   选区浮动工具栏（编辑器审查模式）

   在编辑器里选中一段代码后，鼠标附近浮出三个动作按钮：
     不懂 / 有误 / 推荐
   按住任一按钮拖到会话区放下，就把「这段代码 + 对应提问」作为
   一条待发送内容交给会话，向 AI 追问这段改动。

   拖拽实现说明：HTML5 DnD 在 textarea 上会把原生选区一起拖走，
   观感是「拽出个半透明文字」，且 drop 后选区丢失。这里改用
   pointer 事件自管拖拽，配合一层跟随光标的幽灵元素。
   ═══════════════════════════════════════════════════════════ */

/**
 * 三个动作及其对应的追问语。
 *
 * 这里只给「追问语」本身：代码块不再拼进正文，而是交给输入栏挂成附件 chip
 * （见 InputBar 的 snippet 附件）。选中几十行代码时，正文里铺一大段代码会让
 * 输入框完全没法看；chip 只占一行，发送时再还原成完整代码块，气泡里照常渲染。
 */
export const REVIEW_ACTIONS = [
  {
    key: 'confused',
    label: '不懂',
    hint: '这段代码看不太懂，请解释',
    prompt: '这段代码我没看明白，能讲一下它为什么这么改吗？',
  },
  {
    key: 'wrong',
    label: '有误',
    hint: '这段改动我认为有问题',
    prompt: '这段改动我认为有问题，请说明它错在哪、会有什么后果。',
  },
  {
    key: 'suggest',
    label: '推荐',
    hint: '这段还能怎么改得更好',
    prompt: '这段改动还能怎么改进？请给出具体建议。',
  },
] as const;

export type ReviewActionKey = typeof REVIEW_ACTIONS[number]['key'];

/** 一次选区的上下文：代码原文 + 出处 */
export interface ReviewContext {
  /** 代码原文 */
  code: string;
  /** 文件绝对路径 */
  filePath: string;
  /** 起始行号（1 基） */
  startLine: number;
  /** 结束行号（1 基） */
  endLine: number;
}

/**
 * 用围栏包好代码块并标注出处。
 *
 * 调用方是输入栏：代码片段先挂成附件 chip，发送时才用它还原成完整代码块。
 */
export function buildFence(ctx: ReviewContext): string {
  const ext = ctx.filePath.split('.').pop() || '';
  const range = ctx.startLine === ctx.endLine ? `第 ${ctx.startLine} 行` : `第 ${ctx.startLine}-${ctx.endLine} 行`;
  return `${ctx.filePath}（${range}）：\n\`\`\`${ext}\n${ctx.code}\n\`\`\``;
}

interface Props {
  /** 鼠标附近的定位点（视口坐标） */
  x: number;
  y: number;
  /** 拖拽落下时的回调：由宿主持有，负责把内容送进输入框 */
  onDropAction: (action: ReviewActionKey, ctx: ReviewContext) => void;
  /** 当前选区对应的上下文 */
  context: ReviewContext;
}

export function SelectionToolbar({ x, y, context, onDropAction }: Props) {
  /** 正在拖拽的动作 + 光标位置（非 null 时渲染幽灵元素） */
  const [dragging, setDragging] = useState<{ key: ReviewActionKey; x: number; y: number } | null>(null);
  /** 光标当前是否悬在一个可放置区域上 */
  const [overDropZone, setOverDropZone] = useState(false);
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  /**
   * 自管拖拽：pointerdown 开始，pointermove 跟随，pointerup 判定落点。
   * 用 elementFromPoint 命中检测，宿主只要在落点容器上标 data-review-drop 即可。
   */
  useEffect(() => {
    if (!dragging) return;

    /** 命中检测：拖到带 data-review-drop 的容器（会话输入框）上方即视为可放置 */
    const hitDropZone = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y);
      return (el?.closest('[data-review-drop]') as HTMLElement | null) ?? null;
    };

    /** 给当前命中的落点挂高亮类，移动过程中要先把上一个摘掉 */
    let highlighted: HTMLElement | null = null;
    const setHighlight = (el: HTMLElement | null) => {
      if (highlighted === el) return;
      highlighted?.classList.remove('review-drop-active');
      el?.classList.add('review-drop-active');
      highlighted = el;
    };

    const onMove = (e: PointerEvent) => {
      setDragging(d => (d ? { ...d, x: e.clientX, y: e.clientY } : d));
      const zone = hitDropZone(e.clientX, e.clientY);
      setOverDropZone(!!zone);
      setHighlight(zone);
    };

    const onUp = (e: PointerEvent) => {
      const zone = hitDropZone(e.clientX, e.clientY);
      const key = dragging.key;
      // 先复位再回调：回调会往输入框里写内容，可能触发重渲染
      setDragging(null);
      setOverDropZone(false);
      setHighlight(null);
      if (zone) onDropAction(key, context);
    };

    // Esc 取消拖拽，避免拖到一半反悔还得去点一下
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setDragging(null);
      setOverDropZone(false);
      setHighlight(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKeyDown);
      // 组件卸载时兜底摘掉高亮，避免残留虚线框
      highlighted?.classList.remove('review-drop-active');
    };
  }, [dragging, context, onDropAction]);


  /** 按下游标不松手就进入拖拽态，据此判断是「点击」还是「拖拽」 */
  const startDrag = useCallback((e: React.PointerEvent, key: ReviewActionKey) => {
    // 只认主键；防止右键/中键误触发
    if (e.button !== 0) return;
    e.preventDefault();
    setDragging({ key, x: e.clientX, y: e.clientY });
  }, []);

  const activeAction = dragging ? REVIEW_ACTIONS.find(a => a.key === dragging.key) : null;

  return (
    <>
      <div
        className="selection-toolbar"
        ref={toolbarRef}
        style={{ left: x, top: y }}
        // 工具栏自身不该抢走编辑器的选区焦点
        onMouseDown={e => e.preventDefault()}
      >
        {REVIEW_ACTIONS.map(a => (
          <button
            key={a.key}
            className={`selection-toolbar-btn ${a.key}`}
            title={`${a.hint}——按住拖到会话区即可追问`}
            onPointerDown={e => startDrag(e, a.key)}
          >
            <ActionIcon action={a.key} />
            <span>{a.label}</span>
          </button>
        ))}
      </div>

      {/* 拖拽中的幽灵：跟随光标，并提示落点是否可用 */}
      {dragging && activeAction && (
        <div
          className={`selection-drag-ghost${overDropZone ? ' over-drop' : ''}`}
          style={{ left: dragging.x, top: dragging.y }}
        >
          <ActionIcon action={activeAction.key} />
          <span>{activeAction.label}</span>
          <em>{overDropZone ? '松开即可追问' : '拖到会话区'}</em>
        </div>
      )}
    </>
  );
}

/** 三个动作的 SVG 图标 */
function ActionIcon({ action }: { action: ReviewActionKey }) {
  if (action === 'confused') {
    // 问号：不明白
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.6-2.8 2.6" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    );
  }
  if (action === 'wrong') {
    // 警告三角：有误
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        <line x1="12" y1="9" x2="12" y2="13.5" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    );
  }
  // 灯泡：推荐改进
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 18h6" />
      <path d="M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.4.3.5.7.5 1.1v1h6v-1c0-.4.1-.8.5-1.1A6 6 0 0 0 12 3z" />
    </svg>
  );
}

