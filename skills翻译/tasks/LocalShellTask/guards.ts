// LocalShellTask状态的纯类型定义 + 类型守卫
// 从LocalShellTask.tsx中提取，避免非React使用者（通过print.ts调用的stopTask.ts）
// 将React/ink引入模块依赖图

import type { TaskStateBase } from '../../Task.js'
import type { AgentId } from '../../types/ids.js'
import type { ShellCommand } from '../../utils/ShellCommand.js'

export type BashTaskKind = 'bash' | 'monitor'

export type LocalShellTaskState = TaskStateBase & {
  type: 'local_bash' // 保留'local_bash'以兼容持久化的会话状态
  command: string
  result?: {
    code: number
    interrupted: boolean
  }
  completionStatusSentInAttachment: boolean
  shellCommand: ShellCommand | null
  unregisterCleanup?: () => void
  cleanupTimeoutId?: NodeJS.Timeout
  // 记录最后上报的总行数，用于计算增量（来自TaskOutput的总行数）
  lastReportedTotalLines: number
  // 任务是否已后台运行（false=前台运行，true=后台运行）
  isBackgrounded: boolean
  // 创建此任务的代理ID。用于代理退出时杀死孤立的bash任务
  // （参考killShellTasksForAgent）。未定义则代表主线程
  agentId?: AgentId
  // UI展示类型。'monitor'→显示描述而非命令，
  // 展示'监控详情'对话框标题，使用独立的状态栏标签
  kind?: BashTaskKind
}

export function isLocalShellTask(task: unknown): task is LocalShellTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'local_bash'
  )
}