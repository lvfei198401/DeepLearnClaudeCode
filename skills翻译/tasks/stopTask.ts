// 用于停止正在运行任务的共享逻辑
// 由 TaskStopTool（大模型调用）和 SDK stop_task 控制请求使用

import type { AppState } from '../state/AppState.js'
import type { TaskStateBase } from '../Task.js'
import { getTaskByType } from '../tasks.js'
import { emitTaskTerminatedSdk } from '../utils/sdkEventQueue.js'
import { isLocalShellTask } from './LocalShellTask/guards.js'

export class StopTaskError extends Error {
  constructor(
    message: string,
    public readonly code: 'not_found' | 'not_running' | 'unsupported_type',
  ) {
    super(message)
    this.name = 'StopTaskError'
  }
}

/** 停止任务的上下文类型 */
type StopTaskContext = {
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
}

/** 停止任务的返回结果类型 */
type StopTaskResult = {
  taskId: string
  taskType: string
  command: string | undefined
}

/**
 * 根据ID查找任务，校验任务是否正在运行，终止任务并标记为已通知
 *
 * 当任务无法停止时（未找到、未运行或不支持的任务类型），抛出 {@link StopTaskError}
 * 调用方可以通过 error.code 区分具体的失败原因
 */
export async function stopTask(
  taskId: string,
  context: StopTaskContext,
): Promise<StopTaskResult> {
  const { getAppState, setAppState } = context
  const appState = getAppState()
  const task = appState.tasks?.[taskId] as TaskStateBase | undefined

  if (!task) {
    throw new StopTaskError(`未找到ID为：${taskId}的任务`, 'not_found')
  }

  if (task.status !== 'running') {
    throw new StopTaskError(
      `任务 ${taskId} 未处于运行状态（当前状态：${task.status}）`,
      'not_running',
    )
  }

  const taskImpl = getTaskByType(task.type)
  if (!taskImpl) {
    throw new StopTaskError(
      `不支持的任务类型：${task.type}`,
      'unsupported_type',
    )
  }

  await taskImpl.kill(taskId, setAppState)

  // Bash 任务：屏蔽「退出码137」通知（无意义信息）
  // 智能体任务：不屏蔽 - 由 AbortError 捕获发送携带 extractPartialResult(agentMessages) 的通知，该内容为有效载荷而非冗余信息
  if (isLocalShellTask(task)) {
    let suppressed = false
    setAppState(prev => {
      const prevTask = prev.tasks[taskId]
      if (!prevTask || prevTask.notified) {
        return prev
      }
      suppressed = true
      return {
        ...prev,
        tasks: {
          ...prev.tasks,
          [taskId]: { ...prevTask, notified: true },
        },
      }
    })
    // 屏蔽XML通知的同时会屏蔽 print.ts 解析的 task_notification SDK 事件
    // 直接触发该事件，确保 SDK 调用方感知到任务关闭
    if (suppressed) {
      emitTaskTerminatedSdk(taskId, 'stopped', {
        toolUseId: task.toolUseId,
        summary: task.description,
      })
    }
  }

  const command = isLocalShellTask(task) ? task.command : task.description

  return { taskId, taskType: task.type, command }
}