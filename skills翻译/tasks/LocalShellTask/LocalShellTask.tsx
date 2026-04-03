import { feature } from 'bun:bundle';
import { stat } from 'fs/promises';
import { OUTPUT_FILE_TAG, STATUS_TAG, SUMMARY_TAG, TASK_ID_TAG, TASK_NOTIFICATION_TAG, TOOL_USE_ID_TAG } from '../../constants/xml.js';
import { abortSpeculation } from '../../services/PromptSuggestion/speculation.js';
import type { AppState } from '../../state/AppState.js';
import type { LocalShellSpawnInput, SetAppState, Task, TaskContext, TaskHandle } from '../../Task.js';
import { createTaskStateBase } from '../../Task.js';
import type { AgentId } from '../../types/ids.js';
import { registerCleanup } from '../../utils/cleanupRegistry.js';
import { tailFile } from '../../utils/fsOperations.js';
import { logError } from '../../utils/log.js';
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js';
import type { ShellCommand } from '../../utils/ShellCommand.js';
import { evictTaskOutput, getTaskOutputPath } from '../../utils/task/diskOutput.js';
import { registerTask, updateTaskState } from '../../utils/task/framework.js';
import { escapeXml } from '../../utils/xml.js';
import { backgroundAgentTask, isLocalAgentTask } from '../LocalAgentTask/LocalAgentTask.js';
import { isMainSessionTask } from '../LocalMainSessionTask.js';
import { type BashTaskKind, isLocalShellTask, type LocalShellTaskState } from './guards.js';
import { killTask } from './killShellTasks.js';

/** 用于向UI折叠转换标识LocalShellTask摘要的前缀 */
export const BACKGROUND_BASH_SUMMARY_PREFIX = 'Background command ';
// 卡顿检查间隔时间（毫秒）
const STALL_CHECK_INTERVAL_MS = 5_000;
// 卡顿阈值时间（毫秒）
const STALL_THRESHOLD_MS = 45_000;
// 读取文件末尾的字节数
const STALL_TAIL_BYTES = 1024;

// 表示命令正在等待键盘输入的末行匹配模式。
// 用于控制卡顿通知——对于仅执行缓慢的命令（如git log -S、长时间构建）保持静默，
// 仅当文件末尾看起来是模型可处理的交互式提示符时才发送通知。详见CC-1175。
const PROMPT_PATTERNS = [/\(y\/n\)/i,
// (Y/n), (y/N)
/\[y\/n\]/i,
// [Y/n], [y/N]
/\(yes\/no\)/i, /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
// 定向提问
/Press (any key|Enter)/i, /Continue\?/i, /Overwrite\?/i];
/**
 * 判断文本末尾是否为交互式提示符
 * @param tail 文本末尾内容
 * @returns 是提示符返回true，否则返回false
 */
export function looksLikePrompt(tail: string): boolean {
  const lastLine = tail.trimEnd().split('\n').pop() ?? '';
  return PROMPT_PATTERNS.some(p => p.test(lastLine));
}

// 输出端的peekForStdinData（utils/process.ts）对应功能：
// 如果输出停止增长且末尾看起来是提示符，则触发一次性通知。
/**
 * 启动卡顿监控定时器：检测命令是否因等待交互式输入而停滞
 * @param taskId 任务ID
 * @param description 任务描述
 * @param kind Bash任务类型
 * @param toolUseId 工具调用ID
 * @param agentId 智能体ID
 * @returns 取消监控的函数
 */
function startStallWatchdog(taskId: string, description: string, kind: BashTaskKind | undefined, toolUseId?: string, agentId?: AgentId): () => void {
  if (kind === 'monitor') return () => {};
  const outputPath = getTaskOutputPath(taskId);
  let lastSize = 0;
  let lastGrowth = Date.now();
  let cancelled = false;
  const timer = setInterval(() => {
    void stat(outputPath).then(s => {
      if (s.size > lastSize) {
        lastSize = s.size;
        lastGrowth = Date.now();
        return;
      }
      if (Date.now() - lastGrowth < STALL_THRESHOLD_MS) return;
      void tailFile(outputPath, STALL_TAIL_BYTES).then(({
        content
      }) => {
        if (cancelled) return;
        if (!looksLikePrompt(content)) {
          // 不是提示符——继续监控。重置时间，下次检查将在45秒后，而非每次轮询都读取末尾
          lastGrowth = Date.now();
          return;
        }
        // 在异步边界可见的副作用前锁定状态，避免重叠的定时器回调执行
        cancelled = true;
        clearInterval(timer);
        const toolUseIdLine = toolUseId ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>` : '';
        const summary = `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" 似乎正在等待交互式输入`;
        // 不包含<status>标签——print.ts会将<status>视为终端信号，未知值会默认判定为'completed'，
        // 导致SDK消费者错误地关闭任务。无状态通知会被SDK发射器跳过（进度心跳）
        const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>
最后输出：
${content.trimEnd()}

命令可能因交互式提示符阻塞。终止此任务，并使用管道输入（例如 \`echo y | command\`）或非交互式标志重新运行（如果存在）。`;
        enqueuePendingNotification({
          value: message,
          mode: 'task-notification',
          priority: 'next',
          agentId
        });
      }, () => {});
    }, () => {} // 文件可能尚未创建
    );
  }, STALL_CHECK_INTERVAL_MS);
  timer.unref();
  return () => {
    cancelled = true;
    clearInterval(timer);
  };
}
/**
 * 加入Shell任务执行结果通知队列
 * @param taskId 任务ID
 * @param description 任务描述
 * @param status 任务状态：完成/失败/已终止
 * @param exitCode 退出码
 * @param setAppState 设置应用状态的函数
 * @param toolUseId 工具调用ID
 * @param kind Bash任务类型
 * @param agentId 智能体ID
 */
function enqueueShellNotification(taskId: string, description: string, status: 'completed' | 'failed' | 'killed', exitCode: number | undefined, setAppState: SetAppState, toolUseId?: string, kind: BashTaskKind = 'bash', agentId?: AgentId): void {
  // 原子性检查并设置已通知标志，防止重复通知
  // 如果任务已标记为已通知（例如通过TaskStopTool），则跳过入队，避免向模型发送冗余消息
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
  if (!shouldEnqueue) {
    return;
  }

  // 中止所有活跃的推测执行——后台任务状态已变更，推测结果可能引用过时的任务输出
  // 保留提示建议文本，仅丢弃预计算的响应
  abortSpeculation(setAppState);
  let summary: string;
  if (feature('MONITOR_TOOL') && kind === 'monitor') {
    // 监控器仅用于流式输出（#22764之后）——脚本退出表示流结束，而非"条件满足"
    // 使用独立于bash的前缀，避免监控器完成消息被折叠到"N个后台命令完成"中
    switch (status) {
      case 'completed':
        summary = `监控器 "${description}" 流已结束`;
        break;
      case 'failed':
        summary = `监控器 "${description}" 脚本执行失败${exitCode !== undefined ? ` (退出码 ${exitCode})` : ''}`;
        break;
      case 'killed':
        summary = `监控器 "${description}" 已停止`;
        break;
    }
  } else {
    switch (status) {
      case 'completed':
        summary = `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" 执行完成${exitCode !== undefined ? ` (退出码 ${exitCode})` : ''}`;
        break;
      case 'failed':
        summary = `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" 执行失败${exitCode !== undefined ? `，退出码 ${exitCode}` : ''}`;
        break;
      case 'killed':
        summary = `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" 已被停止`;
        break;
    }
  }
  const outputPath = getTaskOutputPath(taskId);
  const toolUseIdLine = toolUseId ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>` : '';
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`;
  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    priority: feature('MONITOR_TOOL') ? 'next' : 'later',
    agentId
  });
}
/** 本地Shell任务定义 */
export const LocalShellTask: Task = {
  name: 'LocalShellTask',
  type: 'local_bash',
  async kill(taskId, setAppState) {
    killTask(taskId, setAppState);
  }
};
/**
 * 创建并启动Shell任务
 * @param input 任务输入参数
 * @param context 任务上下文
 * @returns 任务句柄
 */
export async function spawnShellTask(input: LocalShellSpawnInput & {
  shellCommand: ShellCommand;
}, context: TaskContext): Promise<TaskHandle> {
  const {
    command,
    description,
    shellCommand,
    toolUseId,
    agentId,
    kind
  } = input;
  const {
    setAppState
  } = context;

  // 任务输出管理数据——使用其taskId保证磁盘写入一致性
  const {
    taskOutput
  } = shellCommand;
  const taskId = taskOutput.taskId;
  const unregisterCleanup = registerCleanup(async () => {
    killTask(taskId, setAppState);
  });
  const taskState: LocalShellTaskState = {
    ...createTaskStateBase(taskId, 'local_bash', description, toolUseId),
    type: 'local_bash',
    status: 'running',
    command,
    completionStatusSentInAttachment: false,
    shellCommand,
    unregisterCleanup,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    agentId,
    kind
  };
  registerTask(taskState, setAppState);

  // 数据自动通过TaskOutput流动——无需监听流
  // 仅切换到后台运行状态，使进程持续执行
  shellCommand.background(taskId);
  const cancelStallWatchdog = startStallWatchdog(taskId, description, kind, toolUseId, agentId);
  void shellCommand.result.then(async result => {
    cancelStallWatchdog();
    await flushAndCleanup(shellCommand);
    let wasKilled = false;
    updateTaskState<LocalShellTaskState>(taskId, setAppState, task => {
      if (task.status === 'killed') {
        wasKilled = true;
        return task;
      }
      return {
        ...task,
        status: result.code === 0 ? 'completed' : 'failed',
        result: {
          code: result.code,
          interrupted: result.interrupted
        },
        shellCommand: null,
        unregisterCleanup: undefined,
        endTime: Date.now()
      };
    });
    enqueueShellNotification(taskId, description, wasKilled ? 'killed' : result.code === 0 ? 'completed' : 'failed', result.code, setAppState, toolUseId, kind, agentId);
    void evictTaskOutput(taskId);
  });
  return {
    taskId,
    cleanup: () => {
      unregisterCleanup();
    }
  };
}

/**
 * 注册前台任务，后续可转为后台任务
 * 当bash命令运行足够长时间显示后台提示时调用
 * @returns 注册的任务ID
 */
export function registerForeground(input: LocalShellSpawnInput & {
  shellCommand: ShellCommand;
}, setAppState: SetAppState, toolUseId?: string): string {
  const {
    command,
    description,
    shellCommand,
    agentId
  } = input;
  const taskId = shellCommand.taskOutput.taskId;
  const unregisterCleanup = registerCleanup(async () => {
    killTask(taskId, setAppState);
  });
  const taskState: LocalShellTaskState = {
    ...createTaskStateBase(taskId, 'local_bash', description, toolUseId),
    type: 'local_bash',
    status: 'running',
    command,
    completionStatusSentInAttachment: false,
    shellCommand,
    unregisterCleanup,
    lastReportedTotalLines: 0,
    isBackgrounded: false,
    // 暂未后台运行——前台执行中
    agentId
  };
  registerTask(taskState, setAppState);
  return taskId;
}

/**
 * 将指定前台任务转为后台运行
 * @returns 转换成功返回true，否则返回false
 */
function backgroundTask(taskId: string, getAppState: () => AppState, setAppState: SetAppState): boolean {
  // 步骤1：从当前状态获取任务和Shell命令
  const state = getAppState();
  const task = state.tasks[taskId];
  if (!isLocalShellTask(task) || task.isBackgrounded || !task.shellCommand) {
    return false;
  }
  const shellCommand = task.shellCommand;
  const description = task.description;
  const {
    toolUseId,
    kind,
    agentId
  } = task;

  // 切换为后台运行——TaskOutput自动持续接收数据
  if (!shellCommand.background(taskId)) {
    return false;
  }
  setAppState(prev => {
    const prevTask = prev.tasks[taskId];
    if (!isLocalShellTask(prevTask) || prevTask.isBackgrounded) {
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
  const cancelStallWatchdog = startStallWatchdog(taskId, description, kind, toolUseId, agentId);

  // 设置结果处理函数
  void shellCommand.result.then(async result => {
    cancelStallWatchdog();
    await flushAndCleanup(shellCommand);
    let wasKilled = false;
    let cleanupFn: (() => void) | undefined;
    updateTaskState<LocalShellTaskState>(taskId, setAppState, t => {
      if (t.status === 'killed') {
        wasKilled = true;
        return t;
      }

      // 捕获清理函数，在状态更新器外部调用
      cleanupFn = t.unregisterCleanup;
      return {
        ...t,
        status: result.code === 0 ? 'completed' : 'failed',
        result: {
          code: result.code,
          interrupted: result.interrupted
        },
        shellCommand: null,
        unregisterCleanup: undefined,
        endTime: Date.now()
      };
    });

    // 在状态更新器外部调用清理（避免更新器中产生副作用）
    cleanupFn?.();
    if (wasKilled) {
      enqueueShellNotification(taskId, description, 'killed', result.code, setAppState, toolUseId, kind, agentId);
    } else {
      const finalStatus = result.code === 0 ? 'completed' : 'failed';
      enqueueShellNotification(taskId, description, finalStatus, result.code, setAppState, toolUseId, kind, agentId);
    }
    void evictTaskOutput(taskId);
  });
  return true;
}

/**
 * 将所有前台任务转为后台运行（bash命令和智能体）
 * 用户按下Ctrl+B时调用，后台运行所有正在执行的任务
 */
/**
 * 检查是否存在可转为后台的前台任务（bash或智能体）
 * 用于判断Ctrl+B应后台运行现有任务还是后台会话
 */
export function hasForegroundTasks(state: AppState): boolean {
  return Object.values(state.tasks).some(task => {
    if (isLocalShellTask(task) && !task.isBackgrounded && task.shellCommand) {
      return true;
    }
    // 排除主会话任务——它们在主视图显示，而非前台任务
    if (isLocalAgentTask(task) && !task.isBackgrounded && !isMainSessionTask(task)) {
      return true;
    }
    return false;
  });
}
/**
 * 将所有前台任务转为后台运行
 * @param getAppState 获取应用状态的函数
 * @param setAppState 设置应用状态的函数
 */
export function backgroundAll(getAppState: () => AppState, setAppState: SetAppState): void {
  const state = getAppState();

  // 后台运行所有前台bash任务
  const foregroundBashTaskIds = Object.keys(state.tasks).filter(id => {
    const task = state.tasks[id];
    return isLocalShellTask(task) && !task.isBackgrounded && task.shellCommand;
  });
  for (const taskId of foregroundBashTaskIds) {
    backgroundTask(taskId, getAppState, setAppState);
  }

  // 后台运行所有前台智能体任务
  const foregroundAgentTaskIds = Object.keys(state.tasks).filter(id => {
    const task = state.tasks[id];
    return isLocalAgentTask(task) && !task.isBackgrounded;
  });
  for (const taskId of foregroundAgentTaskIds) {
    backgroundAgentTask(taskId, getAppState, setAppState);
  }
}

/**
 * 直接将已注册的前台任务转为后台运行
 * 与spawn()不同，此方法不会重新注册任务——仅翻转现有注册的isBackgrounded状态
 * 并设置完成处理函数。
 * 用于自动后台定时器在registerForeground()已注册任务后触发时
 * （避免重复的task_started SDK事件和泄漏的清理回调）
 */
export function backgroundExistingForegroundTask(taskId: string, shellCommand: ShellCommand, description: string, setAppState: SetAppState, toolUseId?: string): boolean {
  if (!shellCommand.background(taskId)) {
    return false;
  }
  let agentId: AgentId | undefined;
  setAppState(prev => {
    const prevTask = prev.tasks[taskId];
    if (!isLocalShellTask(prevTask) || prevTask.isBackgrounded) {
      return prev;
    }
    agentId = prevTask.agentId;
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
  const cancelStallWatchdog = startStallWatchdog(taskId, description, undefined, toolUseId, agentId);

  // 设置结果处理函数（与backgroundTask的处理逻辑一致）
  void shellCommand.result.then(async result => {
    cancelStallWatchdog();
    await flushAndCleanup(shellCommand);
    let wasKilled = false;
    let cleanupFn: (() => void) | undefined;
    updateTaskState<LocalShellTaskState>(taskId, setAppState, t => {
      if (t.status === 'killed') {
        wasKilled = true;
        return t;
      }
      cleanupFn = t.unregisterCleanup;
      return {
        ...t,
        status: result.code === 0 ? 'completed' : 'failed',
        result: {
          code: result.code,
          interrupted: result.interrupted
        },
        shellCommand: null,
        unregisterCleanup: undefined,
        endTime: Date.now()
      };
    });
    cleanupFn?.();
    const finalStatus = wasKilled ? 'killed' : result.code === 0 ? 'completed' : 'failed';
    enqueueShellNotification(taskId, description, finalStatus, result.code, setAppState, toolUseId, undefined, agentId);
    void evictTaskOutput(taskId);
  });
  return true;
}

/**
 * 标记任务为已通知，抑制待处理的enqueueShellNotification
 * 用于后台运行与任务完成发生竞态时——工具结果已携带完整输出，
 * <task_notification>会产生冗余
 */
export function markTaskNotified(taskId: string, setAppState: SetAppState): void {
  updateTaskState(taskId, setAppState, t => t.notified ? t : {
    ...t,
    notified: true
  });
}

/**
 * 命令未转为后台直接完成时，注销前台任务
 */
export function unregisterForeground(taskId: string, setAppState: SetAppState): void {
  let cleanupFn: (() => void) | undefined;
  setAppState(prev => {
    const task = prev.tasks[taskId];
    // 仅移除前台任务（未后台运行的）
    if (!isLocalShellTask(task) || task.isBackgrounded) {
      return prev;
    }

    // 捕获清理函数，在状态更新器外部调用
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

  // 在状态更新器外部调用清理（避免更新器中产生副作用）
  cleanupFn?.();
}
/**
 * 刷新输出缓冲区并执行Shell命令清理
 * @param shellCommand Shell命令实例
 */
async function flushAndCleanup(shellCommand: ShellCommand): Promise<void> {
  try {
    await shellCommand.taskOutput.flush();
    shellCommand.cleanup();
  } catch (error) {
    logError(error);
  }
}