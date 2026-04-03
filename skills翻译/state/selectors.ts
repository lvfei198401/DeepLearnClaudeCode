/**
 * 从应用状态中派生出计算状态的选择器。
 * 保持选择器纯粹简洁——仅用于数据提取，无副作用。
 */

import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { AppState } from './AppStateStore.js'

/**
 * 获取当前查看的队友任务（如果存在）。
 * 在以下情况返回 undefined：
 * - 未查看任何队友（viewingAgentTaskId 为 undefined）
 * - 任务 ID 不存在于任务列表中
 * - 该任务不是进行中的队友任务
 */
export function getViewedTeammateTask(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks'>,
): InProcessTeammateTaskState | undefined {
  const { viewingAgentTaskId, tasks } = appState

  // 未查看任何队友
  if (!viewingAgentTaskId) {
    return undefined
  }

  // 查找任务
  const task = tasks[viewingAgentTaskId]
  if (!task) {
    return undefined
  }

  // 验证是否为进行中的队友任务
  if (!isInProcessTeammateTask(task)) {
    return undefined
  }

  return task
}

/**
 * getActiveAgentForInput 选择器的返回类型。
 * 用于类型安全的输入路由的可辨识联合类型。
 */
export type ActiveAgentForInput =
  | { type: 'leader' }
  | { type: 'viewed'; task: InProcessTeammateTaskState }
  | { type: 'named_agent'; task: LocalAgentTaskState }

/**
 * 确定用户输入应路由到的目标。
 * 返回：
 * - { type: 'leader' }：未查看队友时（输入发送给主代理）
 * - { type: 'viewed', task }：查看代理时（输入发送给该代理）
 *
 * 供输入路由逻辑使用，将用户消息导向正确的代理。
 */
export function getActiveAgentForInput(
  appState: AppState,
): ActiveAgentForInput {
  const viewedTask = getViewedTeammateTask(appState)
  if (viewedTask) {
    return { type: 'viewed', task: viewedTask }
  }

  const { viewingAgentTaskId, tasks } = appState
  if (viewingAgentTaskId) {
    const task = tasks[viewingAgentTaskId]
    if (task?.type === 'local_agent') {
      return { type: 'named_agent', task }
    }
  }

  return { type: 'leader' }
}