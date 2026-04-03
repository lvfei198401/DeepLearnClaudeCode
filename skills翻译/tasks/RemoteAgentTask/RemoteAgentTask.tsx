import type { ToolUseBlock } from '@anthropic-ai/sdk/resources';
import { getRemoteSessionUrl } from '../../constants/product.js';
import { OUTPUT_FILE_TAG, REMOTE_REVIEW_PROGRESS_TAG, REMOTE_REVIEW_TAG, STATUS_TAG, SUMMARY_TAG, TASK_ID_TAG, TASK_NOTIFICATION_TAG, TASK_TYPE_TAG, TOOL_USE_ID_TAG, ULTRAPLAN_TAG } from '../../constants/xml.js';
import type { SDKAssistantMessage, SDKMessage } from '../../entrypoints/agentSdkTypes.js';
import type { SetAppState, Task, TaskContext, TaskStateBase } from '../../Task.js';
import { createTaskStateBase, generateTaskId } from '../../Task.js';
import { TodoWriteTool } from '../../tools/TodoWriteTool/TodoWriteTool.js';
import { type BackgroundRemoteSessionPrecondition, checkBackgroundRemoteSessionEligibility } from '../../utils/background/remote/remoteSession.js';
import { logForDebugging } from '../../utils/debug.js';
import { logError } from '../../utils/log.js';
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js';
import { extractTag, extractTextContent } from '../../utils/messages.js';
import { emitTaskTerminatedSdk } from '../../utils/sdkEventQueue.js';
import { deleteRemoteAgentMetadata, listRemoteAgentMetadata, type RemoteAgentMetadata, writeRemoteAgentMetadata } from '../../utils/sessionStorage.js';
import { jsonStringify } from '../../utils/slowOperations.js';
import { appendTaskOutput, evictTaskOutput, getTaskOutputPath, initTaskOutput } from '../../utils/task/diskOutput.js';
import { registerTask, updateTaskState } from '../../utils/task/framework.js';
import { fetchSession } from '../../utils/teleport/api.js';
import { archiveRemoteSession, pollRemoteSessionEvents } from '../../utils/teleport.js';
import type { TodoList } from '../../utils/todo/types.js';
import type { UltraplanPhase } from '../../utils/ultraplan/ccrSession.js';

/** 远程代理任务状态 */
export type RemoteAgentTaskState = TaskStateBase & {
  type: 'remote_agent';
  remoteTaskType: RemoteTaskType;
  /** 任务专属元数据（PR编号、仓库等） */
  remoteTaskMetadata?: RemoteTaskMetadata;
  sessionId: string; // API调用的原始会话ID
  command: string;
  title: string;
  todoList: TodoList;
  log: SDKMessage[];
  /**
   * 长时运行代理，首次返回`result`后不会标记为完成
   */
  isLongRunning?: boolean;
  /**
   * 本地轮询器开始监听此任务的时间（创建或恢复时）
   * 审核超时从此刻计时，避免恢复时立即超时已创建超过30分钟的任务
   */
  pollStartedAt: number;
  /** 由远程/ultrareview命令创建的任务为true */
  isRemoteReview?: boolean;
  /** 从调度器的<remote-review-progress>心跳响应中解析 */
  reviewProgress?: {
    stage?: 'finding' | 'verifying' | 'synthesizing';
    bugsFound: number;
    bugsVerified: number;
    bugsRefuted: number;
  };
  isUltraplan?: boolean;
  /**
   * 扫描器生成的状态标识。未定义=运行中。远程提出澄清问题并闲置时为`needs_input`；
   * 退出计划模式等待浏览器批准时为`plan_ready`。显示在状态徽章和详情对话框状态行
   */
  ultraplanPhase?: Exclude<UltraplanPhase, 'running'>;
};

/** 远程任务类型常量 */
const REMOTE_TASK_TYPES = ['remote-agent', 'ultraplan', 'ultrareview', 'autofix-pr', 'background-pr'] as const;
export type RemoteTaskType = (typeof REMOTE_TASK_TYPES)[number];

/** 校验是否为合法远程任务类型 */
function isRemoteTaskType(v: string | undefined): v is RemoteTaskType {
  return (REMOTE_TASK_TYPES as readonly string[]).includes(v ?? '');
}

/** PR自动修复远程任务元数据 */
export type AutofixPrRemoteTaskMetadata = {
  owner: string;
  repo: string;
  prNumber: number;
};

export type RemoteTaskMetadata = AutofixPrRemoteTaskMetadata;

/**
 * 对匹配远程任务类型的任务，每次轮询周期调用
 * 返回非空字符串则完成任务（字符串作为通知文本），返回null则继续轮询
 * 调用外部API的校验器需自行限流
 */
export type RemoteTaskCompletionChecker = (remoteTaskMetadata: RemoteTaskMetadata | undefined) => Promise<string | null>;
const completionCheckers = new Map<RemoteTaskType, RemoteTaskCompletionChecker>();

/**
 * 注册远程任务类型的完成校验器
 * 每次轮询周期调用；通过边车的remoteTaskType+remoteTaskMetadata支持--resume恢复
 */
export function registerCompletionChecker(remoteTaskType: RemoteTaskType, checker: RemoteTaskCompletionChecker): void {
  completionCheckers.set(remoteTaskType, checker);
}

/**
 * 将远程代理元数据持久化到会话边车
 * 发后即忘——持久化失败不得阻塞任务注册
 */
async function persistRemoteAgentMetadata(meta: RemoteAgentMetadata): Promise<void> {
  try {
    await writeRemoteAgentMetadata(meta.taskId, meta);
  } catch (e) {
    logForDebugging(`persistRemoteAgentMetadata失败: ${String(e)}`);
  }
}

/**
 * 从会话边车移除远程代理元数据
 * 任务完成/终止时调用，避免恢复会话时重新加载已完成的任务
 */
async function removeRemoteAgentMetadata(taskId: string): Promise<void> {
  try {
    await deleteRemoteAgentMetadata(taskId);
  } catch (e) {
    logForDebugging(`removeRemoteAgentMetadata失败: ${String(e)}`);
  }
}

// 前置条件校验结果
export type RemoteAgentPreconditionResult = {
  eligible: true;
} | {
  eligible: false;
  errors: BackgroundRemoteSessionPrecondition[];
};

/**
 * 检查创建远程代理会话的资格
 */
export async function checkRemoteAgentEligibility({
  skipBundle = false
}: {
  skipBundle?: boolean;
} = {}): Promise<RemoteAgentPreconditionResult> {
  const errors = await checkBackgroundRemoteSessionEligibility({
    skipBundle
  });
  if (errors.length > 0) {
    return {
      eligible: false,
      errors
    };
  }
  return {
    eligible: true
  };
}

/**
 * 格式化前置条件错误信息用于显示
 */
export function formatPreconditionError(error: BackgroundRemoteSessionPrecondition): string {
  switch (error.type) {
    case 'not_logged_in':
      return '请执行/login命令并使用Claude.ai账号登录（非控制台账号）';
    case 'no_remote_environment':
      return '无可用云环境。请访问https://claude.ai/code/onboarding?magic=env-setup进行配置';
    case 'not_in_git_repo':
      return '后台任务需要git仓库。请初始化git或从git仓库目录运行';
    case 'no_git_remote':
      return '后台任务需要GitHub远程仓库。执行`git remote add origin 仓库地址`添加';
    case 'github_app_not_installed':
      return '需先在此仓库安装Claude GitHub应用\nhttps://github.com/apps/claude/installations/new';
    case 'policy_blocked':
      return "组织策略已禁用远程会话。请联系组织管理员启用";
  }
}

/**
 * 将远程任务通知加入消息队列
 */
function enqueueRemoteNotification(taskId: string, title: string, status: 'completed' | 'failed' | 'killed', setAppState: SetAppState, toolUseId?: string): void {
  // 原子检查并设置已通知标志，防止重复通知
  if (!markTaskNotified(taskId, setAppState)) return;
  const statusText = status === 'completed' ? '成功完成' : status === 'failed' ? '失败' : '已停止';
  const toolUseIdLine = toolUseId ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>` : '';
  const outputPath = getTaskOutputPath(taskId);
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${TASK_TYPE_TAG}>remote_agent</${TASK_TYPE_TAG}>
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>远程任务"${title}"${statusText}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`;
  enqueuePendingNotification({
    value: message,
    mode: 'task-notification'
  });
}

/**
 * 原子标记任务为已通知
 * 若本次调用切换标志返回true（调用方应入队），已通知返回false（调用方跳过）
 */
function markTaskNotified(taskId: string, setAppState: SetAppState): boolean {
  let shouldEnqueue = false;
  updateTaskState(taskId, setAppState, task => {
    if (task.notified) {
      return task;
    }
    shouldEnqueue = true;
    return {
      ...task,
      notified: true
    };
  });
  return shouldEnqueue;
}

/**
 * 从远程会话日志中提取计划内容
 * 搜索所有助手消息中的<ultraplan>...</ultraplan>标签
 */
export function extractPlanFromLog(log: SDKMessage[]): string | null {
  // 反向遍历助手消息查找<ultraplan>内容
  for (let i = log.length - 1; i >= 0; i--) {
    const msg = log[i];
    if (msg?.type !== 'assistant') continue;
    const fullText = extractTextContent(msg.message.content, '\n');
    const plan = extractTag(fullText, ULTRAPLAN_TAG);
    if (plan?.trim()) return plan.trim();
  }
  return null;
}

/**
 * 加入Ultraplan专属失败通知
 * 与enqueueRemoteNotification不同，不指示模型读取原始输出文件（无用的JSONL转储）
 */
export function enqueueUltraplanFailureNotification(taskId: string, sessionId: string, reason: string, setAppState: SetAppState): void {
  if (!markTaskNotified(taskId, setAppState)) return;
  const sessionUrl = getRemoteTaskSessionUrl(sessionId);
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>
<${TASK_TYPE_TAG}>remote_agent</${TASK_TYPE_TAG}>
<${STATUS_TAG}>failed</${STATUS_TAG}>
<${SUMMARY_TAG}>Ultraplan失败: ${reason}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>
远程Ultraplan会话未生成计划（${reason}）。请查看会话${sessionUrl}，告知用户本地使用计划模式重试`;
  enqueuePendingNotification({
    value: message,
    mode: 'task-notification'
  });
}

/**
 * 从远程会话日志中提取审核内容
 *
 * 两种生成源，两种事件格式：
 * - 漏洞检测模式：run_hunt.sh为会话启动钩子；其输出为{type:'system', subtype:'hook_progress', stdout:'...'}
 *   Claude无交互轮次，无助手消息
 * - 提示模式：真实助手轮次将审核内容包裹在标签中
 *
 * 优先扫描hook_progress，漏洞检测为生产路径，提示模式为开发/备用
 * 两种模式均最新优先——标签仅在运行结束出现，反向遍历可快速终止
 */
function extractReviewFromLog(log: SDKMessage[]): string | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const msg = log[i];
    // 钩子退出前的最终输出可能在最后hook_progress或终端hook_response中，取决于缓冲；均包含stdout
    if (msg?.type === 'system' && (msg.subtype === 'hook_progress' || msg.subtype === 'hook_response')) {
      const tagged = extractTag(msg.stdout, REMOTE_REVIEW_TAG);
      if (tagged?.trim()) return tagged.trim();
    }
  }
  for (let i = log.length - 1; i >= 0; i--) {
    const msg = log[i];
    if (msg?.type !== 'assistant') continue;
    const fullText = extractTextContent(msg.message.content, '\n');
    const tagged = extractTag(fullText, REMOTE_REVIEW_TAG);
    if (tagged?.trim()) return tagged.trim();
  }

  // 钩子输出拼接备用：单个输出应在一个事件中，但大JSON负载可能因管道缓冲区满拆分
  // 上述单消息扫描会遗漏跨事件拆分的标签
  const hookStdout = log.filter(msg => msg.type === 'system' && (msg.subtype === 'hook_progress' || msg.subtype === 'hook_response')).map(msg => msg.stdout).join('');
  const hookTagged = extractTag(hookStdout, REMOTE_REVIEW_TAG);
  if (hookTagged?.trim()) return hookTagged.trim();

  // 备用方案：按时间顺序拼接所有助手文本
  const allText = log.filter((msg): msg is SDKAssistantMessage => msg.type === 'assistant').map(msg => extractTextContent(msg.message.content, '\n')).join('\n').trim();
  return allText || null;
}

/**
 * extractReviewFromLog的纯标签版本，用于增量扫描
 *
 * 仅当找到显式<remote-review>标签时返回非空
 * 与extractReviewFromLog不同，不回退到拼接助手文本
 * 对增量扫描至关重要：提示模式下，早期无标签助手消息会触发回退，提前设置缓存，导致审核未完成就结束
 */
function extractReviewTagFromLog(log: SDKMessage[]): string | null {
  // hook_progress/hook_response单消息扫描（漏洞检测路径）
  for (let i = log.length - 1; i >= 0; i--) {
    const msg = log[i];
    if (msg?.type === 'system' && (msg.subtype === 'hook_progress' || msg.subtype === 'hook_response')) {
      const tagged = extractTag(msg.stdout, REMOTE_REVIEW_TAG);
      if (tagged?.trim()) return tagged.trim();
    }
  }

  // 助手文本单消息扫描（提示模式）
  for (let i = log.length - 1; i >= 0; i--) {
    const msg = log[i];
    if (msg?.type !== 'assistant') continue;
    const fullText = extractTextContent(msg.message.content, '\n');
    const tagged = extractTag(fullText, REMOTE_REVIEW_TAG);
    if (tagged?.trim()) return tagged.trim();
  }

  // 拆分标签的钩子输出拼接备用
  const hookStdout = log.filter(msg => msg.type === 'system' && (msg.subtype === 'hook_progress' || msg.subtype === 'hook_response')).map(msg => msg.stdout).join('');
  const hookTagged = extractTag(hookStdout, REMOTE_REVIEW_TAG);
  if (hookTagged?.trim()) return hookTagged.trim();
  return null;
}

/**
 * 加入远程审核完成通知
 * 将审核文本直接注入消息队列，本地模型下一轮即可接收
 * 无文件间接调用，无模式切换
 * 会话保持活跃，claude.ai链接为持久记录，TTL自动清理
 */
function enqueueRemoteReviewNotification(taskId: string, reviewContent: string, setAppState: SetAppState): void {
  if (!markTaskNotified(taskId, setAppState)) return;
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>
<${TASK_TYPE_TAG}>remote_agent</${TASK_TYPE_TAG}>
<${STATUS_TAG}>completed</${STATUS_TAG}>
<${SUMMARY_TAG}>远程审核完成</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>
远程审核生成以下结果：

${reviewContent}`;
  enqueuePendingNotification({
    value: message,
    mode: 'task-notification'
  });
}

/**
 * 加入远程审核失败通知
 */
function enqueueRemoteReviewFailureNotification(taskId: string, reason: string, setAppState: SetAppState): void {
  if (!markTaskNotified(taskId, setAppState)) return;
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>
<${TASK_TYPE_TAG}>remote_agent</${TASK_TYPE_TAG}>
<${STATUS_TAG}>failed</${STATUS_TAG}>
<${SUMMARY_TAG}>远程审核失败: ${reason}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>
远程审核未生成输出（${reason}）。请告知用户重试/ultrareview，或使用/review本地审核`;
  enqueuePendingNotification({
    value: message,
    mode: 'task-notification'
  });
}

/**
 * 从SDK消息提取待办列表（查找最后一次TodoWrite工具调用）
 */
function extractTodoListFromLog(log: SDKMessage[]): TodoList {
  const todoListMessage = log.findLast((msg): msg is SDKAssistantMessage => msg.type === 'assistant' && msg.message.content.some(block => block.type === 'tool_use' && block.name === TodoWriteTool.name));
  if (!todoListMessage) {
    return [];
  }
  const input = todoListMessage.message.content.find((block): block is ToolUseBlock => block.type === 'tool_use' && block.name === TodoWriteTool.name)?.input;
  if (!input) {
    return [];
  }
  const parsedInput = TodoWriteTool.inputSchema.safeParse(input);
  if (!parsedInput.success) {
    return [];
  }
  return parsedInput.data.todos;
}

/**
 * 在统一任务框架中注册远程代理任务
 * 整合任务ID生成、输出初始化、状态创建、注册和轮询
 * 调用方负责自定义注册前逻辑（Git对话框、日志上传、远程选项）
 */
export function registerRemoteAgentTask(options: {
  remoteTaskType: RemoteTaskType;
  session: {
    id: string;
    title: string;
  };
  command: string;
  context: TaskContext;
  toolUseId?: string;
  isRemoteReview?: boolean;
  isUltraplan?: boolean;
  isLongRunning?: boolean;
  remoteTaskMetadata?: RemoteTaskMetadata;
}): {
  taskId: string;
  sessionId: string;
  cleanup: () => void;
} {
  const {
    remoteTaskType,
    session,
    command,
    context,
    toolUseId,
    isRemoteReview,
    isUltraplan,
    isLongRunning,
    remoteTaskMetadata
  } = options;
  const taskId = generateTaskId('remote_agent');

  // 注册任务前创建输出文件
  // RemoteAgentTask使用appendTaskOutput()而非TaskOutput，输出到达前文件必须存在
  void initTaskOutput(taskId);
  const taskState: RemoteAgentTaskState = {
    ...createTaskStateBase(taskId, 'remote_agent', session.title, toolUseId),
    type: 'remote_agent',
    remoteTaskType,
    status: 'running',
    sessionId: session.id,
    command,
    title: session.title,
    todoList: [],
    log: [],
    isRemoteReview,
    isUltraplan,
    isLongRunning,
    pollStartedAt: Date.now(),
    remoteTaskMetadata
  };
  registerTask(taskState, context.setAppState);

  // 将标识持久化到会话边车，支持--resume重新连接仍在运行的远程会话
  // 不存储状态——恢复时从CCR重新获取
  void persistRemoteAgentMetadata({
    taskId,
    remoteTaskType,
    sessionId: session.id,
    title: session.title,
    command,
    spawnedAt: Date.now(),
    toolUseId,
    isUltraplan,
    isRemoteReview,
    isLongRunning,
    remoteTaskMetadata
  });

  // Ultraplan生命周期由ultraplan.tsx中的startDetachedPoll管理
  // 通用轮询仍运行，为详情视图进度计数填充session.log
  // 结果查找防护防止提前完成
  const stopPolling = startRemoteSessionPolling(taskId, context);
  return {
    taskId,
    sessionId: session.id,
    cleanup: stopPolling
  };
}

/**
 * --resume时从会话边车恢复远程代理任务
 *
 * 扫描remote-agents/，获取每个任务的CCR实时状态，重建RemoteAgentTaskState到AppState.tasks
 * 重启仍运行会话的轮询
 * 已归档或404的会话删除边车文件
 * 必须在switchSession()后执行，确保getSessionId()指向恢复会话的边车目录
 */
export async function restoreRemoteAgentTasks(context: TaskContext): Promise<void> {
  try {
    await restoreRemoteAgentTasksImpl(context);
  } catch (e) {
    logForDebugging(`restoreRemoteAgentTasks失败: ${String(e)}`);
  }
}

async function restoreRemoteAgentTasksImpl(context: TaskContext): Promise<void> {
  const persisted = await listRemoteAgentMetadata();
  if (persisted.length === 0) return;
  for (const meta of persisted) {
    let remoteStatus: string;
    try {
      const session = await fetchSession(meta.sessionId);
      remoteStatus = session.session_status;
    } catch (e) {
      // 仅404表示CCR会话真正消失
      // 认证错误（401、缺失OAuth令牌）可通过/login恢复——远程会话仍在运行
      // fetchSession对所有4xx抛出普通Error，isTransientNetworkError无法区分，匹配404消息
      if (e instanceof Error && e.message.startsWith('Session not found:')) {
        logForDebugging(`restoreRemoteAgentTasks: 丢弃${meta.taskId} (404: ${String(e)})`);
        void removeRemoteAgentMetadata(meta.taskId);
      } else {
        logForDebugging(`restoreRemoteAgentTasks: 跳过${meta.taskId} (可恢复: ${String(e)})`);
      }
      continue;
    }
    if (remoteStatus === 'archived') {
      // 本地客户端离线时会话结束，不恢复
      void removeRemoteAgentMetadata(meta.taskId);
      continue;
    }
    const taskState: RemoteAgentTaskState = {
      ...createTaskStateBase(meta.taskId, 'remote_agent', meta.title, meta.toolUseId),
      type: 'remote_agent',
      remoteTaskType: isRemoteTaskType(meta.remoteTaskType) ? meta.remoteTaskType : 'remote-agent',
      status: 'running',
      sessionId: meta.sessionId,
      command: meta.command,
      title: meta.title,
      todoList: [],
      log: [],
      isRemoteReview: meta.isRemoteReview,
      isUltraplan: meta.isUltraplan,
      isLongRunning: meta.isLongRunning,
      startTime: meta.spawnedAt,
      pollStartedAt: Date.now(),
      remoteTaskMetadata: meta.remoteTaskMetadata as RemoteTaskMetadata | undefined
    };
    registerTask(taskState, context.setAppState);
    void initTaskOutput(meta.taskId);
    startRemoteSessionPolling(meta.taskId, context);
  }
}

/**
 * 开始轮询远程会话更新
 * 返回停止轮询的清理函数
 */
function startRemoteSessionPolling(taskId: string, context: TaskContext): () => void {
  let isRunning = true;
  const POLL_INTERVAL_MS = 1000;
  const REMOTE_REVIEW_TIMEOUT_MS = 30 * 60 * 1000;
  // 远程会话在工具轮次之间切换为'idle'
  // 100+快速轮次中，1秒轮询会捕获运行中短暂空闲
  // 需连续N次轮询稳定空闲才确认
  const STABLE_IDLE_POLLS = 5;
  let consecutiveIdlePolls = 0;
  let lastEventId: string | null = null;
  let accumulatedLog: SDKMessage[] = [];
  // 跨周期缓存，避免重新扫描完整日志
  // 标签仅在运行结束出现，仅扫描增量（response.newEvents）为O(new)
  let cachedReviewContent: string | null = null;

  const poll = async (): Promise<void> => {
    if (!isRunning) return;
    try {
      const appState = context.getAppState();
      const task = appState.tasks?.[taskId] as RemoteAgentTaskState | undefined;
      if (!task || task.status !== 'running') {
        // 任务已被外部终止或已结束
        // 会话保持活跃，claude.ai链接有效
        // run_hunt.sh的post_stage()会产生助手事件，用户关闭终端后可查看
        return;
      }
      const response = await pollRemoteSessionEvents(task.sessionId, lastEventId);
      lastEventId = response.lastEventId;
      const logGrew = response.newEvents.length > 0;
      if (logGrew) {
        accumulatedLog = [...accumulatedLog, ...response.newEvents];
        const deltaText = response.newEvents.map(msg => {
          if (msg.type === 'assistant') {
            return msg.message.content.filter(block => block.type === 'text').map(block => 'text' in block ? block.text : '').join('\n');
          }
          return jsonStringify(msg);
        }).join('\n');
        if (deltaText) {
          appendTaskOutput(taskId, deltaText + '\n');
        }
      }
      if (response.sessionStatus === 'archived') {
        updateTaskState<RemoteAgentTaskState>(taskId, context.setAppState, t => t.status === 'running' ? {
          ...t,
          status: 'completed',
          endTime: Date.now()
        } : t);
        enqueueRemoteNotification(taskId, task.title, 'completed', context.setAppState, task.toolUseId);
        void evictTaskOutput(taskId);
        void removeRemoteAgentMetadata(taskId);
        return;
      }
      const checker = completionCheckers.get(task.remoteTaskType);
      if (checker) {
        const completionResult = await checker(task.remoteTaskMetadata);
        if (completionResult !== null) {
          updateTaskState<RemoteAgentTaskState>(taskId, context.setAppState, t => t.status === 'running' ? {
            ...t,
            status: 'completed',
            endTime: Date.now()
          } : t);
          enqueueRemoteNotification(taskId, completionResult, 'completed', context.setAppState, task.toolUseId);
          void evictTaskOutput(taskId);
          void removeRemoteAgentMetadata(taskId);
          return;
        }
      }

      // Ultraplan：每次CCR轮次触发success，不能驱动完成
      // startDetachedPoll通过ExitPlanMode扫描管理
      // 长时运行监视器（autofix-pr）每个通知周期触发结果，同样跳过
      const result = task.isUltraplan || task.isLongRunning ? undefined : accumulatedLog.findLast(msg => msg.type === 'result');

      // 远程审核：hook_progress stdout中的<remote-review>是漏洞检测模式完成信号
      // 仅扫描增量保持O(new)；标签仅在结束出现，不会跨周期遗漏
      // 失败信号：防抖空闲——远程会话在每个工具轮次间短暂空闲，单次观察无意义
      // 需连续STABLE_IDLE_POLLS次空闲轮询且无日志增长
      if (task.isRemoteReview && logGrew && cachedReviewContent === null) {
        cachedReviewContent = extractReviewTagFromLog(response.newEvents);
      }
      // 从调度器心跳响应解析实时进度计数
      // hook_progress stdout是累积的（钩子启动后所有输出），每个事件包含所有进度标签
      // 获取最后一次出现——extractTag返回第一个匹配，总是最早值（0/0）
      let newProgress: RemoteAgentTaskState['reviewProgress'];
      if (task.isRemoteReview && logGrew) {
        const open = `<${REMOTE_REVIEW_PROGRESS_TAG}>`;
        const close = `</${REMOTE_REVIEW_PROGRESS_TAG}>`;
        for (const ev of response.newEvents) {
          if (ev.type === 'system' && (ev.subtype === 'hook_progress' || ev.subtype === 'hook_response')) {
            const s = ev.stdout;
            const closeAt = s.lastIndexOf(close);
            const openAt = closeAt === -1 ? -1 : s.lastIndexOf(open, closeAt);
            if (openAt !== -1 && closeAt > openAt) {
              try {
                const p = JSON.parse(s.slice(openAt + open.length, closeAt)) as {
                  stage?: 'finding' | 'verifying' | 'synthesizing';
                  bugs_found?: number;
                  bugs_verified?: number;
                  bugs_refuted?: number;
                };
                newProgress = {
                  stage: p.stage,
                  bugsFound: p.bugs_found ?? 0,
                  bugsVerified: p.bugs_verified ?? 0,
                  bugsRefuted: p.bugs_refuted ?? 0
                };
              } catch {
                // 忽略格式错误的进度
              }
            }
          }
        }
      }
      // 钩子事件仅对远程审核视为输出
      // 漏洞检测的SessionStart钩子无助手轮次，无此判断稳定空闲永远不会触发
      const hasAnyOutput = accumulatedLog.some(msg => msg.type === 'assistant' || task.isRemoteReview && msg.type === 'system' && (msg.subtype === 'hook_progress' || msg.subtype === 'hook_response'));
      if (response.sessionStatus === 'idle' && !logGrew && hasAnyOutput) {
        consecutiveIdlePolls++;
      } else {
        consecutiveIdlePolls = 0;
      }
      const stableIdle = consecutiveIdlePolls >= STABLE_IDLE_POLLS;
      // 稳定空闲是提示模式完成信号（Claude停止写入→会话空闲→完成）
      // 漏洞检测模式下，SessionStart钩子运行全程会话为"idle"
      // 之前通过hasAssistantEvents判断提示模式，但post_stage()现在也在漏洞检测模式写入助手事件
      // 导致心跳间误判
      // SessionStart钩子事件是区分依据——漏洞检测模式始终有（run_hunt.sh），提示模式没有
      // 且在启动post_stage()前到达，无竞争
      // 钩子运行时，仅<remote-review>标签或30分钟超时完成任务
      // 过滤hook_event避免提示模式中非SessionStart钩子阻塞稳定空闲
      // code_review容器仅注册SessionStart，但30分钟挂起失败模式值得防护
      const hasSessionStartHook = accumulatedLog.some(m => m.type === 'system' && (m.subtype === 'hook_started' || m.subtype === 'hook_progress' || m.subtype === 'hook_response') && (m as {
        hook_event?: string;
      }).hook_event === 'SessionStart');
      const hasAssistantEvents = accumulatedLog.some(m => m.type === 'assistant');
      const sessionDone = task.isRemoteReview && (cachedReviewContent !== null || !hasSessionStartHook && stableIdle && hasAssistantEvents);
      const reviewTimedOut = task.isRemoteReview && Date.now() - task.pollStartedAt > REMOTE_REVIEW_TIMEOUT_MS;
      const newStatus = result ? result.subtype === 'success' ? 'completed' as const : 'failed' as const : sessionDone || reviewTimedOut ? 'completed' as const : accumulatedLog.length > 0 ? 'running' as const : 'starting' as const;

      // 更新任务状态
      // 防护终止状态——若stopTask在pollRemoteSessionEvents飞行中竞争（状态设为'killed'，notified设为true）
      // 不覆盖状态且不执行副作用（通知、权限模式切换）
      let raceTerminated = false;
      updateTaskState<RemoteAgentTaskState>(taskId, context.setAppState, prevTask => {
        if (prevTask.status !== 'running') {
          raceTerminated = true;
          return prevTask;
        }
        // 无日志增长且状态不变→无更新
        // 返回相同引用，updateTaskState跳过展开，18个s.tasks订阅者不重渲染
        // newProgress仅通过日志增长到达（心跳回声是hook_progress事件），!logGrew已覆盖无更新
        const statusUnchanged = newStatus === 'running' || newStatus === 'starting';
        if (!logGrew && statusUnchanged) {
          return prevTask;
        }
        return {
          ...prevTask,
          status: newStatus === 'starting' ? 'running' : newStatus,
          log: accumulatedLog,
          // 仅日志增长时重新扫描TodoWrite
          // 日志仅追加，无增长意味着无新tool_use块
          // 避免空闲时每秒执行findLast+some+find+safeParse
          todoList: logGrew ? extractTodoListFromLog(accumulatedLog) : prevTask.todoList,
          reviewProgress: newProgress ?? prevTask.reviewProgress,
          endTime: result || sessionDone || reviewTimedOut ? Date.now() : undefined
        };
      });
      if (raceTerminated) return;

      // 任务完成或超时发送通知
      if (result || sessionDone || reviewTimedOut) {
        const finalStatus = result && result.subtype !== 'success' ? 'failed' : 'completed';

        // 远程审核任务：将审核文本直接注入消息队列
        // 无模式切换，无文件间接——本地模型下一轮直接看到审核通知
        // 会话保持活跃——run_hunt.sh的post_stage()已将格式化结果写入助手事件
        // claude.ai链接为持久记录，TTL自动清理
        if (task.isRemoteReview) {
          // 缓存内容在增量扫描命中标签
          // 完整日志扫描捕获稳定空闲路径，标签在更早周期到达但增量扫描未连接（恢复后首次轮询）
          const reviewContent = cachedReviewContent ?? extractReviewFromLog(accumulatedLog);
          if (reviewContent && finalStatus === 'completed') {
            enqueueRemoteReviewNotification(taskId, reviewContent, context.setAppState);
            void evictTaskOutput(taskId);
            void removeRemoteAgentMetadata(taskId);
            return; // 停止轮询
          }

          // 无输出或远程错误——标记失败并发送审核专属消息
          updateTaskState(taskId, context.setAppState, t => ({
            ...t,
            status: 'failed'
          }));
          const reason = result && result.subtype !== 'success' ? '远程会话返回错误' : reviewTimedOut && !sessionDone ? '远程会话超过30分钟' : '无审核输出——调度器可能提前退出';
          enqueueRemoteReviewFailureNotification(taskId, reason, context.setAppState);
          void evictTaskOutput(taskId);
          void removeRemoteAgentMetadata(taskId);
          return; // 停止轮询
        }
        enqueueRemoteNotification(taskId, task.title, finalStatus, context.setAppState, task.toolUseId);
        void evictTaskOutput(taskId);
        void removeRemoteAgentMetadata(taskId);
        return; // 停止轮询
      }
    } catch (error) {
      logError(error);
      // 重置，避免API错误导致非连续空闲轮询累积
      consecutiveIdlePolls = 0;

      // 即使API调用失败也检查审核超时——否则持续API错误会跳过超时检查，永久轮询
      try {
        const appState = context.getAppState();
        const task = appState.tasks?.[taskId] as RemoteAgentTaskState | undefined;
        if (task?.isRemoteReview && task.status === 'running' && Date.now() - task.pollStartedAt > REMOTE_REVIEW_TIMEOUT_MS) {
          updateTaskState(taskId, context.setAppState, t => ({
            ...t,
            status: 'failed',
            endTime: Date.now()
          }));
          enqueueRemoteReviewFailureNotification(taskId, '远程会话超过30分钟', context.setAppState);
          void evictTaskOutput(taskId);
          void removeRemoteAgentMetadata(taskId);
          return; // 停止轮询
        }
      } catch {
        // 尽力而为——getAppState失败则继续轮询
      }
    }

    // 继续轮询
    if (isRunning) {
      setTimeout(poll, POLL_INTERVAL_MS);
    }
  };

  // 启动轮询
  void poll();

  // 返回清理函数
  return () => {
    isRunning = false;
  };
}

/**
 * 远程代理任务 - 处理Claude.ai远程会话执行
 *
 * 替代以下实现：
 * - src/utils/background/remote/remoteSession.ts
 * - src/components/tasks/BackgroundTaskStatus.tsx（轮询逻辑）
 */
export const RemoteAgentTask: Task = {
  name: 'RemoteAgentTask',
  type: 'remote_agent',
  async kill(taskId, setAppState) {
    let toolUseId: string | undefined;
    let description: string | undefined;
    let sessionId: string | undefined;
    let killed = false;
    updateTaskState<RemoteAgentTaskState>(taskId, setAppState, task => {
      if (task.status !== 'running') {
        return task;
      }
      toolUseId = task.toolUseId;
      description = task.description;
      sessionId = task.sessionId;
      killed = true;
      return {
        ...task,
        status: 'killed',
        notified: true,
        endTime: Date.now()
      };
    });

    // 为SDK消费者关闭任务启动闭环
    // 轮询循环状态!=='running'时提前返回，不会发送通知
    if (killed) {
      emitTaskTerminatedSdk(taskId, 'stopped', {
        toolUseId,
        summary: description
      });
      // 归档远程会话，停止消耗云资源
      if (sessionId) {
        void archiveRemoteSession(sessionId).catch(e => logForDebugging(`RemoteAgentTask归档失败: ${String(e)}`));
      }
    }
    void evictTaskOutput(taskId);
    void removeRemoteAgentMetadata(taskId);
    logForDebugging(`RemoteAgentTask ${taskId}已终止，归档会话 ${sessionId ?? '未知'}`);
  }
};

/**
 * 获取远程任务的会话URL
 */
export function getRemoteTaskSessionUrl(sessionId: string): string {
  return getRemoteSessionUrl(sessionId, process.env.SESSION_INGRESS_URL);
}