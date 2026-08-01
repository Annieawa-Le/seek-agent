# Agent 模式系统设计（Agent Mode System）

> 状态：设计稿（未实现）
> 动机：在"通用 agent 循环"之上，提供按需挂载的**确定性**（强制检索）与**并行性**（多 agent 编排）
> 参考：腾讯 ima 的"回答前必然经过知识库搜索"——专用管线 vs 通用循环的架构取舍

---

## 一、背景

seek-agent 的核心是**通用循环**：`输入 → 模型思考 → 调用工具 → 继续循环 → 输出`。
能力由挂载的工具集决定，模型是自主决策者。这种架构灵活，但有两个先天短板：

1. **确定性不足**：模型"可能"不调用某工具（如 `kb_query`），导致漏检、幻觉。
   通用架构里"每次必然检索"这种必然性不是天生的，必须靠工程手段补。
2. **并行性缺失**：所有工作都在单条循环里串行完成，复杂任务没有分工机制。

**模式的本质**：把散落的开关（prompt、工具集、hook、面板、子 agent 预设）聚合成一个
可切换的策略单元，让主循环保持纯净，让"确定性/并行性"成为可选的模式属性。

---

## 二、设计目标

- **主循环零侵入**：模式是挂载的策略，不改 `CLIAAgent` 的循环骨架
- **聚合配置**：一个模式 = prompt + 工具集 + 前置 hook + 面板 + 子 agent 预设
- **运行时切换**：`/mode <name>` 切换，不重启进程
- **可组合**：模式之间可叠加（如"知识库 + Manager"同时启用）

---

## 三、核心概念：AgentMode

```ts
// src/modes/types.ts（草案）
export interface AgentMode {
  name: string;                 // 唯一标识，如 'kb' / 'manager'
  description: string;
  promptAddon?: string;         // 附加型：注入 system prompt 尾部（kb 模式用，对应 addon/ 文件）
  mainReplacement?: string;     // 角色型：替换 MAIN.md 成为主提示词（manager/worker 用），与 promptAddon 互斥
  allowTools?: string[];        // 工具白名单（空 = 不限制）；不在名单内的工具被拒绝
  denyTools?: string[];         // 工具黑名单（优先级高于白名单）
  preProcess?: MessageHook;     // 强制前置阶段（async），如"每条 user 消息先检索"
  panel?: PanelProvider;        // 附带右栏面板（panel-registry）
  subAgents?: SubAgentPreset[]; // 预设子 agent（Manager 模式用）
}
```

模式注册表（全局单例，进程内可增删）：

```ts
// src/modes/registry.ts（草案）
export function registerMode(mode: AgentMode): void;
export function getMode(name: string): AgentMode | undefined;
export function listModes(): AgentMode[];
export function setActiveModes(names: string[]): void;  // 支持多模式叠加
export function getActiveModes(): AgentMode[];
```

---

## 四、落点映射（对照现有代码）

| 模式要素 | 现有机制 | 现状与缺口 |
|---------|---------|-----------|
| 前置强制阶段 | `agent.messageHook`（message_managing.ts） | 已存在，**同步**；工作记忆注入是"必然执行"的先例，需扩展为 async 支持检索 |
| 领域 prompt | `src/prompts/addon/`（FRONT_END.md / MOD_JAVA.md） | 目录已就绪，但 `loadDefaultPrompts()` **未加载**，需在模式激活时动态附加 |
| 面板 | `panel-registry.ts`（registerPanelProvider） | 已就绪，直接复用 |
| 子 agent | `sub-agent` 系统（clone/mission/listen/instructor） | 已就绪，Manager 模式在其上编排 |
| 工具集过滤 | `src/tools/index.ts` 全局注册 | **缺口**：需在工具执行层加一道模式门（见 §六） |
| 跨会话通信 | `src/tools/collab.ts`（collab_sessions / collab_send） | 已就绪（Electron 多会话模式）；回传地址需主进程注入来源 ID |

---

## 五、模式详设

### 5.1 知识库模式（kb）

**目标**：复刻 ima 的"回答前必然检索"——每次回答有据可依，降低幻觉。

**行为**：

```
user 消息进入
  → messageHook（async）强制 kb_query(userContent, topK)
  → 检索结果（含文件路径+行号）注入为一条 system 消息
  → 模型基于注入的检索上下文生成
```

**要点**：

- **必然性来自 hook 而非 prompt**：不依赖模型"自觉"调用 `kb_query`，检索在模型决策之前完成
- **结果带来源**：注入格式需包含 `文件路径 + 行号范围`，并指示模型"引用时标注来源"，
  与 `kb_query` 现有返回结构对齐
- **索引守卫**：进入模式时检查 `kb_status`，索引不存在则提示先 `kb_build_index`
- **可选降级**：topK 可配置；检索为空时注入"未命中"占位，避免模型误以为没有知识库

**面板**：显示最近检索的命中片段列表（文件、相似度、片段摘要），便于用户判断检索质量。

### 5.2 Agent Manager 模式（manager）

**目标**：主 agent 变编排器，复杂任务分解给多个子 agent 并行执行，验收后汇总。

**行为**：

```
任务进入
  → 主 agent 规划：拆解为子任务
  → 按子任务 spawn 子 agent（mission 模式，携带任务+上下文）
  → 并行执行，主循环监控
  → 子 agent 通过 a_submission 提交结果
  → 主 agent 验收 → 不合格打回（重派）→ 汇总输出
```

**要点**：

- **编排发生在主循环，执行发生在子 agent**：主循环只做拆解/派发/验收/汇总，保持轻量
- **复用 listen 模式**：可挂一个"审查员"子 agent 监听子 agent 产出，做自动代码审查
- **上下文隔离**：子 agent 各自独立调用栈，任务描述必须自包含（mission 模式天然支持）
- **结果 merge**：子 agent 提交结果以 user 消息形式回到主对话（现有 `a_submission` 机制），
  主 agent 负责去重、冲突消解、统一格式

**面板**：注册 `AgentDashboard`——实时显示各子 agent 状态（运行中/已提交/结果摘要/耗时），
复用 panel-registry 的渲染管线。

### 5.3 打工人模式（worker）

**目标**：把当前会话变成一个"可被跨会话派活的执行者"——老板（其他会话）通过
`collab_send` 派活，打工人专注执行、结构化回传，干完待命。与 Manager 模式配对：
Manager 在**本会话内**编排子 agent，Worker 是**跨会话**的执行单元（另一个独立会话）。

**行为**：

```
collab_send 任务到达（作为 user 消息进入本会话）
  → 打工人识别"这是任务"（而非闲聊）
  → 拆解步骤 → 逐项执行 → 自检（编译/测试）
  → collab_send 结构化报告回传给派活方
  → 进入待命，等待下一个任务
```

**要点**：

- **身份可被发现**：老板通过 `collab_sessions` 找人。打工人模式的会话应在标题/摘要
  中带可识别标识（如 `[worker]` 前缀），或由主进程在身份卡中注入 mode 字段（远期）
- **任务识别**：所有来自协作的消息按任务处理（prompt 纪律），或约定消息前缀（如
  `【任务】`）做硬识别，更稳健
- **回传地址**：`collab_send` 的回复自动回到派活方，但打工人需要知道"回给谁"。
  方案：主进程转发协作消息时注入来源会话 ID（如消息头部带 `来自: <sessionId>`），
  打工人从消息里取回传地址——需主进程小改动
- **执行纪律（prompt addon）**：不扩展任务范围、不做无关重构、完成即报、等待下个任务；
  报告格式固定：任务理解 / 执行过程 / 文件改动 / 验证结果 / 风险遗留
- **工具集**：保留完整工具（要能干活）+ collab 工具（回传用），靠 prompt 纪律约束
- **限制**：`collab_send` 只对**活跃会话**直接送达，未活跃只返回身份卡不唤醒。
  所以跨会话派活的前提是打工人会话处于活跃状态（与子 agent 的"随叫随到"不同）

**面板**：显示打工人状态（空闲/执行中/完成）、最近任务与回传记录。

**安全**：初期信任环境——接受所有协作消息；远期可加授权白名单（只接受指定 sessionId 派活）。

### 5.4 模式选择 UI（新会话启动页）

**布局参考**：DeepSeek 桌面端启动页（截图 `test/PixPin_2026-08-01_17-05-31.png`）——
新会话、消息区为空时，在聊天区**垂直居中**显示引导页：

- 顶部：Logo/图标 + 大标题「使用 {模式名} 开始对话」（选中模式变化时标题联动）
- 中部：横向**胶囊按钮组**（Segmented Control），每个模式一个胶囊：图标 + 模式名；
  选中态 = 浅蓝底 + 深蓝字，未选中 = 透明底 + 灰字
- 风格：极简、大量留白、科技蓝强调色（跟随现有主题，dark 模式需适配）

**触发时机**：新会话开始且 `messages.length === 0` 时显示；用户点击胶囊**立即激活**
对应模式（标题联动变化），随后在输入框发送第一条消息即进入对话，
聊天内容出现后启动页自然退场。

**模式映射**（初始四个胶囊）：

| 胶囊 | 模式 | 说明 |
|------|------|------|
| ⚡ 快速模式 | default | 通用循环，不挂模式策略 |
| 📚 知识库模式 | kb | 强制检索（§5.1） |
| 🧑‍💼 Manager 模式 | manager | 子 agent 编排（§5.2） |
| 🧑‍🔧 打工人模式 | worker | 跨会话执行者（§5.3） |

**WebUI 落地**：新增 `ModePicker` 组件，挂在 `MessageList` 的空态（`messages.length === 0`
时在 `#message-area` 内居中渲染）：

- props：`modes: AgentModeMeta[]`（名称/描述/图标）、`activeMode`、`onSelect`
- 点击胶囊 → `onSelect(mode)` → 经现有命令通道通知主进程激活（复用 `/mode` 指令 IPC）
- 标题随 `activeMode` 联动；退场由 `MessageList` 的 messages 非空自然触发，无需额外状态

---

## 六、关键技术挑战

### 6.1 messageHook 异步化

现状：`MessageHook = (messages: ModelMessage[]) => ModelMessage[]`，同步。
知识库模式需要在 hook 里跑异步检索。方案：

```ts
// agent.ts 中调用点改为支持 async
type MessageHook = (messages: ModelMessage[]) => ModelMessage[] | Promise<ModelMessage[]>;
```

调用处 `await` 即可。这是模式系统的**通用底座**，建议最先做。

### 6.2 工具白名单的强制手段

推荐**执行层过滤**而非注册表摘除：

- 在 `executeToolCalls` 执行前检查当前激活模式的 `allowTools/denyTools`
- 不在白名单 → 直接返回错误结果"当前模式禁止调用工具 X"
- 优点：切换零成本（不改注册表）、错误信息显式、与 inner_skills 热插拔正交
- 不推荐纯 prompt 软约束（模型不可靠），可与白名单叠加使用

### 6.3 模式切换的 prompt 重载

`loadDefaultPrompts()` 当前是固定的。方案：

- 模式激活时，在 `systemPrompt` 末尾**追加**该模式的 `promptAddon` 内容
- 切换/退出时移除追加部分（保存原始 base prompt，切换 = 重新拼接）
- 多模式叠加时按注册顺序拼接

### 6.4 多模式叠加的冲突

- 多个 `preProcess`：按注册顺序依次执行（管道式）
- 多个面板：panel-registry 已支持多 provider 按优先级排序，天然兼容

---

## 七、实施路线（不着急，按依赖排序）

| 阶段 | 内容 | 依赖 |
|------|------|------|
| P0 | 模式基础设施：`types.ts` + `registry.ts` + `/mode` 指令 + messageHook 异步化 + 工具执行层白名单门 | 无 |
| P1 | 知识库模式：promptAddon（kb 行为准则）+ preProcess 强制检索 + 来源标注格式 + 面板 | P0，kb_query 已存在 |
| P2 | Agent Manager 模式：编排循环 + 子 agent 派发/验收 + AgentDashboard 面板 | P0，sub-agent 已存在 |
| P2.5 | 打工人模式：任务识别 + 执行纪律 prompt + 结构化回传（来源 ID 注入）+ 状态面板 | P0，collab 已落地 |
| P3 | 体验打磨：模式状态持久化到 session、模式配置（topK/子 agent 数）、模式间组合场景测试 | P1+P2 |

---

## 八、开放问题

1. 模式是**全局**还是**按会话**生效？**已定：按会话独立且持久化**——模式随 session 文件保存（`autoSaveSession` 写 `mode` 字段）；agent 进程启动时按 `AGENT_SESSION_ID` 匹配 session 文件恢复模式（electron-entry）；`LoadSessionCommand` 加载会话时同样恢复；渲染层仅**新建**会话显示 ModePicker（`isFreshSession`），切回旧会话不显示（与 DeepSeek 一致）；模式随身份卡暴露（`meta.mode`，供跨会话识别如打工人模式）
2. 工具白名单被拒后，是**硬拒绝**还是**提示降级**（如"该工具不在当前模式，可 /mode default 切换"）？
3. Agent Manager 的**验收标准**由谁定？初始建议主 agent 自评 + 可选 listen 审查员兜底
4. 知识库模式的检索时机：**每条 user 消息都检索**，还是**检测到工具调用意图才检索**？
   （ima 是前者，但会引入检索延迟；可做成可配置策略）
5. 是否需要"模式建议"能力——由模型根据任务类型自动建议切换模式？（远期）
6. 打工人如何确认**回传地址**？建议主进程转发协作消息时注入来源会话 ID；任务格式
   是否约定前缀（如 `【任务】`）做硬识别？
7. 跨会话派活受"仅活跃会话可送达"限制：是否需要**唤醒机制**（未活跃会话收到任务
   自动启动执行）？涉及主进程路由改造
8. 打工人模式的**授权边界**：是否限制可派活的会话白名单？（信任环境初期可放开）










