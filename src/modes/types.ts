import type { MessageHook } from '../agent';
import type { PanelProvider } from '../tools/panel-registry';

/**
 * AgentMode — 一个可切换的策略单元。
 *
 * 模式把「prompt 注入 + 工具门 + 前置 hook + 面板」聚合在一起，
 * 主循环（CLIAAgent）保持通用，模式按需挂载：
 * - 知识库模式（kb）：强制检索，回答有据可依
 * - Manager 模式（manager）：子 agent 编排，复杂任务并行
 * - 打工人模式（worker）：跨会话执行者，接受 collab 派活
 * - default：无模式（快速模式），通用循环裸跑
 */
export interface AgentModeMeta {
  /** 唯一标识，如 'kb' / 'manager' / 'worker'（'default' 保留为无模式） */
  name: string;
  /** 显示名，如「知识库模式」 */
  label: string;
  /** 简短说明 */
  description: string;
  /** 胶囊图标（emoji，UI 用） */
  icon?: string;
}

export interface AgentMode extends AgentModeMeta {
  /** 注入 system prompt 的领域指令（纯文本；注册时可内联或读取 addon 文件） */
  promptAddon?: string;
  /** 替换 MAIN.md 的主提示词（角色模式如 manager/worker 用）；提供时该模式不再附加 promptAddon */
  mainReplacement?: string;
  /** 工具白名单：非空时，仅白名单内的工具可执行（多模式叠加取并集） */
  allowTools?: string[];
  /** 工具黑名单：命中即拒绝（优先级高于白名单） */
  denyTools?: string[];
  /** 强制前置阶段：每条消息发给模型前执行（如知识库检索） */
  preProcess?: MessageHook;
  /** 附带右栏面板（panel-registry 提供者） */
  panel?: PanelProvider;
}

