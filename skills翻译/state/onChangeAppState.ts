import { setMainLoopModelOverride } from '../bootstrap/state.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
} from '../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { applyConfigEnvironmentVariables } from '../utils/managedEnv.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../utils/permissions/PermissionMode.js'
import {
  notifyPermissionModeChanged,
  notifySessionMetadataChanged,
  type SessionExternalMetadata,
} from '../utils/sessionState.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import type { AppState } from './AppStateStore.js'

// 与下方的推送操作互逆 —— 工作进程重启时执行还原操作
export function externalMetadataToAppState(
  metadata: SessionExternalMetadata,
): (prev: AppState) => AppState {
  return prev => ({
    ...prev,
    ...(typeof metadata.permission_mode === 'string'
      ? {
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            mode: permissionModeFromString(metadata.permission_mode),
          },
        }
      : {}),
    ...(typeof metadata.is_ultraplan_mode === 'boolean'
      ? { isUltraplanMode: metadata.is_ultraplan_mode }
      : {}),
  })
}

export function onChangeAppState({
  newState,
  oldState,
}: {
  newState: AppState
  oldState: AppState
}) {
  // toolPermissionContext.mode —— 控制CCR/SDK模式同步的唯一核心节点
  //
  // 在本代码块之前，仅有8种以上状态变更路径中的2种能将模式变更同步至CCR：
  // print.ts 中的自定义 setAppState 包装器（仅无头/SDK模式），
  // 以及 set_permission_mode 处理函数中的手动通知。
  // 其他所有变更路径 —— Shift+Tab 切换、退出计划模式权限请求弹窗、
  // /plan 斜杠命令、回退操作、REPL 桥的 onSetPermissionMode 方法 ——
  // 均仅修改了应用状态却未通知CCR，导致 external_metadata.permission_mode 数据过期，
  // 网页界面与CLI实际运行模式不一致。
  //
  // 在此处监听状态差异，意味着**任何**修改模式的 setAppState 调用
  // 都会通知CCR（通过 notifySessionMetadataChanged → ccrClient.reportMetadata）
  // 和SDK状态流（通过 notifyPermissionModeChanged → 在print.ts中注册）。
  // 上述分散的调用点无需做任何修改。
  const prevMode = oldState.toolPermissionContext.mode
  const newMode = newState.toolPermissionContext.mode
  if (prevMode !== newMode) {
    // CCR的external_metadata禁止接收仅内部使用的模式名称
    // （如bubble、ungated auto）。需先转换为外部模式 ——
    // 若**外部模式未发生变化**，则跳过CCR通知（例如：
    // default→bubble→default 对CCR而言无意义，因为两者对外均为'default'）。
    // SDK通道（notifyPermissionModeChanged）会传递原始模式，
    // 其在print.ts中的监听器会自行过滤。
    const prevExternal = toExternalPermissionMode(prevMode)
    const newExternal = toExternalPermissionMode(newMode)
    if (prevExternal !== newExternal) {
      // 超级计划模式 = 仅首次计划周期生效。初始控制请求会
      // 原子化设置模式和isUltraplanMode标志，因此通过标志的
      // 切换状态来控制。遵循RFC 7396规范设为null（移除该键）。
      const isUltraplan =
        newExternal === 'plan' &&
        newState.isUltraplanMode &&
        !oldState.isUltraplanMode
          ? true
          : null
      notifySessionMetadataChanged({
        permission_mode: newExternal,
        is_ultraplan_mode: isUltraplan,
      })
    }
    notifyPermissionModeChanged(newMode)
  }

  // 主循环模型：是否需要从配置中移除
  if (
    newState.mainLoopModel !== oldState.mainLoopModel &&
    newState.mainLoopModel === null
  ) {
    // 从配置中移除
    updateSettingsForSource('userSettings', { model: undefined })
    setMainLoopModelOverride(null)
  }

  // 主循环模型：是否需要添加到配置中
  if (
    newState.mainLoopModel !== oldState.mainLoopModel &&
    newState.mainLoopModel !== null
  ) {
    // 保存到配置中
    updateSettingsForSource('userSettings', { model: newState.mainLoopModel })
    setMainLoopModelOverride(newState.mainLoopModel)
  }

  // 展开视图 → 持久化为 showExpandedTodos 和 showSpinnerTree，保证向后兼容
  if (newState.expandedView !== oldState.expandedView) {
    const showExpandedTodos = newState.expandedView === 'tasks'
    const showSpinnerTree = newState.expandedView === 'teammates'
    if (
      getGlobalConfig().showExpandedTodos !== showExpandedTodos ||
      getGlobalConfig().showSpinnerTree !== showSpinnerTree
    ) {
      saveGlobalConfig(current => ({
        ...current,
        showExpandedTodos,
        showSpinnerTree,
      }))
    }
  }

  // 详细日志模式
  if (
    newState.verbose !== oldState.verbose &&
    getGlobalConfig().verbose !== newState.verbose
  ) {
    const verbose = newState.verbose
    saveGlobalConfig(current => ({
      ...current,
      verbose,
    }))
  }

  // 钨面板可见性（仅蚂蚁用户的tmux面板固定切换开关）
  if (process.env.USER_TYPE === 'ant') {
    if (
      newState.tungstenPanelVisible !== oldState.tungstenPanelVisible &&
      newState.tungstenPanelVisible !== undefined &&
      getGlobalConfig().tungstenPanelVisible !== newState.tungstenPanelVisible
    ) {
      const tungstenPanelVisible = newState.tungstenPanelVisible
      saveGlobalConfig(current => ({ ...current, tungstenPanelVisible }))
    }
  }

  // 配置项：配置变更时清空认证相关缓存
  // 确保API密钥助手和AWS/GCP凭证修改立即生效
  if (newState.settings !== oldState.settings) {
    try {
      clearApiKeyHelperCache()
      clearAwsCredentialsCache()
      clearGcpCredentialsCache()

      // 配置环境变量变更时重新应用
      // 仅做增量操作：新增变量会添加，现有变量可被覆盖，无变量删除
      if (newState.settings.env !== oldState.settings.env) {
        applyConfigEnvironmentVariables()
      }
    } catch (error) {
      logError(toError(error))
    }
  }
}