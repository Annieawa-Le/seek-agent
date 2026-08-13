// WebUI 设置面板（VSCode 式叠加窗口），配置 seek-agent/.env 各项
// 独立组件：仅负责展示与编辑 .env 配置项，接线（Header 入口）由后续任务完成。
import { useEffect, useState, useCallback } from 'react';
import type { CSSProperties } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';

interface Props { onClose: () => void; }

// 分组 schema：key 必须是真实 .env 变量名
const GROUPS: Array<{ name: string; fields: Array<{ key: string; label: string; type?: 'text'|'password'|'number'|'checkbox'; options?: string[]; hint?: string }> }> = [
  { name: '模型', fields: [
    { key: 'OPENAI_BASE_URL', label: 'OpenAI Base URL' },
    { key: 'OPENAI_API_KEY', label: 'OpenAI API Key', type: 'password' },
    { key: 'OPENAI_MODEL', label: 'OpenAI Model' },
    { key: 'LITE_MODEL', label: '轻量模型' },
    { key: 'LITE_MODEL_BASE_URL', label: '轻量模型 Base URL' },
    { key: 'LITE_MODEL_API_KEY', label: '轻量模型 API Key', type: 'password' },
    { key: 'IMAGE_BASE_URL', label: '视觉模型 Base URL' },
    { key: 'IMAGE_API_KEY', label: '视觉模型 API Key', type: 'password' },
    { key: 'IMAGE_MODEL', label: '视觉模型' },
  ]},
  { name: '知识库', fields: [
    { key: 'KB_STORE', label: '存储后端', options: ['json','sqlite','postgres'] },
    { key: 'EMBEDDING_BASE_URL', label: 'Embedding Base URL' },
    { key: 'EMBEDDING_API_KEY', label: 'Embedding API Key', type: 'password' },
    { key: 'EMBEDDING_MODEL', label: 'Embedding 模型' },
    { key: 'EMBEDDING_DIM', label: '向量维度', type: 'number' },
    { key: 'PG_URL', label: 'PostgreSQL URL' },
  ]},
  { name: '上下文', fields: [
    { key: 'MAX_CONTEXT_TOKENS', label: '最大上下文 Tokens', type: 'number' },
    { key: 'COMPRESS_TARGET_RATIO', label: '压缩目标比例', type: 'number' },
    { key: 'ROUND_RATIO_THRESHOLD', label: '轮次比例阈值', type: 'number' },
  ]},
  { name: '远程连接', fields: [
    { key: 'SEEK_RELAY_URL', label: '中继地址 (SEEK_RELAY_URL)' },
    { key: 'SEEK_DEVICE_ID', label: '设备 ID (SEEK_DEVICE_ID)' },
    { key: 'SEEK_RELAY_TOKEN', label: '中继 Token', type: 'password' },
  ]},
  { name: '其他', fields: [
    { key: 'PROMPT_LOCALIZATION', label: 'Prompt 本地化', type: 'checkbox', hint: '开启后会话不再自动注入动态组装的系统 Prompt，改用最近一次 payload 快照（系统 Prompt + 工具 + 工作区信息固定不变）。重启 seek-agent 生效。' },
    { key: 'TAVILY_API_KEY', label: 'Tavily API Key', type: 'password' },
    { key: 'GITHUB_TOKEN', label: 'GitHub Token', type: 'password' },
  ]},
];

// schema 中全部 key 的扁平列表（用于挂载填充与保存收集）
const ALL_KEYS: string[] = GROUPS.flatMap(g => g.fields.map(f => f.key));
// schema 中全部字段（含类型，用于 checkbox 的保存收集）
const ALL_FIELDS = GROUPS.flatMap(g => g.fields);

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  border: '1px solid #d0d3d6',
  borderRadius: 6,
  fontFamily: 'inherit',
  fontSize: 13,
  boxSizing: 'border-box',
  color: '#1f2328',
};

const smallBtnStyle: CSSProperties = {
  border: '1px solid #d0d3d6',
  background: '#fff',
  color: '#444',
  borderRadius: 6,
  padding: '8px 12px',
  cursor: 'pointer',
  fontSize: 12,
  flexShrink: 0,
};

export function SettingsPanel({ onClose }: Props) {
  const api = useElectronAPI();

  const [activeGroup, setActiveGroup] = useState('模型');
  const [values, setValues] = useState<Record<string, string>>({});
  const [envPath, setEnvPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [errMsg, setErrMsg] = useState('');
  const [showPwd, setShowPwd] = useState(false);

  // 挂载时读取 .env 配置，仅用 schema 中的 key 填充 values
  useEffect(() => {
    let cancelled = false;
    api?.getEnvConfig?.()
      .then((res: any) => {
        if (cancelled || !res) return;
        const items = res.items;
        if (items && Array.isArray(items)) {
          const itemMap = new Map<string, string>();
          items.forEach((it: { key?: string; value?: string }) => {
            if (it && typeof it.key === 'string') itemMap.set(it.key, String(it.value ?? ''));
          });
          const next: Record<string, string> = {};
          ALL_KEYS.forEach(key => {
            const v = itemMap.get(key);
            if (v !== undefined && v !== null) next[key] = v;
          });
          setValues(next);
        }
        const p = res.envPath || res.path;
        if (p) setEnvPath(p);
      })
      .catch(() => {/* 读取失败保持空表单 */});
    return () => { cancelled = true; };
  }, [api]);

  // ESC 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleChange = useCallback((key: string, v: string) => {
    setValues(prev => ({ ...prev, [key]: v }));
    setSavedMsg('');
    setErrMsg('');
  }, []);

  // 收集 schema 中 values 非空（trim）的更新项保存；checkbox 始终提交（勾选→true，取消→空串写 KEY= 关闭）
  const handleSave = useCallback(async () => {
    setSaving(true);
    setSavedMsg('');
    setErrMsg('');
    try {
      const updates: Array<{ key: string; value: string }> = [];
      ALL_KEYS.forEach(key => {
        const field = ALL_FIELDS.find(f => f.key === key);
        if (field?.type === 'checkbox') {
          updates.push({ key, value: values[key] === 'true' ? 'true' : '' });
          return;
        }
        const v = (values[key] ?? '').trim();
        if (v) updates.push({ key, value: v });
      });
      await api?.saveEnvConfig?.(updates);
      setSavedMsg('已保存，重启 seek-agent 生效');
    } catch (e: any) {
      setErrMsg(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }, [api, values]);

  const activeFields = GROUPS.find(g => g.name === activeGroup)?.fields ?? [];

  return (
    <>
      <style>{`
        @keyframes sp-fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes sp-pop-in { from { opacity: 0; transform: translateY(14px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes sp-slide-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
      <div
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          animation: 'sp-fade-in 0.18s ease-out',
        }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
      <div
        style={{
          width: 720, maxWidth: '92vw', height: 'min(620px, 80vh)',
          background: '#fff', borderRadius: 10,
          boxShadow: '0 8px 40px rgba(0,0,0,0.3)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          animation: 'sp-pop-in 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)',
        }}
      >
        {/* 顶部条：标题 + envPath 副标题 + 关闭按钮 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid #e5e7eb' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#1f2328' }}>设置</div>
            {envPath && (
              <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 2, maxWidth: 560, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{envPath}</div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 20, color: '#8c8c8c', lineHeight: 1, padding: '2px 6px' }}
          >×</button>
        </div>

        {/* 主体：左列分组 + 右列表单 */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div style={{ width: 160, borderRight: '1px solid #e5e7eb', padding: '10px 0', overflow: 'auto', flexShrink: 0 }}>
            {GROUPS.map(g => {
              const active = g.name === activeGroup;
              return (
                <div
                  key={g.name}
                  onClick={() => setActiveGroup(g.name)}
                  style={{
                    padding: '9px 16px', cursor: 'pointer', fontSize: 14,
                    color: active ? '#3370ff' : '#444',
                    background: active ? '#e8f0ff' : 'transparent',
                    fontWeight: active ? 600 : 400,
                    borderLeft: active ? '3px solid #3370ff' : '3px solid transparent',
                    transition: 'background 0.15s, color 0.15s',
                  }}
                >{g.name}</div>
              );
            })}
          </div>

          <div key={activeGroup} style={{ flex: 1, overflow: 'auto', padding: '16px 20px', animation: 'sp-slide-in 0.18s ease-out' }}>
            {activeFields.map(field => (
              <div key={field.key} style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, color: '#444', marginBottom: 6 }}>
                  {field.label}
                  <span style={{ color: '#b0b3b8', marginLeft: 8, fontSize: 12 }}>{field.key}</span>
                </label>
                {field.type === 'checkbox' ? (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <input
                        type="checkbox"
                        id={'sp-' + field.key}
                        checked={values[field.key] === 'true'}
                        onChange={e => handleChange(field.key, e.target.checked ? 'true' : '')}
                        style={{ width: 16, height: 16, cursor: 'pointer', flexShrink: 0 }}
                      />
                      {field.hint && <span style={{ fontSize: 12, color: '#8c8c8c', lineHeight: 1.6 }}>{field.hint}</span>}
                    </div>
                  </div>
                ) : field.options ? (
                  <select
                    value={values[field.key] ?? ''}
                    onChange={e => handleChange(field.key, e.target.value)}
                    style={{ ...inputStyle }}
                  >
                    <option value="">（未设置）</option>
                    {field.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type={field.type === 'password' && !showPwd ? 'password' : field.type === 'number' ? 'number' : 'text'}
                      value={values[field.key] ?? ''}
                      onChange={e => handleChange(field.key, e.target.value)}
                      placeholder={field.type === 'password' ? '••••••••' : ''}
                      style={{ ...inputStyle, flex: 1 }}
                    />
                    {field.type === 'password' && (
                      <button type="button" onClick={() => setShowPwd(v => !v)} style={{ ...smallBtnStyle }}>
                        {showPwd ? '隐藏' : '显示'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 底部条：保存 / 取消 + 提示信息 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: '1px solid #e5e7eb' }}>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            style={{
              background: '#3370ff', color: '#fff', border: 'none', borderRadius: 6,
              padding: '8px 20px', fontSize: 14,
              cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1,
            }}
          >{saving ? '保存中…' : '保存'}</button>
          <button
            type="button"
            onClick={onClose}
            style={{ background: '#fff', color: '#444', border: '1px solid #d0d3d6', borderRadius: 6, padding: '8px 20px', fontSize: 14, cursor: 'pointer' }}
          >取消</button>
          {savedMsg && <span style={{ color: '#2e7d32', fontSize: 13 }}>{savedMsg}</span>}
          {errMsg && <span style={{ color: '#d93026', fontSize: 13 }}>{errMsg}</span>}
        </div>
      </div>
      </div>
    </>
  );
}





















