import type { TaskStateBase } from '../../Task.js'
import type { AgentToolResult } from '../../tools/AgentTool/agentToolUtils.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Message } from '../../types/message.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import type { AgentProgress } from '../LocalAgentTask/LocalAgentTask.js'

/**
 * 存储在任务状态中的队友身份信息。
 * 与队友上下文（运行时）结构相同，但以纯数据形式存储。
 * 队友上下文用于异步本地存储；本类型用于应用状态持久化。
 */
export type TeammateIdentity = {
  agentId: string // 示例："researcher@my-team"
  agentName: string // 示例："researcher"
  teamName: string
  color?: string
  planModeRequired: boolean
  parentSessionId: string // 领导者的会话ID
}

export type InProcessTeammateTaskState = TaskStateBase & {
  type: 'in_process_teammate'

  // 身份信息作为子对象（与队友上下文结构保持一致）
  // 以纯数据形式存储在应用状态中，并非异步本地存储的引用
  identity: TeammateIdentity

  // 执行相关
  prompt: string
  // 为本队友可选覆盖的模型
  model?: string
  // 可选：仅当队友使用特定智能体定义时设置
  // 多数队友作为通用智能体运行，无需预定义
  selectedAgent?: AgentDefinition
  abortController?: AbortController // 仅运行时使用，不序列化到磁盘 - 终止整个队友任务
  currentWorkAbortController?: AbortController // 仅运行时使用 - 终止当前轮次但不终止队友任务
  unregisterCleanup?: () => void // 仅运行时使用

  // 规划模式审批跟踪（planModeRequired 定义在身份信息中）
  awaitingPlanApproval: boolean

  // 本队友的权限模式（查看时通过 Shift+Tab 独立切换）
  permissionMode: PermissionMode

  // 状态相关
  error?: string
  result?: AgentToolResult // 复用现有类型，因队友通过 runAgent() 运行
  progress?: AgentProgress

  // 放大视图的对话历史（非邮箱消息）
  // 邮箱消息单独存储在 teamContext.inProcessMailboxes 中
  messages?: Message[]

  // 当前正在执行的工具调用ID（用于转录视图动画）
  inProgressToolUseIDs?: Set<string>

  // 查看队友转录时待推送的用户消息队列
  pendingUserMessages: string[]

  // 界面：随机加载动画动词（重渲染时保持稳定，组件间共享）
  spinnerVerb?: string
  pastTenseVerb?: string

  // 生命周期
  isIdle: boolean
  shutdownRequested: boolean

  // 队友空闲时通知的回调函数（仅运行时使用）
  // 供领导者高效等待，无需轮询
  onIdleCallbacks?: Array<() => void>

  // 进度跟踪（用于计算通知中的增量）
  lastReportedToolCount: number
  lastReportedTokenCount: number
}

export function isInProcessTeammateTask(
  task: unknown,
): task is InProcessTeammateTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'in_process_teammate'
  )
}

/**
 * 任务消息数组（应用状态界面镜像）的存储数量上限。
 *
 * 任务消息数组仅用于放大转录对话框，仅需最近上下文。
 * 完整对话存储在本地全部消息数组（进程内执行器）和磁盘上的智能体转录路径中。
 *
 * BQ分析（第9轮，2026-03-20）显示：500+轮次会话中每个智能体约占用20MB常驻内存，
 * 集群爆发时每个并发智能体约占用125MB。大型会话9a990de8在2分钟内启动292个智能体，
 * 内存占用达36.8GB。主要开销来自该数组保存的第二份完整消息副本。
 */
export const TEAMMATE_MESSAGES_UI_CAP = 50

/**
 * 向消息数组追加条目，通过移除最旧条目将结果限制在
 * 队友消息界面上限内。始终返回新数组（应用状态不可变性）。
 */
export function appendCappedMessage<T>(
  prev: readonly T[] | undefined,
  item: T,
): T[] {
  if (prev === undefined || prev.length === 0) {
    return [item]
  }
  if (prev.length >= TEAMMATE_MESSAGES_UI_CAP) {
    const next = prev.slice(-(TEAMMATE_MESSAGES_UI_CAP - 1))
    next.push(item)
    return next
  }
  return [...prev, item]
}