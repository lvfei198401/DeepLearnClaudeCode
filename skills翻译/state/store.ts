// 监听器类型：无参数、无返回值的函数
type Listener = () => void
// 状态变更回调类型：接收包含新状态、旧状态参数的函数
type OnChange<T> = (args: { newState: T; oldState: T }) => void

// 状态仓库类型定义
export type Store<T> = {
  // 获取当前状态
  getState: () => T
  // 更新状态：接收基于旧状态计算新状态的函数
  setState: (updater: (prev: T) => T) => void
  // 订阅状态变化：添加监听器，返回取消订阅的函数
  subscribe: (listener: Listener) => () => void
}

/**
 * 创建状态仓库
 * @param initialState 初始状态
 * @param onChange 状态变更时的可选回调函数
 * @returns 状态仓库实例
 */
export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  // 存储当前状态
  let state = initialState
  // 存储所有状态变化监听器
  const listeners = new Set<Listener>()

  return {
    // 获取当前状态
    getState: () => state,

    // 更新状态
    setState: (updater: (prev: T) => T) => {
      const prev = state
      const next = updater(prev)
      // 新状态与旧状态一致时，不执行更新
      if (Object.is(next, prev)) return
      // 更新为新状态
      state = next
      // 触发状态变更回调
      onChange?.({ newState: next, oldState: prev })
      // 执行所有订阅的监听器
      for (const listener of listeners) listener()
    },

    // 订阅状态变化
    subscribe: (listener: Listener) => {
      listeners.add(listener)
      // 返回取消订阅的方法
      return () => listeners.delete(listener)
    },
  }
}