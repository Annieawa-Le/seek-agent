/**
 * 引擎自注册片段 —— 由宿主（host.mjs）在 /vendor/vcp-engine-v1.js 响应尾部追加。
 *
 * 上游用 `new Function('vc','hp','f', engineSource)` 把引擎包进闭包并注入三个依赖；
 * seek-agent 渲染层是 file:// 页面，同步 XHR 取 http 源码易被跨源策略拦，故改为
 * 动态 <script> 加载 + 尾部追加本片段：把注入值挂到引擎所在的作用域之外可读的全局，
 * 再由引擎自身已声明的自由变量 vc / hp / f 承接——
 *
 *   引擎源码是 IIFE，其内部 `vc` / `hp` / `f` 未声明 → 沿作用域链上溯到全局对象。
 *   因此只要在引擎脚本**之前**把 window.vc / window.hp / window.f 设好，引擎即命中。
 *
 * 本片段只做一件事：确认三个注入就绪后，把引擎已挂出的 window.__vcpStable 标记为可用。
 * 缺任一依赖则不标记（client 侧据此走「引擎未就绪」降级，不抛错）。
 */
;(function () {
  'use strict'
  try {
    if (typeof window.vc !== 'function' || typeof window.hp !== 'function' || !window.f) {
      console.warn('[raw-html] 引擎依赖未注入（vc/hp/f），跳过注册')
      return
    }
    if (!window.__vcpStable || typeof window.__vcpStable.render !== 'function') {
      console.warn('[raw-html] 引擎未挂出 __vcpStable.render，跳过注册')
      return
    }
    window.__vcpEngineReady = true
  } catch (e) {
    console.warn('[raw-html] 引擎注册片段异常：', (e && e.message) || e)
  }
})()
