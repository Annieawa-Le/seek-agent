import { useState, useRef, useEffect, useLayoutEffect, type ReactNode, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

/**
 * ModeSelector — 输入栏内的模式选择器
 *
 * 外观与工作区选择器（FolderSelector）保持一致：紧凑触发器 + 上拉悬浮菜单。
 * 受控组件：当前模式由 mode 传入，切换经 onSelect 上抛（由上层同步 agent 进程）。
 */

/** 统一的内联 SVG 图标容器（Feather Icons 风格，24x24 线性） */
function Icon({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export interface ModeMeta {
  name: string;
  label: string;
  icon: ReactNode;
  desc: string;
}

/** 内置模式元数据（与 src/modes/index.ts 注册保持一致） */
export const MODES: ModeMeta[] = [
  {
    name: 'default',
    label: '快速模式',
    icon: <Icon><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" /></Icon>,
    desc: '通用循环，不挂策略',
  },
  {
    name: 'kb',
    label: '知识库模式',
    icon: <Icon><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></Icon>,
    desc: '回答前强制检索知识库',
  },
  {
    name: 'manager',
    label: 'Manager 模式',
    icon: (
      <Icon>
        <circle cx="18" cy="5" r="3" />
        <circle cx="6" cy="12" r="3" />
        <circle cx="18" cy="19" r="3" />
        <path d="m8.59 13.51 6.83 3.98" />
        <path d="m15.41 6.51 -6.82 3.98" />
      </Icon>
    ),
    desc: '子 agent 编排，复杂任务并行',
  },
  {
    name: 'worker',
    label: '打工人模式',
    icon: (
      <Icon>
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </Icon>
    ),
    desc: '真正的打工人，开工前先创建开发引导员监督',
  },
  {
    name: 'hallucination',
    label: '100% AI 模式',
    icon: (
      <Icon>
        <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z" />
      </Icon>
    ),
    desc: '万能工具幻觉世界，所有工具调用由后台 AI 圆梦',
  }
];

interface Props {
  /** 当前模式名（受控） */
  mode: string;
  /** 选中新模式（上层负责同步 agent 进程与状态） */
  onSelect: (name: string) => void;
}

export function ModeSelector({ mode, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击菜单/触发器之外关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // 打开时计算 fixed 定位坐标（右对齐触发器，向上弹出——与工作区选择器同款）
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setMenuStyle({
      position: 'fixed',
      bottom: `${window.innerHeight - rect.top + 6}px`,
      right: `${window.innerWidth - rect.right}px`,
      zIndex: 99999,
    });
  }, [open]);

  const current = MODES.find((m) => m.name === mode) ?? MODES[0];

  return (
    <span className="folder-selector">
      <span
        ref={triggerRef}
        className="ctx-folder"
        onClick={() => setOpen((v) => !v)}
        title={`当前模式：${current.label}（${current.desc}）`}
      >
        {current.icon}
        {current.label}
        <span className="dropdown-arrow">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </span>

      {open && createPortal(
        <div ref={menuRef} className="folder-menu mode-selector-menu" style={menuStyle}>
          <div className="folder-menu-section-title">选择模式</div>
          <div className="folder-menu-items">
            {MODES.map((m) => (
              <div
                key={m.name}
                className={`folder-menu-item${m.name === mode ? ' active' : ''}`}
                onClick={() => { onSelect(m.name); setOpen(false); }}
                title={m.desc}
              >
                {m.icon}
                <div className="folder-menu-item-info">
                  <span className="folder-menu-item-name">
                    {m.label}
                    {m.name === mode && <span className="folder-menu-active-tag">当前</span>}
                  </span>
                  <span className="folder-menu-item-path">{m.desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </span>
  );
}
