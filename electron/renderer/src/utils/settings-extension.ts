/**
 * 设置栏目扩展点（中立）。
 *
 * 渲染层不认识任何具体插件；这里只暴露「插件向设置面板贡献一个栏目」的注册接口：
 * 插件注册一个栏目（名称 + 渲染函数），设置面板左列就会出现该分组，选中它即渲染插件内容。
 *
 * 设计约束与 content-extension 一致：
 *   - 渲染层对插件零知识：不 import 插件、不认识任何插件协议关键字；
 *   - 未注册任何栏目时，设置面板与扩展点引入前完全一致（零额外开销）；
 *   - 扩展点自身无副作用，注册/注销由插件负责，插件不来则形同不存在；
 *   - 插件渲染函数抛错不得影响设置面板：捕获后展示降级提示。
 */
import type { ReactNode } from 'react';

/** 一个插件贡献的设置栏目。 */
export interface SettingsSection {
  /** 稳定 id（同一 id 重复注册后者覆盖，便于插件热更新） */
  id: string;
  /** 左列显示的分组名 */
  label: string;
  /** 分组内渲染的内容（插件自建；宿主只负责挂载） */
  render: () => ReactNode;
  /** 排序权重（小的靠前）；默认 100，宿主内置分组用 <100 */
  order?: number;
}

const sections = new Map<string, SettingsSection>();

/** 是否已有插件贡献栏目（无插件时设置面板走零开销原路径）。 */
export function hasSettingsSections(): boolean {
  return sections.size > 0;
}

/**
 * 注册一个设置栏目。返回注销函数（插件卸载时调用，左列分组立即消失）。
 * 注册函数与 React 无关——插件渲染函数返回 ReactNode，宿主负责挂载。
 */
export function registerSettingsSection(section: SettingsSection): () => void {
  if (!section || typeof section.render !== 'function' || !section.id) {
    return () => { /* 非法注册：给一个空注销函数，避免调用方报错 */ };
  }
  sections.set(section.id, section);
  return () => unregisterSettingsSection(section.id);
}

export function unregisterSettingsSection(id: string): void {
  sections.delete(id);
}

/** 取全部栏目，按 order 升序（同序按注册先后）。 */
export function listSettingsSections(): SettingsSection[] {
  return [...sections.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/**
 * 提名单例给注入型扩展（DOM 注入的插件脚本）。
 * 渲染层不认识插件，只挂出通用的注册能力 + React 本体（插件自建元素时需要）。
 */
declare global {
  interface Window {
    __SEEK_SETTINGS_EXTENSION?: {
      register: typeof registerSettingsSection;
      unregister: typeof unregisterSettingsSection;
      list: typeof listSettingsSections;
      react: unknown;
    };
    /** 设置扩展点已就绪（宿主据此判断注入时机） */
    __SEEK_SETTINGS_EXTENSION_READY?: boolean;
  }
}

window.__SEEK_SETTINGS_EXTENSION = {
  register: registerSettingsSection,
  unregister: unregisterSettingsSection,
  list: listSettingsSections,
  react: null, // 由 main.tsx 在 React 就绪后回填（避免此处直接依赖 React 造成循环）
};

window.__SEEK_SETTINGS_EXTENSION_READY = true;
try {
  window.dispatchEvent(new Event('seek:settings-extension-ready'));
} catch { /* 事件构造失败不影响标志位语义 */ }
