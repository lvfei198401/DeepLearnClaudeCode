/**
 * 主会话本地任务 - 处理主会话查询的后台运行逻辑
 *
 * 当用户在查询过程中连续按下两次 Ctrl+B 时，会话将被「后台挂起」：
 * - 查询任务在后台持续运行
 * - 界面清空并显示全新的命令提示符
 * - 查询完成后发送通知提醒用户
 *
 * 由于行为逻辑相似，本类复用了本地代理任务的状态结构
 */

import type { UUID } from 'crypto'
import { randomBytes } from 'crypto'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../constants/xml.js'
import { type QueryParams, query } from '../query.js'
import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { SetAppState } from '../Task.js'
import { createTaskStateBase } from '../Task.js'
import type {
  AgentDefinition,
  CustomAgentDefinition,
} from '../tools/AgentTool/loadAgentsDir.js'
import { asAgentId } from '../types/ids.js'
import type { Message } from '../types/message.js'
import { createAbortController } from '../utils/abortController.js'
import {
  runWithAgentContext,
  type SubagentContext,
} from '../utils/agentContext.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'
import { enqueuePendingNotification } from '../utils/messageQueueManager.js'
import { emitTaskTerminatedSdk } from '../utils/sdkEventQueue.js'
import {
  getAgentTranscriptPath,
  recordSidechainTranscript,
} from '../utils/sessionStorage.js'
import {
  evictTaskOutput,
  getTaskOutputPath,
  initTaskOutputAsSymlink,
} from '../utils/task/diskOutput.js'
import { registerTask, updateTaskState } from '../utils/task/framework.js'
import type { LocalAgentTaskState } from './LocalAgentTask/LocalAgentTask.js'

// 主会话任务使用本地代理任务状态，代理类型标记为「主会话」
export type LocalMainSessionTaskState = LocalAgentTaskState & {
  agentType: 'main-session'
}

/**
 * 未指定代理时，主会话任务的默认代理配置
 */
const DEFAULT_MAIN_SESSION_AGENT: CustomAgentDefinition = {
  agentType: 'main-session',
  whenToUse: 'Main session query',
  source: 'userSettings',
  getSystemPrompt: () => '',
}

/**
 * 为主会话任务生成唯一任务ID
 * 使用前缀 's' 与代理任务（前缀 'a'）区分
 */
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function generateMainSessionTaskId(): string {
  const bytes = randomBytes(8)
  let id = 's'
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length]
  }
  return id
}

/**
 * 注册后台运行的主会话任务
 * 用户将当前会话查询挂至后台时调用
 *
 * @param description - 任务描述
 * @param setAppState - 应用状态设置函数
 * @param mainThreadAgentDefinition - 可选代理配置（使用 --agent 参数运行时生效）
 * @param existingAbortController - 可选中止控制器（用于将活跃查询转为后台运行）
 * @returns 包含任务ID和中止信号的对象，用于停止后台查询
 */
export function registerMainSessionTask(
  description: string,
  setAppState: SetAppState,
  mainThreadAgentDefinition?: AgentDefinition,
  existingAbortController?: AbortController,
): { taskId: string; abortSignal: AbortSignal } {
  const taskId = generateMainSessionTaskId()

  // 将输出链接到任务独立的会话记录文件（与子代理布局一致）
  // 禁止使用 getTranscriptPath() —— 该路径为主会话文件
  // 执行 /clear 后，后台查询写入该文件会导致清空后的对话数据损坏
  // 独立路径可保证任务在 /clear 后仍正常运行：clearConversation 中的符号链接重连会处理会话ID变更
  void initTaskOutputAsSymlink(
    taskId,
    getAgentTranscriptPath(asAgentId(taskId)),
  )

  // 若提供了已有的中止控制器则直接使用（对将活跃查询转为后台运行至关重要）
  // 确保中止任务时能真正终止对应的查询操作
  const abortController = existingAbortController ?? createAbortController()

  const unregisterCleanup = registerCleanup(async () => {
    // 进程退出时执行清理
    setAppState(prev => {
      const { [taskId]: removed, ...rest } = prev.tasks
      return { ...prev, tasks: rest }
    })
  })

  // 使用传入的代理配置或默认配置
  const selectedAgent = mainThreadAgentDefinition ?? DEFAULT_MAIN_SESSION_AGENT

  // 创建任务状态 - 调用时已由用户转为后台运行，直接标记为后台状态
  const taskState: LocalMainSessionTaskState = {
    ...createTaskStateBase(taskId, 'local_agent', description),
    type: 'local_agent',
    status: 'running',
    agentId: taskId,
    prompt: description,
    selectedAgent,
    agentType: 'main-session',
    abortController,
    unregisterCleanup,
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true, // 已标记为后台运行
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
  }

  logForDebugging(
    `[LocalMainSessionTask] 注册任务 ${taskId}，描述：${description}`,
  )
  registerTask(taskState, setAppState)

  // 校验任务是否注册成功，检查状态中是否存在该任务
  setAppState(prev => {
    const hasTask = taskId in prev.tasks
    logForDebugging(
      `[LocalMainSessionTask] 注册完成后，任务 ${taskId} 是否存在于状态中：${hasTask}`,
    )
    return prev
  })

  return { taskId, abortSignal: abortController.signal }
}

/**
 * 完成主会话任务并发送通知
 * 后台查询执行结束时调用
 */
export function completeMainSessionTask(
  taskId: string,
  success: boolean,
  setAppState: SetAppState,
): void {
  let wasBackgrounded = true
  let toolUseId: string | undefined

  updateTaskState<LocalMainSessionTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task
    }

    // 记录任务是否为后台状态（用于判断是否发送通知）
    wasBackgrounded = task.isBackgrounded ?? true
    toolUseId = task.toolUseId

    task.unregisterCleanup?.()

    return {
      ...task,
      status: success ? 'completed' : 'failed',
      endTime: Date.now(),
      messages: task.messages?.length ? [task.messages.at(-1)!] : undefined,
    }
  })

  void evictTaskOutput(taskId)

  // 仅当任务仍在后台运行时发送通知（未切换至前台）
  // 若任务已切换至前台，用户可直接查看结果，无需发送通知
  if (wasBackgrounded) {
    enqueueMainSessionNotification(
      taskId,
      'Background session',
      success ? 'completed' : 'failed',
      setAppState,
      toolUseId,
    )
  } else {
    // 前台任务：不发送XML通知（终端用户可直接查看），但SDK需要接收任务结束的配对事件
    // 设置已通知标记，使 evictTerminalTask/generateTaskAttachments 的清理校验通过
    // 后台任务的该标记会在 enqueueMainSessionNotification 的原子检查中设置
    updateTaskState(taskId, setAppState, task => ({ ...task, notified: true }))
    emitTaskTerminatedSdk(taskId, success ? 'completed' : 'failed', {
      toolUseId,
      summary: 'Background session',
    })
  }
}

/**
 * 加入后台会话完成的通知队列
 */
function enqueueMainSessionNotification(
  taskId: string,
  description: string,
  status: 'completed' | 'failed',
  setAppState: SetAppState,
  toolUseId?: string,
): void {
  // 原子检查并设置已通知标记，避免重复发送通知
  let shouldEnqueue = false
  updateTaskState(taskId, setAppState, task => {
    if (task.notified) {
      return task
    }
    shouldEnqueue = true
    return { ...task, notified: true }
  })

  if (!shouldEnqueue) {
    return
  }

  const summary =
    status === 'completed'
      ? `后台会话 "${description}" 执行完成`
      : `后台会话 "${description}" 执行失败`

  const toolUseIdLine = toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''

  const outputPath = getTaskOutputPath(taskId)
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${summary}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`

  enqueuePendingNotification({ value: message, mode: 'task-notification' })
}

/**
 * 将主会话任务切换至前台 - 标记为前台状态，使其输出显示在主界面
 * 后台查询会持续运行
 * 若任务不存在则返回 undefined，否则返回任务累积的消息
 */
export function foregroundMainSessionTask(
  taskId: string,
  setAppState: SetAppState,
): Message[] | undefined {
  let taskMessages: Message[] | undefined

  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!task || task.type !== 'local_agent') {
      return prev
    }

    taskMessages = (task as LocalMainSessionTaskState).messages

    // 若存在之前的前台任务，将其恢复为后台状态
    const prevId = prev.foregroundedTaskId
    const prevTask = prevId ? prev.tasks[prevId] : undefined
    const restorePrev =
      prevId && prevId !== taskId && prevTask?.type === 'local_agent'

    return {
      ...prev,
      foregroundedTaskId: taskId,
      tasks: {
        ...prev.tasks,
        ...(restorePrev && { [prevId]: { ...prevTask, isBackgrounded: true } }),
        [taskId]: { ...task, isBackgrounded: false },
      },
    }
  })

  return taskMessages
}

/**
 * 判断任务是否为主会话任务（区别于普通代理任务）
 */
export function isMainSessionTask(
  task: unknown,
): task is LocalMainSessionTaskState {
  if (
    typeof task !== 'object' ||
    task === null ||
    !('type' in task) ||
    !('agentType' in task)
  ) {
    return false
  }
  return (
    task.type === 'local_agent' &&
    (task as LocalMainSessionTaskState).agentType === 'main-session'
  )
}

// 界面展示的最大最近活动数量
const MAX_RECENT_ACTIVITIES = 5

type ToolActivity = {
  toolName: string
  input: Record<string, unknown>
}

/**
 * 根据传入的消息启动全新的后台会话
 *
 * 基于当前消息发起独立的 query() 调用，并注册为后台任务
 * 调用方的前台查询会继续正常运行
 */
export function startBackgroundSession({
  messages,
  queryParams,
  description,
  setAppState,
  agentDefinition,
}: {
  messages: Message[]
  queryParams: Omit<QueryParams, 'messages'>
  description: string
  setAppState: SetAppState
  agentDefinition?: AgentDefinition
}): string {
  const { taskId, abortSignal } = registerMainSessionTask(
    description,
    setAppState,
    agentDefinition,
  )

  // 将后台运行前的对话内容持久化到任务独立的会话记录中
  // 使任务输出能立即显示上下文，后续消息会逐步写入
  void recordSidechainTranscript(messages, taskId).catch(err =>
    logForDebugging(`后台会话初始会话记录写入失败：${err}`),
  )

  // 包裹代理上下文，使技能调用作用域绑定到当前任务的代理ID（非空）
  // 允许 clearInvokedSkills(preservedAgentIds) 在执行 /clear 时选择性保留该任务的技能
  // AsyncLocalStorage 会隔离并发异步调用链，该包裹不会影响前台任务
  const agentContext: SubagentContext = {
    agentId: taskId,
    agentType: 'subagent',
    subagentName: 'main-session',
    isBuiltIn: true,
  }

  void runWithAgentContext(agentContext, async () => {
    try {
      const bgMessages: Message[] = [...messages]
      const recentActivities: ToolActivity[] = []
      let toolCount = 0
      let tokenCount = 0
      let lastRecordedUuid: UUID | null = messages.at(-1)?.uuid ?? null

      for await (const event of query({
        messages: bgMessages,
        ...queryParams,
      })) {
        if (abortSignal.aborted) {
          // 流处理中被中止 —— 不会执行到 completeMainSessionTask
          // chat:killAgents 已标记通知并发送事件；stopTask 未执行该操作
          let alreadyNotified = false
          updateTaskState(taskId, setAppState, task => {
            alreadyNotified = task.notified === true
            return alreadyNotified ? task : { ...task, notified: true }
          })
          if (!alreadyNotified) {
            emitTaskTerminatedSdk(taskId, 'stopped', {
              summary: description,
            })
          }
          return
        }

        if (
          event.type !== 'user' &&
          event.type !== 'assistant' &&
          event.type !== 'system'
        ) {
          continue
        }

        bgMessages.push(event)

        // 单条消息写入（与 runAgent.ts 逻辑一致）
        // 实时更新任务输出进度，即使运行中执行 /clear 重连符号链接，会话记录也能保持最新
        void recordSidechainTranscript([event], taskId, lastRecordedUuid).catch(
          err => logForDebugging(`后台会话记录写入失败：${err}`),
        )
        lastRecordedUuid = event.uuid

        if (event.type === 'assistant') {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              tokenCount += roughTokenCountEstimation(block.text)
            } else if (block.type === 'tool_use') {
              toolCount++
              const activity: ToolActivity = {
                toolName: block.name,
                input: block.input as Record<string, unknown>,
              }
              recentActivities.push(activity)
              if (recentActivities.length > MAX_RECENT_ACTIVITIES) {
                recentActivities.shift()
              }
            }
          }
        }

        setAppState(prev => {
          const task = prev.tasks[taskId]
          if (!task || task.type !== 'local_agent') return prev
          const prevProgress = task.progress
          if (
            prevProgress?.tokenCount === tokenCount &&
            prevProgress.toolUseCount === toolCount &&
            task.messages === bgMessages
          ) {
            return prev
          }
          return {
            ...prev,
            tasks: {
              ...prev.tasks,
              [taskId]: {
                ...task,
                progress: {
                  tokenCount,
                  toolUseCount: toolCount,
                  recentActivities:
                    prevProgress?.toolUseCount === toolCount
                      ? prevProgress.recentActivities
                      : [...recentActivities],
                },
                messages: bgMessages,
              },
            },
          }
        })
      }

      completeMainSessionTask(taskId, true, setAppState)
    } catch (error) {
      logError(error)
      completeMainSessionTask(taskId, false, setAppState)
    }
  })

  return taskId
}