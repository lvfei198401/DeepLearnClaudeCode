/**
 * 进程内队友任务 - 管理进程内队友的生命周期
 *
 * 该组件为进程内队友实现任务接口。
 * 与本地代理任务（后台代理）不同，进程内队友具备以下特性：
 * 1. 运行在同一个 Node.js 进程中，使用异步本地存储实现隔离
 * 2. 具备团队感知身份标识（代理名@团队名）
 * 3. 支持计划模式审批流程
 * 4. 可处于空闲状态（等待任务）或活跃状态（处理任务）
 */

import { isTerminalTaskStatus, type SetAppState, type Task, type TaskStateBase } from '../../Task.js';
import type { Message } from '../../types/message.js';
import { logForDebugging } from '../../utils/debug.js';
import { createUserMessage } from '../../utils/messages.js';
import { killInProcessTeammate } from '../../utils/swarm/spawnInProcess.js';
import { updateTaskState } from '../../utils/task/framework.js';
import type { InProcessTeammateTaskState } from './types.js';
import { appendCappedMessage, isInProcessTeammateTask } from './types.js';

/**
 * 进程内队友任务 - 处理进程内队友的执行逻辑
 */
export const InProcessTeammateTask: Task = {
  name: 'InProcessTeammateTask',
  type: 'in_process_teammate',
  async kill(taskId, setAppState) {
    killInProcessTeammate(taskId, setAppState);
  }
};

/**
 * 请求关闭队友
 */
export function requestTeammateShutdown(taskId: string, setAppState: SetAppState): void {
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running' || task.shutdownRequested) {
      return task;
    }
    return {
      ...task,
      shutdownRequested: true
    };
  });
}

/**
 * 向队友的对话历史中追加消息
 * 用于放大视图展示队友的对话内容
 */
export function appendTeammateMessage(taskId: string, message: Message, setAppState: SetAppState): void {
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task;
    }
    return {
      ...task,
      messages: appendCappedMessage(task.messages, message)
    };
  });
}

/**
 * 向队友的待处理队列注入用户消息
 * 用于查看队友对话记录时，向其发送输入的消息
 * 同时将消息添加到任务消息列表中，使其立即显示在对话记录里
 */
export function injectUserMessageToTeammate(taskId: string, message: string, setAppState: SetAppState): void {
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, task => {
    // 允许在队友运行或空闲（等待输入）时注入消息
    // 仅在队友处于终止状态时拒绝注入
    if (isTerminalTaskStatus(task.status)) {
      logForDebugging(`丢弃队友任务 ${taskId} 的消息：任务状态为"${task.status}"`);
      return task;
    }
    return {
      ...task,
      pendingUserMessages: [...task.pendingUserMessages, message],
      messages: appendCappedMessage(task.messages, createUserMessage({
        content: message
      }))
    };
  });
}

/**
 * 根据代理ID从应用状态中获取队友任务
 * 若存在多个相同代理ID的任务，优先返回运行中的任务，而非已终止/已完成的任务
 * 未找到时返回 undefined
 */
export function findTeammateTaskByAgentId(agentId: string, tasks: Record<string, TaskStateBase>): InProcessTeammateTaskState | undefined {
  let fallback: InProcessTeammateTaskState | undefined;
  for (const task of Object.values(tasks)) {
    if (isInProcessTeammateTask(task) && task.identity.agentId === agentId) {
      // 若应用状态中同时存在旧的已终止任务和新的同ID运行任务，优先返回运行任务
      if (task.status === 'running') {
        return task;
      }
      // 若无运行任务，保留第一个匹配项作为备用
      if (!fallback) {
        fallback = task;
      }
    }
  }
  return fallback;
}

/**
 * 从应用状态中获取所有进程内队友任务
 */
export function getAllInProcessTeammateTasks(tasks: Record<string, TaskStateBase>): InProcessTeammateTaskState[] {
  return Object.values(tasks).filter(isInProcessTeammateTask);
}

/**
 * 按代理名字母顺序排序，获取所有运行中的进程内队友
 * 该方法供队友选择树组件、输入框底部选择器、后台任务导航钩子共用
 * 选中的进程内代理索引对应此数组，因此三者必须保持排序一致
 */
export function getRunningTeammatesSorted(tasks: Record<string, TaskStateBase>): InProcessTeammateTaskState[] {
  return getAllInProcessTeammateTasks(tasks).filter(t => t.status === 'running').sort((a, b) => a.identity.agentName.localeCompare(b.identity.agentName));
}