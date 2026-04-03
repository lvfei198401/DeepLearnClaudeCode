// LocalShellTask 的纯工具函数（非 React 相关），用于终止任务
// 提取该模块是为了让 runAgent.ts 能够终止代理作用域内的 bash 任务，同时避免将
// React/Ink 引入其模块依赖图（与 guards.ts 的设计思路一致）

import type { AppState } from '../../state/AppState.js'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { dequeueAllMatching } from '../../utils/messageQueueManager.js'
import { evictTaskOutput } from '../../utils/task/diskOutput.js'
import { updateTaskState } from '../../utils/task/framework.js'
import { isLocalShellTask } from './guards.js'

// 设置应用状态的函数类型
type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

/**
 * 终止指定任务
 * @param taskId 任务ID
 * @param setAppState 设置应用状态的函数
 */
export function killTask(taskId: string, setAppState: SetAppStateFn): void {
  updateTaskState(taskId, setAppState, task => {
    // 任务未运行或不是本地 Shell 任务，直接返回原任务
    if (task.status !== 'running' || !isLocalShellTask(task)) {
      return task
    }

    try {
      logForDebugging(`已请求终止 LocalShellTask 任务：${taskId}`)
      // 终止 shell 命令进程
      task.shellCommand?.kill()
      // 执行清理操作
      task.shellCommand?.cleanup()
    } catch (error) {
      // 记录终止任务时的异常
      logError(error)
    }

    // 注销任务清理函数
    task.unregisterCleanup?.()
    // 清除任务清理超时定时器
    if (task.cleanupTimeoutId) {
      clearTimeout(task.cleanupTimeoutId)
    }

    // 返回更新后的任务状态
    return {
      ...task,
      status: 'killed',
      notified: true,
      shellCommand: null,
      unregisterCleanup: undefined,
      cleanupTimeoutId: undefined,
      endTime: Date.now(),
    }
  })
  // 异步清理任务输出数据
  void evictTaskOutput(taskId)
}

/**
 * 终止指定代理创建的所有正在运行的 bash 任务
 * 在 runAgent.ts 的 finally 代码块中调用，确保后台进程不会超出
 * 创建它的代理的生命周期（避免产生持续 10 天的 fake-logs.sh 僵尸进程）
 */
export function killShellTasksForAgent(
  agentId: AgentId,
  getAppState: () => AppState,
  setAppState: SetAppStateFn,
): void {
  const tasks = getAppState().tasks ?? {}
  // 遍历所有任务
  for (const [taskId, task] of Object.entries(tasks)) {
    if (
      isLocalShellTask(task) &&
      task.agentId === agentId &&
      task.status === 'running'
    ) {
      logForDebugging(
        `killShellTasksForAgent：正在终止孤立的 Shell 任务 ${taskId}（代理 ${agentId} 即将退出）`,
      )
      // 终止符合条件的任务
      killTask(taskId, setAppState)
    }
  }
  // 清理所有发送给该代理的队列通知 —— 其查询循环已退出，无法处理这些通知
  // killTask 会异步发送「已终止」通知，已入队的通知直接丢弃，后续到达的通知
  // 也不会产生影响（无消费者匹配已失效的代理ID）
  dequeueAllMatching(cmd => cmd.agentId === agentId)
}