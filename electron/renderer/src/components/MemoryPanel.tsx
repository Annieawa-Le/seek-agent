import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import type { SidebarRuntimeData, MemoryPayloadMsg } from '@/types/index.ts';
import { splitPromptBlocks, joinPromptBlocks, extractBlockTitle, messageContentText, buildSubTree, applyNodeEdit } from '@/utils/memory-prompt-utils.ts';
import { renderMarkdown } from '@/utils/markdown.ts';
import type { PromptBlock, PromptSubNode } from '@/utils/memory-prompt-utils.ts';

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
  const [expandedSubs, setExpandedSubs] = useState<Set<string>>(new Set());
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(new Set());
  const [editMode, setEditMode] = useState(false);
  const [editingSub, setEditingSub] = useState<{ blockId: string; nodeId: string | null; start: number; end: number } | null>(null);
  const [editSubText, setEditSubText] = useState('');
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
    if (!system) { setBlocks([]); setSelected(new Set()); setExpandedSubs(new Set()); setExpandedBlocks(new Set()); setEditingSub(null); return; }
    if (dirtyRef.current) return; // 编辑中不重置，避免打断
    setBlocks(splitPromptBlocks(system));
    setSelected(new Set());
    setExpandedSubs(new Set());
    setExpandedBlocks(new Set());
    setEditingSub(null);
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
    setEditingSub(null); // 与段落编辑互斥
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

  // ── 子标题标签展开/收起 ──
  const toggleSub = (id: string) => {
    setExpandedSubs(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // ── 一级块展开/收起 ──
  const toggleBlock = (id: string) => {
    setExpandedBlocks(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };


  // ── 编辑模式：进入后点击标题管选中/多选，退出清空选择 ──
  const toggleEditMode = () => {
    setEditMode(v => !v);
    setSelected(new Set());
  };
  // ── 段落级编辑（子标题节点 / 前言正文）──
  const startEditSub = (blockId: string, nodeId: string | null, start: number, end: number, text: string) => {
    setEditingId(null); // 与整块编辑互斥
    setEditingSub({ blockId, nodeId, start, end });
    setEditSubText(text);
  };
  const saveEditSub = () => {
    if (!editingSub) return;
    const { blockId, start, end } = editingSub;
    const text = editSubText;
    setBlocks(prev => prev.map(b => {
      if (b.id !== blockId) return b;
      const content = applyNodeEdit(b.content, start, end, text);
      return { ...b, content, title: extractBlockTitle(content) };
    }));
    setDirty(true);
    setEditingSub(null);
    setEditSubText('');
  };
  const cancelEditSub = () => { setEditingSub(null); setEditSubText(''); };

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
        <span>System Prompt（{blocks.length} 条 · {editMode ? '编辑模式：点击标题选中 / Ctrl 多选 / Shift 范围 / 拖动排序' : '点击标题展开 / 双击标题编辑 / 点「编辑模式」管理选择'}）</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button style={editMode ? { ...primaryBtn, background: '#7b5ea7' } : smallBtn} onClick={toggleEditMode} title={editMode ? '退出编辑模式（清空选择）' : '进入编辑模式：点击标题可多选/拖动排序/删除'}>{editMode ? '完成' : '编辑模式'}</button>
          <button style={{ ...primaryBtn, opacity: dirty ? 1 : 0.5 }} disabled={!dirty} onClick={applyChanges} title="把编辑结果写回本地化快照，后续轮次生效">应用修改</button>
        </span>
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
        const isCollapsed = !expandedBlocks.has(block.id);
        return (
          <div
            key={block.id}
            draggable={editMode && !isEditing}
            onDragStart={e => { setDragIndex(index); e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={e => { e.preventDefault(); if (overIndex !== index) setOverIndex(index); }}
            onDragLeave={() => { if (overIndex === index) setOverIndex(null); }}
            onDrop={e => { e.preventDefault(); handleDrop(index); }}
            onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
            onClick={e => { if (editMode) toggleSelect(block.id, index, e); else toggleBlock(block.id); }}
            onDoubleClick={() => startEdit(block)}
            title={isEditing ? undefined : editMode ? `${block.title}\n拖动排序` : `${block.title}\n点击展开/收起 · 双击编辑`}
            style={{
              ...blockStyle,
              ...(isSelected ? selectedStyle : {}),
              opacity: isDragging ? 0.4 : 1,
              borderTop: isOver ? '2px solid #3370ff' : undefined,
              cursor: isEditing ? 'default' : 'pointer',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                onClick={e => { e.stopPropagation(); toggleBlock(block.id); }}
                title={isCollapsed ? '展开' : '收起'}
                style={{ display: 'inline-flex', color: '#9aa0a8', flexShrink: 0, cursor: 'pointer', transform: isCollapsed ? 'none' : 'rotate(90deg)', transition: 'transform 0.12s', padding: 2 }}
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
              </span>
              <span style={{ fontSize: 11, color: '#b0b3b8', flexShrink: 0 }}>{index + 1}</span>
              {editMode && (
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
              )}
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
            ) : isCollapsed ? null : (
              <BlockContentView blockId={block.id} content={block.content} expandedSubs={expandedSubs} onToggleSub={toggleSub} editingSub={editingSub} editSubText={editSubText} onStartEditSub={startEditSub} onSaveEditSub={saveEditSub} onCancelEditSub={cancelEditSub} onEditSubText={setEditSubText} />
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
        <span style={{ color: '#b0b3b8', flexShrink: 0, display: 'inline-flex' }}>
          {expanded ? (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15" /></svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
          )}
        </span>
      </div>
      {expanded && (
        <pre style={{ fontSize: 11, color: '#555', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '6px 0 2px', maxHeight: 240, overflow: 'auto', lineHeight: 1.5 }}>
          {summary || toolInfo || '(空内容)'}
        </pre>
      )}
    </div>
  );
}

/** 段落级编辑状态：nodeId 为 null 表示编辑前言（preamble） */
interface EditSubState {
  blockId: string;
  nodeId: string | null;
  start: number;
  end: number;
}

/**
 * 一级块内容视图：有子标题树时渲染可展开标签（正文 markdown 渲染 + 双击编辑），
 * 无子标题时整块内容按 markdown 渲染，同样支持双击编辑。
 * 块标题行已由一级标签显示，渲染前剥离首行一级标题避免重复。
 */
function BlockContentView({ blockId, content, expandedSubs, onToggleSub, editingSub, editSubText, onStartEditSub, onSaveEditSub, onCancelEditSub, onEditSubText }: {
  blockId: string;
  content: string;
  expandedSubs: Set<string>;
  onToggleSub: (id: string) => void;
  editingSub: EditSubState | null;
  editSubText: string;
  onStartEditSub: (blockId: string, nodeId: string | null, start: number, end: number, text: string) => void;
  onSaveEditSub: () => void;
  onCancelEditSub: () => void;
  onEditSubText: (t: string) => void;
}) {
  const tree = useMemo(() => buildSubTree(content), [content]);
  const isEditingPreamble = editingSub?.blockId === blockId && editingSub.nodeId === null;
  const preambleEdit = () => onStartEditSub(blockId, null, tree.preambleStart, tree.preambleEnd, tree.preamble);
  // 块标题已由一级标签行展示，正文渲染剥离首行一级标题避免重复
  const strippedPreamble = stripLeadingH1(tree.preamble);
  if (tree.nodes.length === 0) {
    const body = stripLeadingH1(tree.preamble || content);
    return (
      <div style={{ marginTop: 6 }} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
        {isEditingPreamble ? (
          <EditBox text={editSubText} onText={onEditSubText} onSave={onSaveEditSub} onCancel={onCancelEditSub} />
        ) : body.trim() ? (
          <div
            className="content"
            style={{ fontSize: 12, color: '#777', lineHeight: 1.6, cursor: 'text', maxHeight: 160, overflow: 'auto' }}
            title="双击编辑这段"
            onDoubleClick={preambleEdit}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
          />
        ) : null}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 8 }} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
      {strippedPreamble.trim() && (
        isEditingPreamble ? (
          <EditBox text={editSubText} onText={onEditSubText} onSave={onSaveEditSub} onCancel={onCancelEditSub} />
        ) : (
          <div
            className="content"
            style={{ fontSize: 12, color: '#777', lineHeight: 1.6, marginBottom: 6, padding: '6px 8px', background: '#fafafa', borderRadius: 6, cursor: 'text', maxHeight: 120, overflow: 'auto' }}
            title="双击编辑这段"
            onDoubleClick={preambleEdit}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(strippedPreamble) }}
          />
        )
      )}
      {tree.nodes.map(node => (
        <SubSectionNode key={node.id} blockId={blockId} node={node} expandedSubs={expandedSubs} onToggleSub={onToggleSub}
          editingSub={editingSub} editSubText={editSubText} onStartEditSub={onStartEditSub} onSaveEditSub={onSaveEditSub} onCancelEditSub={onCancelEditSub} onEditSubText={onEditSubText} />
      ))}
    </div>
  );
}

/** 子标题标签节点：点击展开/收起，展开后 markdown 渲染正文（双击编辑），并递归渲染更深层子标签 */
function SubSectionNode({ blockId, node, expandedSubs, onToggleSub, editingSub, editSubText, onStartEditSub, onSaveEditSub, onCancelEditSub, onEditSubText }: {
  blockId: string;
  node: PromptSubNode;
  expandedSubs: Set<string>;
  onToggleSub: (id: string) => void;
  editingSub: EditSubState | null;
  editSubText: string;
  onStartEditSub: (blockId: string, nodeId: string | null, start: number, end: number, text: string) => void;
  onSaveEditSub: () => void;
  onCancelEditSub: () => void;
  onEditSubText: (t: string) => void;
}) {
  const isOpen = expandedSubs.has(node.id);
  const body = node.lines.join('\n');
  const bodyLen = body.trim().length;
  const childCount = countSubNodes(node);
  const isEditing = editingSub?.blockId === blockId && editingSub.nodeId === node.id;
  return (
    <div>
      <div
        onClick={() => onToggleSub(node.id)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px', cursor: 'pointer', borderRadius: 4, userSelect: 'none' }}
        title={`${node.title}\n${isOpen ? '收起' : '展开'}`}
      >
        <span style={{ display: 'inline-flex', color: '#9aa0a8', flexShrink: 0, transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#444' }}>{node.title}</span>
        <span style={{ fontSize: 11, color: '#b0b3b8', flexShrink: 0 }}>
          {bodyLen > 0 ? `${bodyLen} 字符` : ''}{childCount > 0 ? `${bodyLen > 0 ? ' · ' : ''}${childCount} 子节` : ''}
        </span>
      </div>
      {isOpen && (
        <div style={{ marginLeft: 8, paddingLeft: 10, borderLeft: '1px solid #e4e7ec' }}>
          {isEditing ? (
            <EditBox text={editSubText} onText={onEditSubText} onSave={onSaveEditSub} onCancel={onCancelEditSub} />
          ) : bodyLen > 0 ? (
            <div
              className="content"
              style={{ fontSize: 12, color: '#666', lineHeight: 1.6, margin: '2px 0 6px', cursor: 'text' }}
              title="双击编辑这段"
              onDoubleClick={() => onStartEditSub(blockId, node.id, node.linesStart, node.linesEnd, body)}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
            />
          ) : null}
          {node.children.map(child => (
            <SubSectionNode key={child.id} blockId={blockId} node={child} expandedSubs={expandedSubs} onToggleSub={onToggleSub}
              editingSub={editingSub} editSubText={editSubText} onStartEditSub={onStartEditSub} onSaveEditSub={onSaveEditSub} onCancelEditSub={onCancelEditSub} onEditSubText={onEditSubText} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 段落编辑框：textarea + 保存/取消（复用整块编辑的视觉风格） */
function EditBox({ text, onText, onSave, onCancel }: {
  text: string;
  onText: (t: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div onClick={e => e.stopPropagation()} style={{ margin: '2px 0 8px' }}>
      <textarea
        value={text}
        onChange={e => onText(e.target.value)}
        rows={5}
        autoFocus
        style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 12, border: '1px solid #3370ff', borderRadius: 6, padding: 8, resize: 'vertical' }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 6, justifyContent: 'flex-end' }}>
        <button style={smallBtn} onClick={onCancel}>取消</button>
        <button style={primaryBtn} onClick={onSave}>保存段落</button>
      </div>
    </div>
  );
}

/** 递归统计节点下辖子节点总数（含间接） */
function countSubNodes(node: PromptSubNode): number {
  let n = node.children.length;
  for (const c of node.children) n += countSubNodes(c);
  return n;
}

/** 渲染正文时剥离首行一级标题（块标题已在标签行显示，避免重复渲染为 h1） */
function stripLeadingH1(text: string): string {
  const lines = text.split('\n');
  if (lines.length > 0 && /^#\s+/.test(lines[0])) {
    return lines.slice(1).join('\n').replace(/^\n+/, '');
  }
  return text;
}































