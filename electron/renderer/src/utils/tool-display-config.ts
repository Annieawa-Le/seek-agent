/**
 * 工具调用显示名配置（通用覆盖机制）
 * ─────────────────────────────────────────
 * 想修改某个工具在 WebUI 里的显示名，只需在此文件加一条配置：
 *
 *   my_tool: { template: 'my_tool {fieldA} → {fieldB}' }
 *
 * 渲染时会从工具调用的参数 JSON 中取出对应字段填入 {占位符}。
 * 字段缺失时，该占位符连同前面的分隔符一起被移除（不显示空段）。
 * 未配置的工具保持原名展示（如 read_lines 直接显示 read_lines），
 * 因此只需为想美化显示的工具添加配置，其余自动回退。
 *
 * 预置了常用核心工具与 inner_skill 工具的规则，可按需增删改。
 */

export interface ToolDisplayRule {
  /** 显示模板：{fieldName} 会被替换为工具参数中对应字段的值（值超 40 字符自动截断） */
  template: string;
}

export const TOOL_DISPLAY_CONFIG: Record<string, ToolDisplayRule> = {
  // ── 文件读写 ──
  read_file: { template: '读取： {filePath}' },
  read_lines: { template: '读取： {filePath}:{startLine}-{endLine}' },
  scan_file: { template: '扫描文件： {filePath}' },
  create_file: { template: '创建文件： {filePath}' },
  replace_file: { template: '覆写文件： {filePath}' },

  // ── Patch ──
  add_patch: { template: '写入行（{filePath}）' },
  del_patch: { template: '删除行（{filePath}）' },
  modify_patch: { template: '修改行： {filePath}:{startLine}-{endLine}' },

  // ── 搜索 ──
  search_all_file: { template: '搜索所有名为 {fileName} 的文件 @ {filePath}' },
  search_sub_file: { template: '搜索子文件 {fileName} @ {filePath}' },
  search_directory: { template: '搜索目录 {filePath}' },
  search_content: { template: '在 {filePath} 中搜索文件 {content}' },

  // ── 命令 ──
  execute_command: { template: '执行命令 {command}' },

  // ── 记忆 / 待办 ──
  memory_add: { template: 'memory_add {content}' },
  create_todo: { template: 'create_todo {name}' },
  read_todo: { template: 'read_todo {name}' },

  // ── 浏览器 ──
  browser_launch: { template: 'browser_launch {channel}' },
  browser_navigate: { template: 'browser_navigate {url}' },
  browser_click: { template: 'browser_click {selector}' },
  browser_type: { template: 'browser_type {selector}' },
  browser_press: { template: 'browser_press {key}' },
  browser_wait: { template: 'browser_wait {selector}' },
  browser_extract: { template: 'browser_extract {mode}' },
  browser_scroll: { template: 'browser_scroll {direction}' },
  browser_screenshot: { template: 'browser_screenshot {path}' },

  // ── 网页 / 搜索 ──
  search_web: { template: 'search_web {query}' },
  fetch_page: { template: 'fetch_page {url}' },
  crawl_site: { template: 'crawl_site {url}' },
  extract_links: { template: 'extract_links {url}' },
  tavily_search: { template: 'tavily_search {query}' },

  // ── 子模型编排 ──
  spawn_agent: { template: 'spawn_agent {name}' },
  agent_task: { template: 'agent_task {name}' },
  agent_query: { template: 'agent_query {name}： {question}' },
  agent_fire: { template: 'agent_fire {name}' },

  // ── 万能工具 ──
  universal_tool: { template: '调用工具：{toolName}' },
};

/** 占位符值格式化：字符串原样（超长截断），数字/布尔转字符串，对象 JSON 序列化 */
function formatValue(v: unknown): string {
  let s: string;
  if (typeof v === 'string') s = v;
  else if (v === null || v === undefined) s = '';
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
  else {
    try { s = JSON.stringify(v); } catch { s = String(v); }
  }
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/**
 * 根据配置生成工具调用的可读显示名。
 * 命中配置 → 按模板渲染（字段缺失时对应占位符段被移除）；
 * 未命中 → 返回原始工具名。
 */
export function formatToolDisplayName(toolName: string, args?: Record<string, unknown>): string {
  const rule = TOOL_DISPLAY_CONFIG[toolName];
  if (!rule) return toolName;
  const rendered = rule.template
    .replace(/([^\w]?)\{(\w+)\}/g, (match, sep: string, key: string) => {
      const v = args?.[key];
      if (v === undefined || v === null || v === '') return '';
      return `${sep}${formatValue(v)}`;
    })
    .trim()
    .replace(/\s+/g, ' ');
  return rendered || toolName;
}


