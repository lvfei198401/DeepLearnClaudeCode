import { getSdkAgentProgressSummariesEnabled } from '../../bootstrap/state.js';
import { OUTPUT_FILE_TAG, STATUS_TAG, SUMMARY_TAG, TASK_ID_TAG, TASK_NOTIFICATION_TAG, TOOL_USE_ID_TAG, WORKTREE_BRANCH_TAG, WORKTREE_PATH_TAG, WORKTREE_TAG } from '../../constants/xml.js';
import { abortSpeculation } from '../../services/PromptSuggestion/speculation.js';
import type { AppState } from '../../state/AppState.js';
import type { SetAppState, Task, TaskStateBase } from '../../Task.js';
import { createTaskStateBase } from '../../Task.js';
import type { Tools } from '../../Tool.js';
import { findToolByName } from '../../Tool.js';
import type { AgentToolResult } from '../../tools/AgentTool/agentToolUtils.js';
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js';
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../../tools/SyntheticOutputTool/SyntheticOutputTool.js';
import { asAgentId } from '../../types/ids.js';
import type { Message } from '../../types/message.js';
import { createAbortController, createChildAbortController } from '../../utils/abortController.js';
import { registerCleanup } from '../../utils/cleanupRegistry.js';
import { getToolSearchOrReadInfo } from '../../utils/collapseReadSearch.js';
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js';
import { getAgentTranscriptPath } from '../../utils/sessionStorage.js';
import { evictTaskOutput, getTaskOutputPath, initTaskOutputAsSymlink } from '../../utils/task/diskOutput.js';
import { PANEL_GRACE_MS, registerTask, updateTaskState } from '../../utils/task/framework.js';
import { emitTaskProgress } from '../../utils/task/sdkProgress.js';
import type { TaskState } from '../types.js';

/** 工具活动信息 */
export type ToolActivity = {
  toolName: string;
  input: Record<string, unknown>;
  /** 工具预计算的活动描述，例如 "正在读取 src/foo.ts" */
  activityDescription?: string;
  /** 预计算标识：是否为搜索操作（如 grep、glob 等） */
  isSearch?: boolean;
  /** 预计算标识：是否为读取操作（如 read、cat 等） */
  isRead?: boolean;
};

/** 智能体进度信息 */
export type AgentProgress = {
  toolUseCount: number;
  tokenCount: number;
  lastActivity?: ToolActivity;
  recentActivities?: ToolActivity[];
  summary?: string;
};

/** 最大保留的最近活动数量 */
const MAX_RECENT_ACTIVITIES = 5;

/** 进度追踪器类型 */
export type ProgressTracker = {
  toolUseCount: number;
  // 分别追踪输入和输出以避免重复计数
  // Claude API 中的 input_tokens 是每轮累计值（包含所有历史上下文），因此仅保留最新值
  // output_tokens 是单轮值，因此进行累加
  latestInputTokens: number;
  cumulativeOutputTokens: number;
  recentActivities: ToolActivity[];
};

/** 创建进度追踪器实例 */
export function createProgressTracker(): ProgressTracker {
  return {
    toolUseCount: 0,
    latestInputTokens: 0,
    cumulativeOutputTokens: 0,
    recentActivities: []
  };
}

/** 从进度追踪器中获取总 Token 数量 */
export function getTokenCountFromTracker(tracker: ProgressTracker): number {
  return tracker.latestInputTokens + tracker.cumulativeOutputTokens;
}

/**
 * 解析器函数：根据工具名称和输入返回人类可读的活动描述
 * 用于在记录时从 Tool.getActivityDescription() 预计算描述信息
 */
export type ActivityDescriptionResolver = (toolName: string, input: Record<string, unknown>) => string | undefined;

/**
 * 根据消息更新进度追踪器状态
 * @param tracker 进度追踪器
 * @param message 消息对象
 * @param resolveActivityDescription 活动描述解析器
 * @param tools 工具集合
 */
export function updateProgressFromMessage(tracker: ProgressTracker, message: Message, resolveActivityDescription?: ActivityDescriptionResolver, tools?: Tools): void {
  if (message.type !== 'assistant') {
    return;
  }
  const usage = message.message.usage;
  // 保留最新的输入 Token（API 中为累计值），累加输出 Token
  tracker.latestInputTokens = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  tracker.cumulativeOutputTokens += usage.output_tokens;

  for (const content of message.message.content) {
    if (content.type === 'tool_use') {
      tracker.toolUseCount++;
      // 预览中忽略结构化输出工具（内部工具）
      if (content.name !== SYNTHETIC_OUTPUT_TOOL_NAME) {
        const input = content.input as Record<string, unknown>;
        const classification = tools ? getToolSearchOrReadInfo(content.name, input, tools) : undefined;
        tracker.recentActivities.push({
          toolName: content.name,
          input,
          activityDescription: resolveActivityDescription?.(content.name, input),
          isSearch: classification?.isSearch,
          isRead: classification?.isRead
        });
      }
    }
  }

  // 保持最近活动列表长度不超过最大值
  while (tracker.recentActivities.length > MAX_RECENT_ACTIVITIES) {
    tracker.recentActivities.shift();
  }
}

/** 获取进度更新信息 */
export function getProgressUpdate(tracker: ProgressTracker): AgentProgress {
  return {
    toolUseCount: tracker.toolUseCount,
    tokenCount: getTokenCountFromTracker(tracker),
    lastActivity: tracker.recentActivities.length > 0 ? tracker.recentActivities[tracker.recentActivities.length - 1] : undefined,
    recentActivities: [...tracker.recentActivities]
  };
}

/**
 * 从工具列表创建活动描述解析器
 * 根据名称查找工具，并调用 getActivityDescription 方法（如果存在）
 */
export function createActivityDescriptionResolver(tools: Tools): ActivityDescriptionResolver {
  return (toolName, input) => {
    const tool = findToolByName(tools, toolName);
    return tool?.getActivityDescription?.(input) ?? undefined;
  };
}

/** 本地智能体任务状态类型 */
export type LocalAgentTaskState = TaskStateBase & {
  type: 'local_agent';
  agentId: string;
  prompt: string;
  selectedAgent?: AgentDefinition;
  agentType: string;
  model?: string;
  abortController?: AbortController;
  unregisterCleanup?: () => void;
  error?: string;
  result?: AgentToolResult;
  progress?: AgentProgress;
  retrieved: boolean;
  messages?: Message[];
  // 记录上次上报的状态，用于计算增量
  lastReportedToolCount: number;
  lastReportedTokenCount: number;
  // 任务是否已后台运行（false=前台运行，true=后台运行）
  isBackgrounded: boolean;
  // 通过 SendMessage 暂存的消息，在工具轮次边界处理
  pendingMessages: string[];
  // UI 持有该任务：阻止回收、启用流式追加、触发磁盘初始化
  // 由 enterTeammateView 设置，与 viewingAgentTaskId（查看对象）独立，retain 表示持有对象
  retain: boolean;
  // 已从磁盘加载侧链数据并合并到消息中
  // 每个持有周期仅执行一次，后续通过流式追加更新
  diskLoaded: boolean;
  // 面板可见期限。undefined=无期限（运行中或被持有）
  // 时间戳=到期后隐藏并可回收。在任务结束和取消选中时设置，被持有时清除
  evictAfter?: number;
};

/** 判断是否为本地智能体任务 */
export function isLocalAgentTask(task: unknown): task is LocalAgentTaskState {
  return typeof task === 'object' && task !== null && 'type' in task && task.type === 'local_agent';
}

/**
 * 由协调器面板管理的本地智能体任务（非主会话）
 * 此类任务在面板中展示，而非后台任务标签
 * 这是所有标签/面板过滤规则必须遵循的判断条件
 */
export function isPanelAgentTask(t: unknown): t is LocalAgentTaskState {
  return isLocalAgentTask(t) && t.agentType !== 'main-session';
}

/** 向任务添加待处理消息 */
export function queuePendingMessage(taskId: string, msg: string, setAppState: (f: (prev: AppState) => AppState) => void): void {
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => ({
    ...task,
    pendingMessages: [...task.pendingMessages, msg]
  }));
}

/**
 * 向本地智能体任务追加消息，使其立即显示在对话记录中
 * 调用方自行构造 Message 对象（避免循环依赖）
 * queuePendingMessage 和 resumeAgentBackground 仅将提示词发送给 API，不更新显示
 */
export function appendMessageToLocalAgent(taskId: string, message: Message, setAppState: (f: (prev: AppState) => AppState) => void): void {
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => ({
    ...task,
    messages: [...(task.messages ?? []), message]
  }));
}

/** 处理并清空任务的待处理消息队列 */
export function drainPendingMessages(taskId: string, getAppState: () => AppState, setAppState: (f: (prev: AppState) => AppState) => void): string[] {
  const task = getAppState().tasks[taskId];
  if (!isLocalAgentTask(task) || task.pendingMessages.length === 0) {
    return [];
  }
  const drained = task.pendingMessages;
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, t => ({
    ...t,
    pendingMessages: []
  }));
  return drained;
}

/**
 * 将智能体通知加入消息队列
 */
export function enqueueAgentNotification({
  taskId,
  description,
  status,
  error,
  setAppState,
  finalMessage,
  usage,
  toolUseId,
  worktreePath,
  worktreeBranch
}: {
  taskId: string;
  description: string;
  status: 'completed' | 'failed' | 'killed';
  error?: string;
  setAppState: SetAppState;
  finalMessage?: string;
  usage?: {
    totalTokens: number;
    toolUses: number;
    durationMs: number;
  };
  toolUseId?: string;
  worktreePath?: string;
  worktreeBranch?: string;
}): void {
  // 原子检查并设置已通知标志，防止重复通知
  // 如果任务已标记为已通知（如通过 TaskStopTool），则跳过入队
  let shouldEnqueue = false;
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.notified) {
      return task;
    }
    shouldEnqueue = true;
    return {
      ...task,
      notified: true
    };
  });

  if (!shouldEnqueue) {
    return;
  }

  // 中止所有活跃的推测任务 - 后台任务状态已变更，推测结果可能引用过期的任务输出
  // 保留提示建议文本，仅丢弃预计算的响应
  abortSpeculation(setAppState);

  const summary = status === 'completed' 
    ? `智能体"${description}"已完成` 
    : status === 'failed' 
      ? `智能体"${description}"执行失败：${error || '未知错误'}` 
      : `智能体"${description}"已停止`;

  const outputPath = getTaskOutputPath(taskId);
  const toolUseIdLine = toolUseId ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>` : '';
  const resultSection = finalMessage ? `\n<result>${finalMessage}</result>` : '';
  const usageSection = usage ? `\n<usage><total_tokens>${usage.totalTokens}</total_tokens><tool_uses>${usage.toolUses}</tool_uses><duration_ms>${usage.durationMs}</duration_ms></usage>` : '';
  const worktreeSection = worktreePath ? `\n<${WORKTREE_TAG}><${WORKTREE_PATH_TAG}>${worktreePath}</${WORKTREE_PATH_TAG}>${worktreeBranch ? `<${WORKTREE_BRANCH_TAG}>${worktreeBranch}</${WORKTREE_BRANCH_TAG}>` : ''}</${WORKTREE_TAG}>` : '';

  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${summary}</${SUMMARY_TAG}>${resultSection}${usageSection}${worktreeSection}
</${TASK_NOTIFICATION_TAG}>`;

  enqueuePendingNotification({
    value: message,
    mode: 'task-notification'
  });
}

/**
 * 本地智能体任务 - 处理后台智能体执行
 * 使用统一的任务接口替换原 AsyncAgent 实现
 */
export const LocalAgentTask: Task = {
  name: 'LocalAgentTask',
  type: 'local_agent',
  async kill(taskId, setAppState) {
    killAsyncAgent(taskId, setAppState);
  }
};

/**
 * 终止智能体任务，若任务已终止/完成则不执行操作
 */
export function killAsyncAgent(taskId: string, setAppState: SetAppState): void {
  let killed = false;
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task;
    }
    killed = true;
    task.abortController?.abort();
    task.unregisterCleanup?.();
    return {
      ...task,
      status: 'killed',
      endTime: Date.now(),
      evictAfter: task.retain ? undefined : Date.now() + PANEL_GRACE_MS,
      abortController: undefined,
      unregisterCleanup: undefined,
      selectedAgent: undefined
    };
  });

  if (killed) {
    void evictTaskOutput(taskId);
  }
}

/**
 * 终止所有正在运行的智能体任务
 * 用于协调模式下的 ESC 取消操作，停止所有子智能体
 */
export function killAllRunningAgentTasks(tasks: Record<string, TaskState>, setAppState: SetAppState): void {
  for (const [taskId, task] of Object.entries(tasks)) {
    if (task.type === 'local_agent' && task.status === 'running') {
      killAsyncAgent(taskId, setAppState);
    }
  }
}

/**
 * 标记任务为已通知状态，不发送通知
 * 用于批量终止智能体时抑制单独通知，仅发送汇总消息
 */
export function markAgentsNotified(taskId: string, setAppState: SetAppState): void {
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.notified) {
      return task;
    }
    return {
      ...task,
      notified: true
    };
  });
}

/**
 * 更新智能体任务进度
 * 保留原有的摘要字段，避免后台摘要结果被消息进度更新覆盖
 */
export function updateAgentProgress(taskId: string, progress: AgentProgress, setAppState: SetAppState): void {
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task;
    }
    const existingSummary = task.progress?.summary;
    return {
      ...task,
      progress: existingSummary ? {
        ...progress,
        summary: existingSummary
      } : progress
    };
  });
}

/**
 * 更新智能体任务的后台摘要
 * 由定期摘要服务调用，存储1-2句进度摘要
 */
export function updateAgentSummary(taskId: string, summary: string, setAppState: SetAppState): void {
  let captured: {
    tokenCount: number;
    toolUseCount: number;
    startTime: number;
    toolUseId: string | undefined;
  } | null = null;

  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task;
    }
    captured = {
      tokenCount: task.progress?.tokenCount ?? 0,
      toolUseCount: task.progress?.toolUseCount ?? 0,
      startTime: task.startTime,
      toolUseId: task.toolUseId
    };
    return {
      ...task,
      progress: {
        ...task.progress,
        toolUseCount: task.progress?.toolUseCount ?? 0,
        tokenCount: task.progress?.tokenCount ?? 0,
        summary
      }
    };
  });

  // 向 SDK 消费者发送摘要事件（如 VS Code 子智能体面板），终端界面无操作
  // 仅在 SDK 选项开启时发送，避免未启用的会话泄露事件
  if (captured && getSdkAgentProgressSummariesEnabled()) {
    const {
      tokenCount,
      toolUseCount,
      startTime,
      toolUseId
    } = captured;
    emitTaskProgress({
      taskId,
      toolUseId,
      description: summary,
      startTime,
      totalTokens: tokenCount,
      toolUses: toolUseCount,
      summary
    });
  }
}

/**
 * 完成智能体任务并设置结果
 */
export function completeAgentTask(result: AgentToolResult, setAppState: SetAppState): void {
  const taskId = result.agentId;
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task;
    }
    task.unregisterCleanup?.();
    return {
      ...task,
      status: 'completed',
      result,
      endTime: Date.now(),
      evictAfter: task.retain ? undefined : Date.now() + PANEL_GRACE_MS,
      abortController: undefined,
      unregisterCleanup: undefined,
      selectedAgent: undefined
    };
  });

  void evictTaskOutput(taskId);
  // 通知由 AgentTool 通过 enqueueAgentNotification 发送
}

/**
 * 标记智能体任务执行失败并设置错误信息
 */
export function failAgentTask(taskId: string, error: string, setAppState: SetAppState): void {
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task;
    }
    task.unregisterCleanup?.();
    return {
      ...task,
      status: 'failed',
      error,
      endTime: Date.now(),
      evictAfter: task.retain ? undefined : Date.now() + PANEL_GRACE_MS,
      abortController: undefined,
      unregisterCleanup: undefined,
      selectedAgent: undefined
    };
  });

  void evictTaskOutput(taskId);
  // 通知由 AgentTool 通过 enqueueAgentNotification 发送
}

/**
 * 注册智能体任务
 * 由 AgentTool 调用，创建新的后台智能体
 * @param parentAbortController - 可选父级中止控制器，若提供则子控制器会随父级自动中止
 *   确保父任务（如协作伙伴）中止时，子智能体同步终止
 */
export function registerAsyncAgent({
  agentId,
  description,
  prompt,
  selectedAgent,
  setAppState,
  parentAbortController,
  toolUseId
}: {
  agentId: string;
  description: string;
  prompt: string;
  selectedAgent: AgentDefinition;
  setAppState: SetAppState;
  parentAbortController?: AbortController;
  toolUseId?: string;
}): LocalAgentTaskState {
  void initTaskOutputAsSymlink(agentId, getAgentTranscriptPath(asAgentId(agentId)));

  // 创建中止控制器，若存在父级则创建子控制器，随父级自动中止
  const abortController = parentAbortController ? createChildAbortController(parentAbortController) : createAbortController();

  const taskState: LocalAgentTaskState = {
    ...createTaskStateBase(agentId, 'local_agent', description, toolUseId),
    type: 'local_agent',
    status: 'running',
    agentId,
    prompt,
    selectedAgent,
    agentType: selectedAgent.agentType ?? 'general-purpose',
    abortController,
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true, // 注册后立即后台运行
    pendingMessages: [],
    retain: false,
    diskLoaded: false
  };

  // 注册清理函数
  const unregisterCleanup = registerCleanup(async () => {
    killAsyncAgent(agentId, setAppState);
  });
  taskState.unregisterCleanup = unregisterCleanup;

  // 在应用状态中注册任务
  registerTask(taskState, setAppState);
  return taskState;
}

// 任务ID与后台信号解析函数的映射表
// 调用 backgroundAgentTask 时会解析对应的 Promise
const backgroundSignalResolvers = new Map<string, () => void>();

/**
 * 注册前台智能体任务，支持后续转为后台运行
 * 当智能体运行时间足够显示后台提示时调用
 * @returns 包含任务ID和后台信号Promise的对象
 */
export function registerAgentForeground({
  agentId,
  description,
  prompt,
  selectedAgent,
  setAppState,
  autoBackgroundMs,
  toolUseId
}: {
  agentId: string;
  description: string;
  prompt: string;
  selectedAgent: AgentDefinition;
  setAppState: SetAppState;
  autoBackgroundMs?: number;
  toolUseId?: string;
}): {
  taskId: string;
  backgroundSignal: Promise<void>;
  cancelAutoBackground?: () => void;
} {
  void initTaskOutputAsSymlink(agentId, getAgentTranscriptPath(asAgentId(agentId)));
  const abortController = createAbortController();
  const unregisterCleanup = registerCleanup(async () => {
    killAsyncAgent(agentId, setAppState);
  });

  const taskState: LocalAgentTaskState = {
    ...createTaskStateBase(agentId, 'local_agent', description, toolUseId),
    type: 'local_agent',
    status: 'running',
    agentId,
    prompt,
    selectedAgent,
    agentType: selectedAgent.agentType ?? 'general-purpose',
    abortController,
    unregisterCleanup,
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: false, // 初始前台运行
    pendingMessages: [],
    retain: false,
    diskLoaded: false
  };

  // 创建后台切换信号 Promise
  let resolveBackgroundSignal: () => void;
  const backgroundSignal = new Promise<void>(resolve => {
    resolveBackgroundSignal = resolve;
  });
  backgroundSignalResolvers.set(agentId, resolveBackgroundSignal!);
  registerTask(taskState, setAppState);

  // 配置超时自动后台运行
  let cancelAutoBackground: (() => void) | undefined;
  if (autoBackgroundMs !== undefined && autoBackgroundMs > 0) {
    const timer = setTimeout((setAppState, agentId) => {
      // 标记任务为后台运行并触发信号
      setAppState(prev => {
        const prevTask = prev.tasks[agentId];
        if (!isLocalAgentTask(prevTask) || prevTask.isBackgrounded) {
          return prev;
        }
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [agentId]: {
              ...prevTask,
              isBackgrounded: true
            }
          }
        };
      });

      const resolver = backgroundSignalResolvers.get(agentId);
      if (resolver) {
        resolver();
        backgroundSignalResolvers.delete(agentId);
      }
    }, autoBackgroundMs, setAppState, agentId);

    cancelAutoBackground = () => clearTimeout(timer);
  }

  return {
    taskId: agentId,
    backgroundSignal,
    cancelAutoBackground
  };
}

/**
 * 将前台智能体任务转为后台运行
 * @returns 成功切换返回 true，否则返回 false
 */
export function backgroundAgentTask(taskId: string, getAppState: () => AppState, setAppState: SetAppState): boolean {
  const state = getAppState();
  const task = state.tasks[taskId];
  if (!isLocalAgentTask(task) || task.isBackgrounded) {
    return false;
  }

  // 更新状态为后台运行
  setAppState(prev => {
    const prevTask = prev.tasks[taskId];
    if (!isLocalAgentTask(prevTask)) {
      return prev;
    }
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: {
          ...prevTask,
          isBackgrounded: true
        }
      }
    };
  });

  // 触发后台信号中断智能体循环
  const resolver = backgroundSignalResolvers.get(taskId);
  if (resolver) {
    resolver();
    backgroundSignalResolvers.delete(taskId);
  }

  return true;
}

/**
 * 注销前台智能体任务（任务完成且未转为后台时调用）
 */
export function unregisterAgentForeground(taskId: string, setAppState: SetAppState): void {
  // 清理后台信号解析器
  backgroundSignalResolvers.delete(taskId);
  let cleanupFn: (() => void) | undefined;

  setAppState(prev => {
    const task = prev.tasks[taskId];
    // 仅移除前台任务（未后台运行）
    if (!isLocalAgentTask(task) || task.isBackgrounded) {
      return prev;
    }

    // 捕获清理函数，在状态更新器外部执行
    cleanupFn = task.unregisterCleanup;
    const {
      [taskId]: removed,
      ...rest
    } = prev.tasks;
    return {
      ...prev,
      tasks: rest
    };
  });

  // 在状态更新器外部执行清理，避免副作用
  cleanupFn?.();
}