import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import { useFilePatches } from '@/hooks/useFilePatches.ts';
import { ReviewDock } from '@/components/ReviewDock.tsx';
import { InlineDiffView } from '@/components/InlineDiffView.tsx';
import { ReviewList } from '@/components/ReviewList.tsx';
import { SelectionToolbar, type ReviewActionKey, type ReviewContext } from '@/components/SelectionToolbar.tsx';
import { baseName } from '@/utils/display-format.ts';
import { createHighlighters, highlightLine } from '@/utils/code-highlight.ts';
import { countHunkChanges, mergeFilePatches } from '@/utils/patch-merge.ts';
import { resolveDomSelection } from '@/utils/selection-context.ts';

/* ═══════════════════════════════════════════════════════════
   内嵌文件编辑器（VSCode 风格，原型）
   - 编辑区用等宽 <textarea>（原生输入/撤销/选区全部免费），背后叠一层高亮 <pre> 承担着色
   - 行号槽独立滚动，由 onScroll 同步 translateY
   - 打开即加载、Ctrl/Cmd+S 保存；未保存关闭时由宿主组件确认
   ═══════════════════════════════════════════════════════════ */

/** 打开前的字符上限：与主进程 2MB 文件上限留有富余（超出则降级为只读预览） */
const MAX_EDIT_CHARS = 600_000;

/** 审查形式：内联差异（铺在文件内容上）或列表卡片（逐条 patch） */
type ReviewStyle = 'inline' | 'list';

/** 审查形式的本地记忆键：编辑器按文件重挂载，偏好得存在外面 */
const REVIEW_STYLE_KEY = 'seek-agent-review-style';

/** 语言标识：按扩展名给出状态栏展示名 */
const LANGUAGE_MAP: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript React', js: 'JavaScript', jsx: 'JavaScript React', mjs: 'JavaScript', cjs: 'JavaScript',
  json: 'JSON', md: 'Markdown', css: 'CSS', scss: 'SCSS', less: 'Less', html: 'HTML', vue: 'Vue', svelte: 'Svelte',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', c: 'C', h: 'C', cpp: 'C++', hpp: 'C++', cs: 'C#', php: 'PHP',
  rb: 'Ruby', sh: 'Shell', bat: 'Batch', ps1: 'PowerShell', yml: 'YAML', yaml: 'YAML', toml: 'TOML', ini: 'INI',
  sql: 'SQL', xml: 'XML', txt: 'Plain Text', env: 'Dotenv', gitignore: 'GitIgnore',
};

function languageOf(name: string): string {
  const base = name.split(/[\\/]/).pop() || name;
  if (base.startsWith('.') && !base.includes('.', 1)) return LANGUAGE_MAP[base.slice(1)] || 'Plain Text';
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  return LANGUAGE_MAP[ext] || (ext ? ext.toUpperCase() : 'Plain Text');
}

/** 字节数 → 人类可读体积 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

interface Props {
  /** 文件绝对路径（标签页 id 即此值） */
  filePath: string;
  /** 文件标签内容变化：用于同步标签标题与「未保存」圆点 */
  onChange?: (info: { dirty: boolean; name: string }) => void;
  /** 审查浮球切换文件：宿主以此打开/激活对应文件标签页 */
  onOpenFile?: (absPath: string) => void;
  /** 审查模式开关（由宿主持有：切换文件时本组件会重挂载，状态不能落在内部） */
  reviewMode?: boolean;
  onReviewModeChange?: (open: boolean) => void;
  /** 选中的代码被拖到会话区：宿主负责把「代码块 + 追问」送进输入框 */
  onAskSelection?: (action: ReviewActionKey, ctx: ReviewContext) => void;
}

export function FileEditor({ filePath, onChange, onOpenFile, reviewMode, onReviewModeChange, onAskSelection }: Props) {
  const { readFile, writeFile } = useElectronAPI();
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  /** 原文件的行尾符：编辑器内部一律按 LF 处理，保存时再还原 */
  const [eol, setEol] = useState('\n');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState(0);
  const [caret, setCaret] = useState({ line: 1, col: 1 });
  const [toast, setToast] = useState<string | null>(null);

  /** AI 改动记录（审查浮球的列表与文件内差异都基于它） */
  const review = useFilePatches(filePath);

  /** 审查形式：记住上次选择，切换文件不重置 */
  const [diffStyle, setDiffStyle] = useState<ReviewStyle>(
    () => (window.localStorage.getItem(REVIEW_STYLE_KEY) === 'list' ? 'list' : 'inline'),
  );
  const changeDiffStyle = (style: ReviewStyle) => {
    setDiffStyle(style);
    window.localStorage.setItem(REVIEW_STYLE_KEY, style);
  };

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const hlRef = useRef<HTMLPreElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  const name = baseName(filePath);
  const dirty = content !== savedContent;
  const readOnly = content.length > MAX_EDIT_CHARS;

  /**
   * 读盘并铺到编辑器里。
   * 回退改动后磁盘内容已变，需要重新读取——此时不走 loading 态，
   * 免得整块视图闪一下白。
   */
  const reload = useCallback(async (silent = true) => {
    const res = await readFile(filePath);
    if (!res.ok) return;
    // 统一行尾为 LF 再进编辑器：textarea 与高亮层必须看到同一套换行，
    // 否则 CRLF / CR 文件会出现行数不一致的错位。保存时按原行尾还原。
    const raw = res.content ?? '';
    const text = raw.replace(/\r\n?/g, '\n');
    setEol(raw.includes('\r\n') ? '\r\n' : raw.includes('\r') ? '\r' : '\n');
    setContent(text);
    setSavedContent(text);
    setSize(res.size ?? 0);
    if (!silent) setLoading(false);
  }, [filePath, readFile]);

  /* ── 加载：路径变化时重新读取 ── */
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    readFile(filePath).then(res => {
      if (!alive) return;
      if (res.ok) {
        const raw = res.content ?? '';
        const text = raw.replace(/\r\n?/g, '\n');
        setEol(raw.includes('\r\n') ? '\r\n' : raw.includes('\r') ? '\r' : '\n');
        setContent(text);
        setSavedContent(text);
        setSize(res.size ?? 0);
      } else {
        setError(res.error || '读取失败');
      }
      setLoading(false);
    });
    return () => { alive = false; };
  }, [filePath, readFile]);

  /* ── 向外同步脏标记 + 文件显示名（标签标题/圆点） ──
     onChange 通常是宿主的内联箭头函数（每次渲染换新引用），直接放进依赖会导致
     每次渲染都回调一次。用 ref 接住最新引用，effect 只在数据真的变化时跑。 */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    onChangeRef.current?.({ dirty, name });
  }, [dirty, name]);

  /* ── 高亮渲染：整篇转义 + 逐行着色 ── */
  const { keywordRe, tokenRe } = useMemo(() => createHighlighters(), []);

  const lines = useMemo(() => content.split('\n'), [content]);
  /**
   * 高亮层逐行渲染成块级元素（而不是 join('\n') 塞进 <pre>）：
   * - 行数严格等于 lines.length，末尾空行也占一行 —— <pre> 的末尾换行不产生行盒，
   *   会比分层的 textarea 少一行，滚到底时两者错位
   * - 不依赖 `\n` / `\r` 在 HTML 与 CSS 里的换行语义，行内出现 \r 也不会裂成两行
   */
  const highlighted = useMemo(
    () => lines
      .map(l => `<span class="file-editor-line">${highlightLine(l, keywordRe, tokenRe)}</span>`)
      .join(''),
    [lines, keywordRe, tokenRe],
  );

  /* ── 审查：把该文件的多次 patch 合并成一份最终 patch，直接铺在内容上 ── */
  const merged = useMemo(
    () => mergeFilePatches(review.patchesForActive, lines),
    [review.patchesForActive, lines],
  );
  // 有改动可看时才接管视图；没有则正常编辑，避免开关与内容对不上
  const reviewActive = !!reviewMode && review.patchesForActive.length > 0;
  const inlineReview = reviewActive && diffStyle === 'inline' && merged.hunks.length > 0;
  const listReview = reviewActive && diffStyle === 'list';
  const changeStats = useMemo(() => countHunkChanges(merged.hunks), [merged.hunks]);

  /* ── 审查模式下的选区追问：选中代码 → 浮出 不懂/有误/推荐 工具栏 ── */
  const [selection, setSelection] = useState<{ x: number; y: number; ctx: ReviewContext } | null>(null);


  /* ── 审查模式下的选区追问：选中代码 → 浮出 不懂/有误/推荐 工具栏 ──
     选区有两个来源，取决于审查形态：
     - 内联形态：文本在 InlineDiffView 里（普通 DOM），走 window.getSelection()
     - 非内联（普通编辑 / 列表形态）：文本在 textarea 里，走 selectionStart/End
     两条路都收敛成「文件行号区间 + 代码原文」，再统一算工具栏坐标。 */

  /** 把行号区间 + 候选坐标点组装成 selection state；无有效内容时收起 */
  const commitSelection = (startLine: number, endLine: number, anchor: { x: number; y: number }) => {
    const code = lines.slice(startLine - 1, endLine).join('\n');
    if (!code.trim()) { setSelection(null); return; }
    const ctxBase = { code, filePath, startLine, endLine };
    setSelection({
      // 横向贴着编辑区左侧即可（不需要跟到光标列：长行滚动时反而会飘出视口）
      x: Math.min(Math.max(anchor.x, 8), Math.max(window.innerWidth - 240, 8)),
      y: Math.max(anchor.y, 8),
      ctx: ctxBase,
    });
  };

  /** 内联差异视图：从 DOM 选区反查行号，用选区矩形的左上角定位工具栏 */
  const syncDiffSelection = () => {
    const hit = resolveDomSelection(lines, filePath);
    if (!hit) { setSelection(null); return; }
    const range = window.getSelection()?.getRangeAt(0);
    const rect = range?.getBoundingClientRect();
    // 选区上方放不下时落到下方，避免顶到窗口外
    const top = rect ? (rect.top - 38 >= 8 ? rect.top - 38 : rect.bottom + 8) : 8;
    const left = rect ? rect.left : 16;
    commitSelection(hit.startLine, hit.endLine, { x: left, y: top });
  };

  /** 普通编辑：读取 textarea 选区，按固定行高折算起始行的视口纵坐标 */
  const syncTextareaSelection = () => {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e } = ta;
    if (e <= s) { setSelection(null); return; }
    const code = ta.value.slice(s, e);
    if (!code.trim()) { setSelection(null); return; }

    // 行号由选区在全文中的偏移量推出：起点之前的换行数 + 1
    const startLine = ta.value.slice(0, s).split('\n').length;
    const endLine = startLine + code.split('\n').length - 1;
    // textarea 拿不到选区坐标矩形，按其屏幕位置 + 固定行高折算（等宽字体，行高恒定）
    const rect = ta.getBoundingClientRect();
    const style = window.getComputedStyle(ta);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const rowTop = rect.top + paddingTop + (startLine - 1) * lineHeight - ta.scrollTop;

    commitSelection(startLine, endLine, {
      x: rect.left + 16,
      y: rowTop - 38 >= 8 ? rowTop - 38 : rowTop + lineHeight + 8,
    });
  };

  /** 按当前审查形态选择选区来源 */
  const syncSelection = () => {
    if (inlineReview) syncDiffSelection();
    else syncTextareaSelection();
  };

  /*
    选区的收尾：点到「真正无关的地方」才收起工具栏。
    不能挂在编辑元素的 onBlur 上——工具栏自己的按钮一被按下就会让编辑器失焦，
    那样工具栏刚出现就会被自己点没。这里用 document 级 mousedown 区分三种落点：
    - 工具栏内部：保持（用户正要拖拽或点击按钮）
    - 编辑器内部（textarea / 内联视图）：交给各自的选择事件去更新
    - 其它地方：收起
  */
  useEffect(() => {
    if (!selection) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest('.selection-toolbar, .file-editor-input, .inline-diff-host')) return;
      setSelection(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [selection]);

  /* ── 滚动同步：行号槽与高亮层跟随 textarea ── */
  const handleScroll = () => {
    const ta = taRef.current;
    if (!ta) return;
    if (hlRef.current) {
      hlRef.current.scrollTop = ta.scrollTop;
      hlRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  };

  /* ── 光标位置（状态栏 Ln/Col） ── */
  const updateCaret = () => {
    const ta = taRef.current;
    if (!ta) return;
    const upto = ta.value.slice(0, ta.selectionStart);
    const row = upto.split('\n');
    setCaret({ line: row.length, col: (row[row.length - 1]?.length ?? 0) + 1 });
  };

  /* ── 保存 ── */
  const save = async () => {
    if (readOnly) return;
    // 还原文件原本的行尾符，避免保存后整篇变成 LF 污染 diff
    const payload = eol === '\n' ? content : content.replace(/\n/g, eol);
    const res = await writeFile({ path: filePath, content: payload });
    if (res.ok) {
      setSavedContent(content);
      setSize(res.size ?? size);
      flash('已保存');
    } else {
      flash(`保存失败：${res.error}`);
    }
  };

  const flash = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(t => (t === text ? null : t)), 1800);
  };

  /** Tab 键插入两个空格（不跳出控件，编辑器基本素养） */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const { selectionStart: s, selectionEnd: en } = ta;
      const next = `${content.slice(0, s)}  ${content.slice(en)}`;
      setContent(next);
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
    }
  };

  /* ── 面包屑：工作区根名 + 中间目录（过深的层级折叠为 …） ── */
  const crumbs = useMemo(() => {
    const parts = filePath.split(/[\\/]/).filter(Boolean);
    const fileName = parts.pop() || filePath;
    // 忽略盘符/根（如 D:），只保留有意义的目录段
    const dirs = parts.filter(p => !/^[A-Za-z]:$/.test(p));
    const shown = dirs.length > 3 ? ['…', ...dirs.slice(-2)] : dirs;
    return [...shown, fileName];
  }, [filePath]);

  if (loading) {
    return <div className="file-editor"><div className="file-editor-placeholder">正在打开 {name}…</div></div>;
  }

  if (error) {
    return (
      <div className="file-editor">
        <div className="file-editor-placeholder error">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="13" /><line x1="12" y1="16.5" x2="12" y2="16.6" />
          </svg>
          <div className="file-editor-placeholder-title">无法打开该文件</div>
          <div className="file-editor-placeholder-detail">{error}</div>
          <div className="file-editor-placeholder-path" title={filePath}>{filePath}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="file-editor">
      {/* 面包屑：VSCode 编辑器顶部的路径条 */}
      <div className="file-editor-crumbs" title={filePath}>
        {crumbs.map((c, i) => (
          <span key={i} className="file-editor-crumb-group">
            {i > 0 && <span className="file-editor-crumb-sep">›</span>}
            <span className={`file-editor-crumb${i === crumbs.length - 1 ? ' current' : ''}`}>{c}</span>
          </span>
        ))}
        {dirty && <span className="file-editor-crumb-dirty" title="有未保存改动">●</span>}
        {reviewActive && (
          <span className="file-editor-review-chip">
            <span className="file-editor-review-stat">
              {diffStyle === 'inline' ? (
                <>
                  <em className="add">+{changeStats.added}</em>
                  <em className="del">-{changeStats.removed}</em>
                  <em className="dim">合并 {merged.hunks.length} 处</em>
                </>
              ) : (
                <em className="dim">{review.patchesForActive.length} 条记录</em>
              )}
            </span>
            <span className="file-editor-review-switch">
              <button
                className={diffStyle === 'inline' ? 'on' : ''}
                disabled={merged.hunks.length === 0}
                title={merged.hunks.length === 0 ? '该文件当前定位不到行级改动' : '把改动直接标在文件内容里'}
                onClick={() => changeDiffStyle('inline')}
              >
                内联
              </button>
              <button
                className={diffStyle === 'list' ? 'on' : ''}
                title="逐条列出每次 patch"
                onClick={() => changeDiffStyle('list')}
              >
                列表
              </button>
            </span>
            <button className="file-editor-review-exit" onClick={() => onReviewModeChange?.(false)}>退出审查</button>
          </span>
        )}
      </div>

      <div className="file-editor-main">
        <div className={`file-editor-body${inlineReview ? ' reviewing' : ''}`}>
          <div className="file-editor-gutter" ref={gutterRef}>
            <div className="file-editor-gutter-inner">
              {lines.map((_, i) => (
                <div key={i} className={`file-editor-line-no${i + 1 === caret.line ? ' active' : ''}`}>{i + 1}</div>
              ))}
            </div>
          </div>
          <div className="file-editor-code">
            <pre className="file-editor-highlight" ref={hlRef} aria-hidden="true">
              <code dangerouslySetInnerHTML={{ __html: highlighted }} />
            </pre>
            <textarea
              ref={taRef}
              className="file-editor-input"
              value={content}
              spellCheck={false}
              readOnly={readOnly}
              wrap="off"
              onChange={e => setContent(e.target.value)}
              onScroll={handleScroll}
              onKeyDown={handleKeyDown}
              onKeyUp={() => { updateCaret(); syncSelection(); }}
              onClick={() => { updateCaret(); syncSelection(); }}
              onSelect={() => { updateCaret(); syncSelection(); }}
              /* 刻意不挂 onBlur：工具栏按钮本身会让 textarea 失焦，
                 一 blur 就收起会让工具栏「点不到」甚至闪没。改由下方
                 document 级 mousedown 判定「点到真正无关的地方」才收起。 */
            />
          </div>
        </div>

        {/* 审查模式：普通编辑视图让位（由 .reviewing 隐藏 body），改为把合并后的最终
            patch 当装饰直接铺在文件内容上（VSCode 式内联差异） */}
        {/* 内联差异视图的内容是 dangerouslySetInnerHTML 注入的，挂不上 React 事件；
            这里包一层容器接选区事件（mouseup / keyup 覆盖拖选与键盘选） */}
        {inlineReview && (
          <div
            className="inline-diff-host"
            onMouseUp={syncDiffSelection}
            onKeyUp={syncDiffSelection}
          >
            <InlineDiffView hunks={merged.hunks} lines={lines} />
          </div>
        )}

        {/* 审查模式 · 列表形态：逐条 patch 卡片，覆盖在编辑器主体之上 */}
        {listReview && (
          <ReviewList
            path={filePath}
            patches={review.patchesForActive}
            onReverted={() => { review.refresh(); reload(); }}
          />
        )}

        {/* 审查模式 + 选中代码：浮出追问工具栏（按住按钮拖到会话区即可追问 AI） */}
        {reviewMode && selection && (
          <SelectionToolbar
            x={selection.x}
            y={selection.y}
            context={selection.ctx}
            onDropAction={(action, ctx) => {
              onAskSelection?.(action, ctx);
              setSelection(null);
            }}
          />
        )}

        {/* 审查浮球：右下角悬浮，列出 AI 自上次审查以来的改动 */}
        <ReviewDock
          activePath={filePath}
          files={review.files}
          error={review.error}
          reviewMode={!!reviewMode}
          onReviewModeChange={onReviewModeChange ?? (() => {})}
          onOpenFile={onOpenFile}
          onRefresh={review.refresh}
          onFinishFile={review.finishFile}
          onFinishAll={review.finishAll}
          onUndoDone={() => { review.refresh(); reload(); }}
        />
      </div>

      <div className="file-editor-status">
        <span className="file-editor-status-left" title={filePath}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7l2-2h4l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
          </svg>
          {filePath}
        </span>
        <span className="file-editor-status-right">
          {readOnly && <span className="file-editor-readonly" title={`文件超过 ${MAX_EDIT_CHARS} 字符，已切换为只读预览`}>只读</span>}
          <span>行 {lines.length}</span>
          <span>Ln {caret.line}, Col {caret.col}</span>
          <span>空格: 2</span>
          <span>UTF-8</span>
          <span>{formatSize(new Blob([content]).size || size)}</span>
          <span className="file-editor-lang">{languageOf(name)}</span>
        </span>
      </div>

      {toast && <div className="file-editor-toast">{toast}</div>}
    </div>
  );
}








