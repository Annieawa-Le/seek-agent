# html-toolkit

HTML 开发工具包。提供一键将 HTML 内容启动为本地调试页面的能力，
自动注入 console 日志捕获，让 AI 能「看见」页面运行时的输出。

---

## 工具总览

| 工具 | 说明 |
|------|------|
| `run_page` | 将 HTML 代码或文件启动为本地 HTTP 调试页面，自动捕获 console 输出 |

---

## run_page 详解

### 参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `htmlSource` | string | **必填** | HTML 代码字符串，或相对工作区根目录的 HTML 文件路径 |
| `port` | number | `3000` | 本地端口（被占用时自动递增，最多试 50 次） |

### 工作流程

```
htmlSource ──→ 判断是文件还是内联代码
                   │
                   ▼
              注入 console 捕获脚本（</body> 前插入）
                   │
                   ▼
              写入 %TEMP%/html-toolkit/<title>.html
                   │
                   ▼
              查找可用端口 → 启动 Node.js HTTP 子进程
                   │
                   ▼
              打开浏览器 → 等待 1.5s 页面初始化
                   │
                   ▼
              flush 收集到的 console 日志 → 返回结果
```

### Console 捕获机制

工具会在 HTML 的 `</body>` 标签前自动注入一段无侵入脚本：

- **重写的方法** — `console.log` / `console.warn` / `console.error` / `console.info` / `console.debug`
- **传输方式** — 通过 `XMLHttpRequest` 异步 POST 到本地服务器
- **原始行为保留** — 重写后的方法内部调用原始 console 方法，浏览器 DevTools 不受影响
- **防重复** — 设置了 `window.__consoleCaptureInjected` 标志，多次调用不会重复注入

### 服务端 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/__console__` | POST | 接收浏览器发来的日志条目 `{ level, messages[], timestamp }` |
| `/__console__/flush` | GET | 获取所有累积日志并清空队列（可直接浏览器访问查看实时日志） |

### MIME 支持

`.html` `.css` `.js` `.mjs` `.json` `.png` `.jpg` `.jpeg` `.gif` `.svg` `.ico` `.woff` `.woff2` `.wasm`

### 注意事项

- 服务器仅绑定 `127.0.0.1`，仅本地可访问
- 服务器进程独立于 AI 会话运行，关闭对话不自动终止
- **用完请手动杀进程**：`taskkill /F /PID <pid>`
- 外部资源（CSS/JS/图片）需与 HTML 同目录或使用绝对正确相对路径

---

## 使用示例

**内联 HTML：**
```
run_page(htmlSource="<!DOCTYPE html><html><body><h1>你好</h1><script>console.log('Hello');</script></body></html>")
```

**传入文件：**
```
run_page(htmlSource="./my-page.html")
```

**指定端口：**
```
run_page(htmlSource="./index.html", port=8080)
```

---

## 变更记录

- 初始版本：run_page 基础功能 + console 日志自动捕获
