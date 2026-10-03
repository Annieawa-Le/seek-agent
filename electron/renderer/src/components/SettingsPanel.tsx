/** 插件配置项的字段声明（由插件在 enable.json 的 configSchema 里自报）。 */
export interface PluginConfigField {
  key: string;
  label: string;
  /** boolean / number / enum / skin / text */
  type?: 'boolean' | 'number' | 'enum' | 'skin' | 'text';
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  /** enum 的候选值（skin 类型的候选项由主进程动态提供） */
  values?: string[];
}

export interface PluginInfo {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  running: boolean;
  port: number;
  /** 插件自声明的配置项；空数组表示该插件没有可配项 */
  configSchema?: PluginConfigField[];
  /** 当前配置值 */
  config?: Record<string, unknown>;
}


/** 单个配置项的编辑器：按 field.type 渲染对应控件（写回由父组件统一处理）。 */
function PluginFieldEditor({
  field, value, disabled, options, onChange,
}: {
  field: PluginConfigField;
  value: unknown;
  disabled: boolean;
  /** 动态候选项（skin 等类型由主进程下发） */
  options: Array<{ value: string; label: string }>;
  onChange: (v: unknown) => void;
}) {
  const type = field.type || 'text';
  const labelRow = (
    <label style={{ display: 'block', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>
      {field.label}
      {field.hint && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> — {field.hint}</span>}
    </label>
  );

  if (type === 'boolean') {
    return (
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: disabled ? 'default' : 'pointer' }}>
          <input
            type="checkbox"
            checked={value === true || value === 'true'}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
            style={{ width: 15, height: 15, marginTop: 2, cursor: 'pointer' }}
          />
          <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            {field.label}
            {field.hint && <span style={{ color: 'var(--text-muted)' }}> — {field.hint}</span>}
          </span>
        </label>
      </div>
    );
  }

  if (type === 'number') {
    return (
      <div style={{ marginBottom: 12 }}>
        {labelRow}
        <input
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          min={field.min} max={field.max} step={field.step}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          style={{ ...inputStyle, width: 160 }}
        />
        {field.min !== undefined && field.max !== undefined && (
          <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 8 }}>{field.min} ~ {field.max}</span>
        )}
      </div>
    );
  }

  if (type === 'enum' || type === 'skin') {
    return (
      <div style={{ marginBottom: 12 }}>
        {labelRow}
        <select
          value={String(value ?? '')}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...inputStyle, width: 240 }}
        >
          {type === 'skin' && <option value="">（不使用皮肤）</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {options.length === 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 8 }}>暂无可选项</span>
        )}
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 12 }}>
      {labelRow}
      <input
        type="text"
        value={String(value ?? '')}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      />
    </div>
  );
}

/** 单张插件卡片：头部信息 + 启用开关；有配置项时可展开编辑。 */
function PluginCard({
  plugin, busy, onToggle, onSave,
}: {
  plugin: PluginInfo;
  busy: string;
  onToggle: (p: PluginInfo, next: boolean) => void;
  onSave: (p: PluginInfo, patch: Record<string, unknown>) => Promise<void>;
}) {
  const api = useElectronAPI();
  const fields = plugin.configSchema || [];
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...(plugin.config || {}) }));
  const [dirty, setDirty] = useState(false);
  // 动态候选项：skin / 未知类型在下拉前拉一次
  const [options, setOptions] = useState<Record<string, Array<{ value: string; label: string }>>>({});

  // 父组件刷新插件清单后，若本地无未保存改动，同步最新配置
  useEffect(() => {
    if (!dirty) setDraft({ ...(plugin.config || {}) });
  }, [plugin.config, dirty]);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    const need = fields.filter((f) => f.type === 'skin');
    (async () => {
      const next: Record<string, Array<{ value: string; label: string }>> = {};
      for (const f of need) {
        try {
          const res: any = await api?.getPluginFieldOptions?.(plugin.name, f.key);
          if (!cancelled && res?.ok) next[f.key] = res.options || [];
        } catch { /* 拉不到就空列表 */ }
      }
      if (!cancelled) setOptions(next);
    })();
    return () => { cancelled = true; };
  }, [expanded, api, plugin.name, fields]);

  const setField = useCallback((key: string, v: unknown) => {
    setDraft((prev) => ({ ...prev, [key]: v }));
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    // 只提交变化过的键，避免无谓写盘
    const patch: Record<string, unknown> = {};
    for (const f of fields) {
      const before = (plugin.config || {})[f.key];
      const now = draft[f.key];
      if (String(before ?? '') !== String(now ?? '')) patch[f.key] = now;
    }
    if (Object.keys(patch).length === 0) { setDirty(false); return; }
    await onSave(plugin, patch);
    setDirty(false);
  }, [fields, plugin, draft, onSave]);

  const busyKey = busy === plugin.name;
  const hasConfig = fields.length > 0;

  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, marginBottom: 12, overflow: 'hidden' }}>
      {/* 卡片头：点击展开（开关与展开互不干扰，开关点击阻止冒泡） */}
      <div
        onClick={() => hasConfig && setExpanded((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          padding: '12px 14px',
          cursor: hasConfig ? 'pointer' : 'default',
          background: expanded ? 'var(--accent-bg)' : 'transparent',
        }}
      >
        <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          {hasConfig && (
            <span style={{
              flexShrink: 0, color: 'var(--text-muted)', fontSize: 11, display: 'inline-block',
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform .15s',
            }}>▶</span>
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
              {plugin.label}
              <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>{plugin.name}</span>
              <span style={{
                fontSize: 11, padding: '1px 7px', borderRadius: 10,
                color: plugin.running ? 'var(--success)' : 'var(--text-muted)',
                background: plugin.running ? 'var(--success-bg)' : 'var(--bg-hover)',
              }}>{plugin.running ? `运行中 :${plugin.port}` : '未启动'}</span>
              {hasConfig && (
                <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>{fields.length} 项配置</span>
              )}
            </div>
            {plugin.description && !expanded && (
              <div style={{
                fontSize: 12, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.6,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 560,
              }}>{plugin.description}</div>
            )}
          </div>
        </div>
        <label
          onClick={(e) => e.stopPropagation()}
          style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, cursor: 'pointer' }}
        >
          <input
            type="checkbox"
            checked={plugin.enabled}
            disabled={busyKey}
            onChange={(e) => onToggle(plugin, e.target.checked)}
            style={{ width: 16, height: 16, cursor: 'pointer' }}
          />
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{plugin.enabled ? '已启用' : '已禁用'}</span>
        </label>
      </div>

      {/* 卡片体：展开后的配置区 */}
      {expanded && hasConfig && (
        <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '14px 16px', background: 'var(--bg-elevated)' }}>
          {plugin.description && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.7 }}>{plugin.description}</div>
          )}
          {fields.map((f) => (
            <PluginFieldEditor
              key={f.key}
              field={f}
              value={draft[f.key]}
              disabled={busyKey}
              options={f.type === 'skin' ? (options[f.key] || []) : (f.values || []).map((v) => ({ value: v, label: v }))}
              onChange={(v) => setField(f.key, v)}
            />
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
            <button
              type="button"
              onClick={save}
              disabled={!dirty || busyKey}
              style={{
                ...smallBtnStyle,
                color: dirty ? 'var(--bg-base)' : 'var(--text-muted)',
                background: dirty ? 'var(--accent)' : 'var(--bg-hover)',
                borderColor: dirty ? 'var(--accent)' : 'var(--border-default)',
                cursor: dirty ? 'pointer' : 'default',
              }}
            >{busyKey ? '保存中…' : '保存'}</button>
            {dirty && (
              <button
                type="button"
                onClick={() => { setDraft({ ...(plugin.config || {}) }); setDirty(false); }}
                style={smallBtnStyle}
              >撤销</button>
            )}
            {!dirty && <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>改动后点保存</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 插件板块：每插件一张可展开卡片（头部 = 身份/状态/开关，展开 = 该插件的配置项）。
 *
 * 配置项不是前端硬编码的——插件在 enable.json 里自报 configSchema，这里按 schema 渲染。
 * 新增插件要加配置，只需在自己的 enable.json 里声明字段，前端零改动。
 */
function PluginsSection() {
  const api = useElectronAPI();
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api?.getPlugins?.()
      .then((list) => setPlugins(list || []))
      .catch(() => { /* 读取失败保持空列表 */ });
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const toggle = useCallback(async (p: PluginInfo, next: boolean) => {
    setBusy(p.name);
    setNotice('');
    setError('');
    try {
      const res: any = await api?.setPluginEnabled?.(p.name, next);
      if (res?.ok) {
        setPlugins(res.plugins || []);
        setNotice(`「${p.label}」已${next ? '启用' : '禁用'}，重启 seek-agent 生效`);
      } else {
        setError(res?.error || '操作失败');
      }
    } catch (e: any) {
      setError(e?.message || '操作失败');
    } finally {
      setBusy('');
    }
  }, [api]);

  // 统一配置写入：主进程按插件声明的 schema 校验与夹取，并按插件分派热应用
  const saveConfig = useCallback(async (p: PluginInfo, patch: Record<string, unknown>) => {
    setBusy(p.name);
    setNotice('');
    setError('');
    try {
      const res: any = await api?.setPluginConfig?.(p.name, patch);
      if (res?.ok) {
        setPlugins(res.plugins || []);
        setNotice(res.restartRequired
          ? `「${p.label}」配置已保存，重启 seek-agent 生效`
          : `「${p.label}」配置已保存并立即生效`);
      } else {
        setError(res?.error || '保存失败');
      }
    } catch (e: any) {
      setError(e?.message || '保存失败');
    } finally {
      setBusy('');
    }
  }, [api]);

  if (plugins.length === 0) {
    return <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>没有可管理的挂件插件。</div>;
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.7 }}>
        挂件插件由 Electron 主进程托管：开关与配置写回各自 inner_skill 目录下的 enable.json。
        点击卡片可展开该插件的配置项（配置项由插件自行声明，这里按声明渲染）。
      </div>
      {plugins.map((p) => (
        <PluginCard key={p.name} plugin={p} busy={busy} onToggle={toggle} onSave={saveConfig} />
      ))}
      {notice && <div style={{ color: 'var(--success)', fontSize: 13, marginTop: 4 }}>{notice}</div>}
      {error && <div style={{ color: 'var(--danger)', fontSize: 13, marginTop: 4 }}>{error}</div>}
    </div>
  );
}

// WebUI 设置面板（VSCode 式叠加窗口），配置 seek-agent/.env 各项
// 独立组件：仅负责展示与编辑 .env 配置项，接线（Header 入口）由后续任务完成。
import { useEffect, useState, useCallback } from 'react';
import type { CSSProperties } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import { listSettingsSections, type SettingsSection } from '@/utils/settings-extension.ts';

interface Props { onClose: () => void; }
/**
 * 插件栏目的分组 key 前缀。
 * 插件 label 可能与内置分组重名（如两份「主题」），加前缀与内置分组彻底隔开——
 * 左列显示的是 label（无前缀），只有内部 key 带前缀。
 */
const PLUGIN_GROUP_PREFIX = 'plugin:';

/**
 * 插件栏目宿主：只负责挂载插件返回的 ReactNode，并兜住插件渲染异常。
 * 插件渲染炸了不该让设置面板白屏——捕获后展示降级提示，其余分组照常可用。
 */
function PluginSectionHost({ section }: { section: SettingsSection }) {
  let content: React.ReactNode = null;
  let failed = '';
  try {
    content = section.render();
  } catch (e: any) {
    failed = e?.message || String(e);
  }
  if (failed) {
    return (
      <div style={{ fontSize: 13, color: 'var(--danger)', lineHeight: 1.7 }}>
        栏目「{section.label}」渲染失败：{failed}
      </div>
    );
  }
  return <>{content}</>;
}


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
  { name: '插件', fields: [] },
  { name: '远程连接', fields: [
    { key: 'SEEK_RELAY_URL', label: '中继地址 (SEEK_RELAY_URL)' },
    { key: 'SEEK_DEVICE_ID', label: '设备 ID (SEEK_DEVICE_ID)' },
    { key: 'SEEK_RELAY_TOKEN', label: '中继 Token', type: 'password' },
  ]},
  { name: '其他', fields: [
    { key: 'PROMPT_LOCALIZATION', label: 'Prompt 本地化', type: 'checkbox', hint: '开启后会话不再自动注入动态组装的系统 Prompt，改用最近一次 payload 快照（系统 Prompt + 工具 + 工作区信息固定不变）。重启 seek-agent 生效。' },
    { key: 'ACTION_MEMORY_ENABLED', label: '行为记忆训练', type: 'checkbox', hint: '开启后每累计 5 次工具调用，后台把调用窗口交给行为蒸馏师提炼行为经验；行为池满 10 条后由整理师合并进 ACTION.md 并注入主模型系统 Prompt。重启 seek-agent 生效。' },
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
  border: '1px solid var(--border-default)',
  borderRadius: 6,
  fontFamily: 'inherit',
  fontSize: 13,
  boxSizing: 'border-box',
  color: 'var(--text-primary)',
  background: 'var(--bg-base)',
};

const smallBtnStyle: CSSProperties = {
  border: '1px solid var(--border-default)',
  background: 'var(--bg-surface)',
  color: 'var(--text-secondary)',
  borderRadius: 6,
  padding: '8px 12px',
  cursor: 'pointer',
  fontSize: 12,
  flexShrink: 0,
};

export function SettingsPanel({ onClose }: Props) {
  const api = useElectronAPI();

  const [activeGroup, setActiveGroup] = useState('模型');
  /** 插件贡献的设置栏目（dsh-theme 的「主题」等）；无插件时为空数组，走零开销原路径 */
  const [pluginSections, setPluginSections] = useState<SettingsSection[]>(() => listSettingsSections());
  const [values, setValues] = useState<Record<string, string>>({});
  const [envPath, setEnvPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [errMsg, setErrMsg] = useState('');
  const [showPwd, setShowPwd] = useState(false);

  /**
   * 订阅插件栏目：插件可能在面板已打开后才注册（注入时序不定），
   * 故除初次快照外还监听扩展点的就绪/变更事件，保证栏目一注册就出现。
   */
  useEffect(() => {
    const refresh = () => setPluginSections(listSettingsSections());
    refresh();
    window.addEventListener('seek:settings-extension-ready', refresh);
    return () => window.removeEventListener('seek:settings-extension-ready', refresh);
  }, []);

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
          background: 'var(--bg-elevated)', borderRadius: 10,
          boxShadow: '0 8px 40px rgba(0,0,0,0.3)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          animation: 'sp-pop-in 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)',
        }}
      >
        {/* 顶部条：标题 + envPath 副标题 + 关闭按钮 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>设置</div>
            {envPath && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, maxWidth: 560, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{envPath}</div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 20, color: 'var(--text-muted)', lineHeight: 1, padding: '2px 6px' }}
          >×</button>
        </div>

        {/* 主体：左列分组 + 右列表单 */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div style={{ width: 160, borderRight: '1px solid var(--border-subtle)', padding: '10px 0', overflow: 'auto', flexShrink: 0 }}>
            {/* 内置分组 + 插件贡献栏目（后者用分隔线视觉区分） */}
            {GROUPS.map(g => {
              const active = g.name === activeGroup;
              return (
                <div
                  key={g.name}
                  onClick={() => setActiveGroup(g.name)}
                  style={{
                    padding: '9px 16px', cursor: 'pointer', fontSize: 14,
                    color: active ? 'var(--accent)' : 'var(--text-secondary)',
                    background: active ? 'var(--accent-bg)' : 'transparent',
                    fontWeight: active ? 600 : 400,
                    borderLeft: active ? '3px solid var(--accent)' : '3px solid transparent',
                    transition: 'background 0.15s, color 0.15s',
                  }}
                >{g.name}</div>
              );
            })}
            {pluginSections.length > 0 && <div style={{ height: 1, background: 'var(--border-subtle)', margin: '8px 12px' }} />}
            {pluginSections.map(s => {
              const active = PLUGIN_GROUP_PREFIX + s.id === activeGroup;
              return (
                <div
                  key={s.id}
                  onClick={() => setActiveGroup(PLUGIN_GROUP_PREFIX + s.id)}
                  style={{
                    padding: '9px 16px', cursor: 'pointer', fontSize: 14,
                    color: active ? 'var(--accent)' : 'var(--text-secondary)',
                    background: active ? 'var(--accent-bg)' : 'transparent',
                    fontWeight: active ? 600 : 400,
                    borderLeft: active ? '3px solid var(--accent)' : '3px solid transparent',
                    transition: 'background 0.15s, color 0.15s',
                  }}
                >{s.label}</div>
              );
            })}
          </div>

          <div key={activeGroup} style={{ flex: 1, overflow: 'auto', padding: '16px 20px', animation: 'sp-slide-in 0.18s ease-out' }}>
            {/* 插件栏目优先分派：group key 带前缀，避免与内置分组同名冲突 */}
            {pluginSections.find(s => PLUGIN_GROUP_PREFIX + s.id === activeGroup)
              ? <PluginSectionHost section={pluginSections.find(s => PLUGIN_GROUP_PREFIX + s.id === activeGroup)!} />
              : null}
            {activeGroup === '插件' ? <PluginsSection /> : null}
            {activeFields.map(field => (
              <div key={field.key} style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>
                  {field.label}
                  <span style={{ color: 'var(--text-dim)', marginLeft: 8, fontSize: 12 }}>{field.key}</span>
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
                      {field.hint && <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>{field.hint}</span>}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: '1px solid var(--border-subtle)' }}>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            style={{
              background: 'var(--accent)', color: 'var(--bg-base)', border: 'none', borderRadius: 6,
              padding: '8px 20px', fontSize: 14,
              cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1,
            }}
          >{saving ? '保存中…' : '保存'}</button>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'var(--bg-surface)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)', borderRadius: 6, padding: '8px 20px', fontSize: 14, cursor: 'pointer' }}
          >取消</button>
          {savedMsg && <span style={{ color: 'var(--success)', fontSize: 13 }}>{savedMsg}</span>}
          {errMsg && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{errMsg}</span>}
        </div>
      </div>
      </div>
    </>
  );
}



























