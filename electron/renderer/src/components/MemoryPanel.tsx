import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import type { SidebarRuntimeData, MemoryPayloadMsg } from '@/types/index.ts';
import { splitPromptBlocks, joinPromptBlocks, extractBlockTitle, messageContentText } from '@/utils/memory-prompt-utils.ts';
import type { PromptBlock } from '@/utils/memory-prompt-utils.ts';

const roleLabel: Record<string, string> = { user: '用户', assistant: '助手', tool: '工具', system: '系统' };
const roleColor: Record<string, string> = { user: '#3370ff', assistant: '#2e7d32', tool: '#b26a00', system: '#7b5ea7' };

const blockStyle: CSSProperties = {
  border: '1px solid #e0e3e8', borderRadius: 8, padding: '10px 12px', marginBottom: 8,
  background: '#fff', cursor: 'pointer', transition: 'border-color 0.15s, background 0.15s',
};
const selectedStyle: CSSProperties = {
  borderColor: '#3370ff', background: '#eef4ff',
};
const sectionTitleStyle: CSSProperties = {
  fontSize: 12, fontWeight: 600, color: '#666', margin: '14px 0 8px',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
};
const smallBtn: CSSProperties = {
  border: '1px solid #d0d3d6', background: '#fff', color: '#444', borderRadius: 6,
  padding: '4px 10px', cursor: 'pointer', fontSize: 12, flexShrink: 0,
};
const primaryBtn: CSSProperties = {
  border: 'none', background: '#3370ff', color: '#fff', borderRadius: 6,
  padding: '5px 14px', cursor: 'pointer', fontSize: 12, flexShrink: 0,
};

export function MemoryPanel({ runtimeData }: { runtimeData: SidebarRuntimeData | null }) {
  const api = useElectronAPI();
  const enabled = !!runtimeData?.promptLocalization;
  const memory = runtimeData?.memory;

  const [blocks, setBlocks] = useState<PromptBlock[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [expandedMsg, setExpandedMsg] = useState<number | null>(null);
  const [savedMsg, setSavedMsg] = useState('');
  const lastSelectedRef = useRef<number>(-1);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  // 打开面板时立即拉取最新 payload 快照（轮询之外的一次主动刷新）
  useEffect(() => {
    api.sendCommand('sidebar:data');
  }, [api]);

  const system = memory?.system ?? null;
  const blocksJoined = useMemo(() => (blocks.length > 0 ? joinPromptBlocks(blocks) : null), [blocks]);

  // 外部刷新（轮询推回 / 保存后推回）：仅当无本地未保存修改时跟随推送重新分块
  useEffect(() => {
    if (!system) { setBlocks([]); setSelected(new Set()); return; }
    if (dirtyRef.current) return; // 编辑中不重置，避免打断
    setBlocks(splitPromptBlocks(system));
    setSelected(new Set());
  }, [system]);

  // 应用修改：本地重组 → 写回 agent → 标记已保存（推回后 effect 会用新 system 重新分块，顺序一致）
  const applyChanges = () => {
    if (!blocksJoined || !dirty) return;
    api.sendCommand(`memory:save ${JSON.stringify({ system: blocksJoined })}`);
    setDirty(false);
    setSavedMsg('已应用，后续轮次生效');
    setEditingId(null);
    setTimeout(() => setSavedMsg(''), 4000);
  };

  const toggleSelect = (id: string, index: number, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      setSelected(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
    } else if (e.shiftKey && lastSelectedRef.current >= 0) {
      const [a, b] = [lastSelectedRef.current, index].sort((x, y) => x - y);
      setSelected(new Set(blocks.slice(a, b + 1).map(bk => bk.id)));
    } else {
      setSelected(new Set([id]));
    }
    lastSelectedRef.current = index;
  };

  // ── 拖动排序 ──
  const handleDrop = (targetIndex: number) => {
    if (dragIndex === null || dragIndex === targetIndex) { setDragIndex(null); setOverIndex(null); return; }
    setBlocks(prev => {
      const next = [...prev];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
    setDirty(true);
    setDragIndex(null);
    setOverIndex(null);
  };

  // ── 编辑条目 ──
  const startEdit = (block: PromptBlock) => {
    setEditingId(block.id);
    setEditText(block.content);
  };
  const saveEdit = () => {
    if (!editingId) return;
    const text = editText.trim();
    if (!text) { setEditingId(null); return; }
    setBlocks(prev => prev.map(b => b.id === editingId ? { ...b, content: text, title: extractBlockTitle(text) } : b));
    setDirty(true);
    setEditingId(null);
  };

  // ── 多选操作 ──
  const deleteSelected = () => {
    if (selected.size === 0) return;
    setBlocks(prev => prev.filter(b => !selected.has(b.id)));
    setSelected(new Set());
    setDirty(true);
  };
  const copySelected = async () => {
    if (selected.size === 0) return;
    const text = blocks.filter(b => selected.has(b.id)).map(b => b.content).join('\n\n');
    try { await navigator.clipboard.writeText(text); setSavedMsg('已复制'); setTimeout(() => setSavedMsg(''), 2000); } catch { /* 剪贴板不可用 */ }
  };

  if (!enabled) {
    return (
      <div className="panel-empty" style={{ padding: 20, lineHeight: 1.8, color: '#888' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#666', marginBottom: 8 }}>记忆面板</div>
        <div>Prompt 本地化未开启，记忆面板不可用。</div>
        <div style={{ fontSize: 12 }}>请在设置 → 其他 → Prompt 本地化 勾选后重启 seek-agent 生效。</div>
      </div>
    );
  }

  if (!memory) {
    return <div className="panel-empty">暂无 payload 快照：先发送一轮消息建立本地化快照</div>;
  }

  return (
    <div style={{ padding: '4px 12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: '#999' }}>
          快照时间：{new Date(memory.ts).toLocaleString('zh-CN', { hour12: false })}
        </span>
        <span style={{ fontSize: 12, color: '#2e7d32' }}>{savedMsg}</span>
      </div>

      {/* ── System Prompt 分块条目 ── */}
      <div style={sectionTitleStyle}>
        <span>System Prompt（{blocks.length} 条 · 点击选中 / Ctrl 多选 / Shift 范围 / 拖动排序 / 双击编辑）</span>
        <button style={{ ...primaryBtn, opacity: dirty ? 1 : 0.5 }} disabled={!dirty} onClick={applyChanges} title="把编辑结果写回本地化快照，后续轮次生效">应用修改</button>
      </div>

      {selected.size > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#666' }}>已选 {selected.size} 条：</span>
          <button style={smallBtn} onClick={deleteSelected}>删除选中</button>
          <button style={smallBtn} onClick={copySelected}>复制选中</button>
          <button style={smallBtn} onClick={() => setSelected(new Set(blocks.map(b => b.id)))}>全选</button>
          <button style={smallBtn} onClick={() => setSelected(new Set())}>取消选择</button>
        </div>
      )}

      {blocks.map((block, index) => {
        const isSelected = selected.has(block.id);
        const isEditing = editingId === block.id;
        const isDragging = dragIndex === index;
        const isOver = overIndex === index && dragIndex !== null && dragIndex !== index;
        return (
          <div
            key={block.id}
            draggable={!isEditing}
            onDragStart={e => { setDragIndex(index); e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={e => { e.preventDefault(); if (overIndex !== index) setOverIndex(index); }}
            onDragLeave={() => { if (overIndex === index) setOverIndex(null); }}
            onDrop={e => { e.preventDefault(); handleDrop(index); }}
            onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
            onClick={e => toggleSelect(block.id, index, e)}
            onDoubleClick={() => startEdit(block)}
            title={isEditing ? undefined : `${block.title}\n双击编辑`}
            style={{
              ...blockStyle,
              ...(isSelected ? selectedStyle : {}),
              opacity: isDragging ? 0.4 : 1,
              borderTop: isOver ? '2px solid #3370ff' : undefined,
              cursor: isEditing ? 'default' : 'grab',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: '#b0b3b8', flexShrink: 0 }}>{index + 1}</span>
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => {
                  setSelected(prev => {
                    const next = new Set(prev);
                    if (next.has(block.id)) next.delete(block.id); else next.add(block.id);
                    return next;
                  });
                }}
                onClick={e => e.stopPropagation()}
                style={{ width: 13, height: 13, flexShrink: 0, cursor: 'pointer' }}
              />
              <span style={{ fontSize: 13, fontWeight: 600, color: '#333', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {block.title}
              </span>
              <span style={{ fontSize: 11, color: '#b0b3b8', flexShrink: 0 }}>{block.content.length} 字符</span>
            </div>
            {isEditing ? (
              <div style={{ marginTop: 8 }} onClick={e => e.stopPropagation()}>
                <textarea
                  value={editText}
                  onChange={e => setEditText(e.target.value)}
                  rows={6}
                  autoFocus
                  style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 12, border: '1px solid #3370ff', borderRadius: 6, padding: 8, resize: 'vertical' }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 6, justifyContent: 'flex-end' }}>
                  <button style={smallBtn} onClick={() => setEditingId(null)}>取消</button>
                  <button style={primaryBtn} onClick={saveEdit}>保存条目</button>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: '#777', marginTop: 6, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 88, overflow: 'hidden' }}>
                {block.content}
              </div>
            )}
          </div>
        );
      })}

      {/* ── 全部消息 ── */}
      <div style={{ ...sectionTitleStyle, marginTop: 20 }}>
        <span>全部消息（{memory.messages.length} 条 · 点击展开/收起）</span>
      </div>
      <div style={{ border: '1px solid #e0e3e8', borderRadius: 8, background: '#fff' }}>
        {memory.messages.length === 0 && <div className="panel-empty">暂无消息</div>}
        {memory.messages.map((msg, i) => (
          <MessageRow key={i} msg={msg} index={i} expanded={expandedMsg === i} onToggle={() => setExpandedMsg(expandedMsg === i ? null : i)} />
        ))}
      </div>
    </div>
  );
}

function MessageRow({ msg, index, expanded, onToggle }: {
  msg: MemoryPayloadMsg;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const label = roleLabel[msg.role] || msg.role;
  const color = roleColor[msg.role] || '#666';
  const summary = messageContentText(msg);
  const toolInfo = msg.toolName ? ` · ${msg.toolName}` : '';
  const shown = summary.length > 160 ? `${summary.slice(0, 160)}…` : summary;
  return (
    <div style={{ borderBottom: '1px solid #f0f1f4', padding: '7px 10px', cursor: 'pointer' }} onClick={onToggle} title={expanded ? '收起' : '展开完整内容'}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, color: color, fontWeight: 600, background: `${color}1a`, borderRadius: 4, padding: '1px 6px', flexShrink: 0 }}>{label}</span>
        {msg.toolName && <span style={{ fontSize: 11, color: '#b26a00', flexShrink: 0 }}>{msg.toolName}</span>}
        <span style={{ fontSize: 11, color: '#b0b3b8', flexShrink: 0 }}>#{index + 1}</span>
        <span style={{ fontSize: 11, color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {expanded ? '' : shown || toolInfo || `(${typeof msg.content === 'object' ? '结构化内容' : '空'})`}
        </span>
        <span style={{ fontSize: 10, color: '#b0b3b8', flexShrink: 0 }}>{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <pre style={{ fontSize: 11, color: '#555', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '6px 0 2px', maxHeight: 240, overflow: 'auto', lineHeight: 1.5 }}>
          {summary || toolInfo || '(空内容)'}
        </pre>
      )}
    </div>
  );
}




