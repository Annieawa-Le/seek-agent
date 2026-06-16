/**
 * types.ts — sub-agent 技能类型定义
 */

/** 子模型工作模式 */
export type SubAgentMode = 'clone' | 'mission' | 'listen' | 'instructor';

/** listen 子模式：拦截调用前 / 拦截结果后 */
export type ListenMode = 'call' | 'result';

/** 子模型运行状态 */
export type SubAgentStatus = 'idle' | 'running' | 'done' | 'error';

/**
 * 子模型内部状态
 */
export interface SubAgentState {
  name: string;
  mode: SubAgentMode;
  status: SubAgentStatus;
  /** 可调用的工具列表 */
  tools: string[];
  /** 系统提示词（mission 模式专用） */
  systemPrompt?: string;
  /** 上下文和任务（原始） */
  context?: string;
  /** 最近一次提交的工作结果 */
  submission?: string;
  /** 错误信息 */
  error?: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 最近活跃时间 */
  lastActiveAt?: number;
  // listen 模式专用
  /** listen 子模式 */
  listenMode?: ListenMode;
  /** 需要监听的工具列表 */
  listenTools?: string[];
  /** 需要分析的方面 */
  analyzeTarget?: string;
  /** 返回模板 */
  returnTemplate?: string;
  /** 独立 patch 暂存区实例（clone/mission 模式） */
  patchStaging?: import('../../patch-staging').PatchStaging;
  // instructor 模式专用
  /** instructor 的自定义要求 */
  requirement?: string;
  /** instructor 的最大输出轮次 */
  maxRounds?: number;
  /** instructor 已输出的轮次计数 */
  instructorRoundCount?: number;
  /** instructor 独立消息历史 */
  instructorMessages?: import('ai').ModelMessage[];
}

/** 子模型工作提交内容 */
export interface SubmissionPayload {
  summary: string;
  details: string;
}

/** 创建子模型的参数（对应 spawn_agent 工具） */
export interface SpawnParams {
  mode: SubAgentMode;
  name: string;
  tools: string[];
  systemPrompt?: string;
  task?: string;
  contextAndTask?: string;
  listenMode?: ListenMode;
  analyzeTarget?: string;
  returnTemplate?: string;
  listenTools?: string[];
  // instructor 模式
  requirement?: string;
  maxRounds?: number;
}

/** 子模型执行任务参数（对应 agent_task 工具） */
export interface TaskParams {
  name: string;
  task: string;
  context?: string;
}


