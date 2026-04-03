// 自动梦境（记忆巩固子代理）的后台任务入口
// 让原本不可见的派生代理在底部标签栏和
// Shift+下方向键对话框中可见。梦境代理本身保持不变 —— 这纯粹是通过
// 现有任务注册表实现的UI展示

import { rollbackConsolidationLock } from '../../services/autoDream/consolidationLock.js'
import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'

// 仅保留最新的N轮对话用于实时展示
const MAX_TURNS = 30

// 梦境代理的单次助手回复，工具调用会折叠为计数
export type DreamTurn = {
  text: string
  toolUseCount: number
}

// 不进行阶段检测 —— 梦境提示词包含4阶段结构
// (定位/收集/巩固/修剪)，但我们不解析它。当首次收到编辑/写入工具调用时
// 直接从'starting'切换为'updating'
export type DreamPhase = 'starting' | 'updating'

export type DreamTaskState = TaskStateBase & {
  type: 'dream'
  phase: DreamPhase
  sessionsReviewing: number
  /**
   * 通过消息监听在编辑/写入工具调用块中观察到的文件路径。这是对梦境代理
   * 实际修改内容的不完整反映 —— 会遗漏所有通过bash执行的写入操作，仅捕获
   * 我们模式匹配到的工具调用。应视为"至少这些文件被操作过"，而非"仅这些文件被操作过"
   */
  filesTouched: string[]
  /** 助手文本回复，工具调用已折叠。提示词不包含在内 */
  turns: DreamTurn[]
  abortController?: AbortController
  /** 存储该值以便终止操作时回滚锁的修改时间（与派生失败处理逻辑一致） */
  priorMtime: number
}

export function isDreamTask(task: unknown): task is DreamTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'dream'
  )
}

export function registerDreamTask(
  setAppState: SetAppState,
  opts: {
    sessionsReviewing: number
    priorMtime: number
    abortController: AbortController
  },
): string {
  const id = generateTaskId('dream')
  const task: DreamTaskState = {
    ...createTaskStateBase(id, 'dream', 'dreaming'),
    type: 'dream',
    status: 'running',
    phase: 'starting',
    sessionsReviewing: opts.sessionsReviewing,
    filesTouched: [],
    turns: [],
    abortController: opts.abortController,
    priorMtime: opts.priorMtime,
  }
  registerTask(task, setAppState)
  return id
}

export function addDreamTurn(
  taskId: string,
  turn: DreamTurn,
  touchedPaths: string[],
  setAppState: SetAppState,
): void {
  updateTaskState<DreamTaskState>(taskId, setAppState, task => {
    const seen = new Set(task.filesTouched)
    const newTouched = touchedPaths.filter(p => !seen.has(p) && seen.add(p))
    // 如果回复为空且没有新文件被操作，则完全跳过更新
    // 避免无操作时重新渲染
    if (
      turn.text === '' &&
      turn.toolUseCount === 0 &&
      newTouched.length === 0
    ) {
      return task
    }
    return {
      ...task,
      phase: newTouched.length > 0 ? 'updating' : task.phase,
      filesTouched:
        newTouched.length > 0
          ? [...task.filesTouched, ...newTouched]
          : task.filesTouched,
      turns: task.turns.slice(-(MAX_TURNS - 1)).concat(turn),
    }
  })
}

export function completeDreamTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  // 立即标记为已通知 —— 梦境任务无面向模型的通知通道
  // (仅用于UI展示)，且任务清理需要终止状态+已通知标记。内联的
  // 系统消息追加完成提示就是用户可见的通知
  updateTaskState<DreamTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'completed',
    endTime: Date.now(),
    notified: true,
    abortController: undefined,
  }))
}

export function failDreamTask(taskId: string, setAppState: SetAppState): void {
  updateTaskState<DreamTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'failed',
    endTime: Date.now(),
    notified: true,
    abortController: undefined,
  }))
}

export const DreamTask: Task = {
  name: 'DreamTask',
  type: 'dream',

  async kill(taskId, setAppState) {
    let priorMtime: number | undefined
    updateTaskState<DreamTaskState>(taskId, setAppState, task => {
      if (task.status !== 'running') return task
      task.abortController?.abort()
      priorMtime = task.priorMtime
      return {
        ...task,
        status: 'killed',
        endTime: Date.now(),
        notified: true,
        abortController: undefined,
      }
    })
    // 回滚锁的修改时间，以便下一个会话可以重试。与autoDream.ts中的
    // 派生失败捕获逻辑一致。如果任务状态更新未执行（已处于终止状态），
    // priorMtime保持未定义，跳过回滚操作
    if (priorMtime !== undefined) {
      await rollbackConsolidationLock(priorMtime)
    }
  },
}