/**
 * 正文内容扩展点（中立）。
 *
 * 渲染层本身不认识任何具体插件协议；这里只暴露「助手正文 → 自定义渲染」的注册接口：
 * 插件（inner_skill 注入的前端脚本）注册一个渲染器，返回 null 表示「这段我不处理」，
 * 渲染层就退回默认的 markdown 路径。
 *
 * 设计约束：
 *   - 渲染层对插件零知识：不 import 插件、不认识 VCP / vcp-root / 任何协议关键字；
 *   - 未注册任何渲染器时，渲染路径与扩展点引入前完全一致（零额外开销）；
 *   - 扩展点自身无副作用，注册/注销由插件负责，插件不来则形同不存在。
 */
import type { ReactNode } from 'react';
import React from 'react';
import { renderMarkdown } from '@/utils/markdown.ts';

/** 正文流式状态（渲染器据此决定走增量还是全量路径） */
export interface ContentStreamState {
  /** 该条消息是否仍在流式接收中 */
  streaming: boolean;
  /** 稳定标识（同一气泡内容增长期间保持不变；换气泡即换 key，用于渲染器内部缓存） */
  key: string;
}

/**
 * 内容渲染器：
 *   返回 ReactNode → 由渲染层挂在消息体内；返回 null → 渲染层退回默认 markdown。
 */
export type ContentRenderer = (content: string, state: ContentStreamState) => ReactNode | null;

const renderers: ContentRenderer[] = [];

/** 是否已有插件接管正文渲染（无插件时渲染层走零开销的原路径） */
export function hasContentRenderer(): boolean {
  return renderers.length > 0;
}

/**
 * 注册正文渲染器。插件应在注入时调用一次；重复注册同一函数会被忽略。
 * 返回注销函数（插件被禁用/热卸载时调用，渲染层立即回到默认 markdown）。
 */
export function registerContentRenderer(fn: ContentRenderer): () => void {
  if (typeof fn === 'function' && !renderers.includes(fn)) renderers.push(fn);
  return () => unregisterContentRenderer(fn);
}

export function unregisterContentRenderer(fn: ContentRenderer): void {
  const i = renderers.indexOf(fn);
  if (i >= 0) renderers.splice(i, 1);
}

/**
 * 依次询问已注册渲染器，返回第一个非 null 的结果。
 * 全部不处理（或无人注册）时返回 null，调用方走默认渲染。
 */
export function renderViaContentRenderer(content: string, state: ContentStreamState): ReactNode | null {
  for (let i = 0; i < renderers.length; i++) {
    try {
      const out = renderers[i](content, state);
      if (out !== null && out !== undefined) return out;
    } catch (err) {
      // 插件渲染器抛错不得影响消息渲染：跳过该渲染器，其余照常
      console.error('[content-extension] 渲染器异常，已跳过：', err);
    }
  }
  return null;
}

/** 是否应绕过默认 markdown 渲染（避免无谓的 renderMarkdown 开销） */
export function shouldBypassMarkdown(content: string): boolean {
  if (renderers.length === 0) return false;
  return renderViaContentRenderer(content, { streaming: false, key: '' }) !== null;
}

/**
 * 提名单例给注入型扩展（DOM 注入的插件脚本）。
 *
 * 渲染层不认识任何插件，也不为插件准备私有接口；这里挂出的是**通用**的三样能力：
 *   register        注册正文渲染器（插件唯一入口）
 *   react           React 本体（插件自建 React 元素时需要，避免插件再打一份 React）
 *   renderMarkdown  渲染层的 markdown 渲染器（插件处理自己不管的段落时复用，避免重复实现）
 *
 * 没有任何插件时会一直没人读，纯占位、零开销；插件被移除也不会留下悬空引用。
 */
declare global {
  interface Window {
    __SEEK_CONTENT_EXTENSION?: {
      register: typeof registerContentRenderer;
      unregister: typeof unregisterContentRenderer;
      react: typeof React;
      renderMarkdown: typeof renderMarkdown;
    };
    /** 名单已挂出（宿主据此判断注入时机，免去固定延迟） */
    __SEEK_CONTENT_EXTENSION_READY?: boolean;
  }
}

window.__SEEK_CONTENT_EXTENSION = {
  register: registerContentRenderer,
  unregister: unregisterContentRenderer,
  react: React,
  renderMarkdown,
};

/**
 * 就绪广播：本模块是「渲染层已能接受正文渲染器」的唯一判据。
 *
 * 提名单例本身还不够——宿主（Electron 主进程）在 did-finish-load 后要注入插件脚本，
 * 但它无从得知这个模块何时执行完。此前宿主只能硬等一个固定延迟，DELAY 短了名单还没
 * 挂上、注入即失败且静默；长了每开一次窗就白等一段。
 *
 * 这里主动喊一嗓子（DOM 事件 + 一次性 window 标志）：
 *   · 宿主已挂上监听 → 事件回调里立刻注入，零延迟；
 *   · 宿主还没开始监听（注入脚本先于本模块执行）→ 它读 window 标志即可判定，不漏。
 * 两者互补，任何执行顺序都覆盖得到。
 */
window.__SEEK_CONTENT_EXTENSION_READY = true;
try {
  window.dispatchEvent(new Event('seek:content-extension-ready'));
} catch { /* 事件构造失败不影响标志位语义 */ }

