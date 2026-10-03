import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from '@/App.tsx';
import '@/utils/settings-extension.ts';
import '@/style.css';

// 设置栏目扩展点的 React 回填：扩展点模块本身不 import React（避免与 App 的加载顺序
// 纠缠），这里在 React 本体就绪后挂出去，供注入型插件自建元素时复用，免去插件再打一份。
window.__SEEK_SETTINGS_EXTENSION!.react = React;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

