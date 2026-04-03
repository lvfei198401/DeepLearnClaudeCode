import type { Notification } from 'src/context/notifications.js'
import type { TodoList } from 'src/utils/todo/types.js'
import type { BridgePermissionCallbacks } from '../bridge/bridgePermissionCallbacks.js'
import type { Command } from '../commands.js'
import type { ChannelPermissionCallbacks } from '../services/mcp/channelPermissions.js'
import type { ElicitationRequestEvent } from '../services/mcp/elicitationHandler.js'
import type {
  MCPServerConnection,
  ServerResource,
} from '../services/mcp/types.js'
import { shouldEnablePromptSuggestion } from '../services/PromptSuggestion/promptSuggestion.js'
import {
  getEmptyToolPermissionContext,
  type Tool,
  type ToolPermissionContext,
} from '../Tool.js'
import type { TaskState } from '../tasks/types.js'
import type { AgentColorName } from '../tools/AgentTool/agentColorManager.js'
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import type { AllowedPrompt } from '../tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import type { AgentId } from '../types/ids.js'
import type { Message, UserMessage } from '../types/message.js'
import type { LoadedPlugin, PluginError } from '../types/plugin.js'
import type { DeepImmutable } from '../types/utils.js'
import {
  type AttributionState,
  createEmptyAttributionState,
} from '../utils/commitAttribution.js'
import type { EffortValue } from '../utils/effort.js'
import type { FileHistoryState } from '../utils/fileHistory.js'
import type { REPLHookContext } from '../utils/hooks/postSamplingHooks.js'
import type { SessionHooksState } from '../utils/hooks/sessionHooks.js'
import type { ModelSetting } from '../utils/model/model.js'
import type { DenialTrackingState } from '../utils/permissions/denialTracking.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import type { SettingsJson } from '../utils/settings/types.js'
import { shouldEnableThinkingByDefault } from '../utils/thinking.js'
import type { Store } from './store.js'

/** 完成边界类型 */
export type CompletionBoundary =
  | { type: 'complete'; completedAt: number; outputTokens: number }
  | { type: 'bash'; command: string; completedAt: number }
  | { type: 'edit'; toolName: string; filePath: string; completedAt: number }
  | {
      type: 'denied_tool'
      toolName: string
      detail: string
      completedAt: number
    }

/** 推测结果类型 */
export type SpeculationResult = {
  messages: Message[]
  boundary: CompletionBoundary | null
  timeSavedMs: number
}

/** 推测状态类型 */
export type SpeculationState =
  | { status: 'idle' }
  | {
      status: 'active'
      id: string
      abort: () => void
      startTime: number
      messagesRef: { current: Message[] } // 可变引用 - 避免每条消息都展开数组
      writtenPathsRef: { current: Set<string> } // 可变引用 - 写入覆盖层的相对路径
      boundary: CompletionBoundary | null
      suggestionLength: number
      toolUseCount: number
      isPipelined: boolean
      contextRef: { current: REPLHookContext }
      pipelinedSuggestion?: {
        text: string
        promptId: 'user_intent' | 'stated_intent'
        generationRequestId: string | null
      } | null
    }

/** 空闲推测状态常量 */
export const IDLE_SPECULATION_STATE: SpeculationState = { status: 'idle' }

/** 底部栏项类型 */
export type FooterItem =
  | 'tasks'
  | 'tmux'
  | 'bagel'
  | 'teams'
  | 'bridge'
  | 'companion'

/** 应用状态类型 */
export type AppState = DeepImmutable<{
  settings: SettingsJson
  verbose: boolean
  mainLoopModel: ModelSetting
  mainLoopModelForSession: ModelSetting
  statusLineText: string | undefined
  expandedView: 'none' | 'tasks' | 'teammates'
  isBriefOnly: boolean
  // 可选 - 仅当 ENABLE_AGENT_SWARMS 为 true 时存在（用于死代码消除）
  showTeammateMessagePreview?: boolean
  selectedIPAgentIndex: number
  // 协调器任务面板选择：-1 =  pill 项，0 = 主面板，1..N = 代理行
  // 属于应用状态（非局部状态），因此面板可直接读取，无需通过属性逐层传递
  // 从 PromptInput → PromptInputFooter
  coordinatorTaskIndex: number
  viewSelectionMode: 'none' | 'selecting-agent' | 'viewing-agent'
  // 底部栏哪个 pill 项获得焦点（输入框下方的方向键导航）
  // 存于应用状态，因此在 PromptInput 外部渲染的 pill 组件
  //（REPL.tsx 中的 CompanionSprite）可以读取自身的聚焦状态
  footerSelection: FooterItem | null
  toolPermissionContext: ToolPermissionContext
  spinnerTip?: string
  // 来自 --agent 命令行参数或设置的代理名称（用于显示logo）
  agent: string | undefined
  // 助手模式已完全启用（设置 + 功能开关 + 信任权限）
  // 唯一可信源 - 在选项变更前于 main.tsx 中计算一次
  // 消费者读取此值，而非重新调用 isAssistantMode()
  kairosEnabled: boolean
  // --remote 模式的远程会话URL（显示在底部栏指示器）
  remoteSessionUrl: string | undefined
  // `claude assistant`：远程连接WebSocket状态
  // 'connected' 表示实时事件流已打开；'reconnecting' = 临时WebSocket断开，正在重试
  // 'disconnected' = 永久关闭或重试耗尽
  remoteConnectionStatus:
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'disconnected'
  // `claude assistant`：远程守护进程子进程中运行的后台任务数（代理调用、团队成员、工作流）
  // 通过WebSocket的 system/task_started 和 system/task_notification 事件同步
  // 查看器模式下本地应用状态的tasks始终为空 - 任务存在于另一个进程中
  remoteBackgroundTaskCount: number
  // 常驻桥接：期望状态（由 /config 或底部栏开关控制）
  replBridgeEnabled: boolean
  // 常驻桥接：通过 /remote-control 命令激活时为true，配置驱动时为false
  replBridgeExplicit: boolean
  // 仅出站模式：转发事件到CCR但拒绝入站提示/控制
  replBridgeOutboundOnly: boolean
  // 常驻桥接：环境已注册 + 会话已创建（= "就绪"）
  replBridgeConnected: boolean
  // 常驻桥接：入站WebSocket已打开（= "已连接" - 用户在 claude.ai）
  replBridgeSessionActive: boolean
  // 常驻桥接：轮询循环处于错误重试中（= "重新连接"）
  replBridgeReconnecting: boolean
  // 常驻桥接：就绪状态的连接URL（?bridge=环境ID）
  replBridgeConnectUrl: string | undefined
  // 常驻桥接：claude.ai上的会话URL（连接时设置）
  replBridgeSessionUrl: string | undefined
  // 常驻桥接：调试用ID（--verbose 时在对话框中显示）
  replBridgeEnvironmentId: string | undefined
  replBridgeSessionId: string | undefined
  // 常驻桥接：连接失败时的错误信息（显示在桥接对话框）
  replBridgeError: string | undefined
  // 常驻桥接：通过 `/remote-control <名称>` 设置的会话名称（用作会话标题）
  replBridgeInitialName: string | undefined
  // 常驻桥接：首次远程对话框待显示（由 /remote-control 命令设置）
  showRemoteCallout: boolean
}> & {
  // 统一任务状态 - 排除在深度不可变之外，因为任务状态包含函数类型
  tasks: { [taskId: string]: TaskState }
  // 名称→代理ID注册表，由代理工具在提供`name`时填充
  // 冲突时以最新为准，供SendMessage按名称路由使用
  agentNameRegistry: Map<string, AgentId>
  // 已前台显示的任务ID - 其消息显示在主视图
  foregroundedTaskId?: string
  // 正在查看对话的进行中团队成员任务ID（未定义 = 领导者视图）
  viewingAgentTaskId?: string
  // 来自好友观察者的最新助手反应
  companionReaction?: string
  // 上次 /buddy 互动的时间戳 - 近期内CompanionSprite会显示爱心效果
  companionPetAt?: number
  // TODO：确认是否可以使用 utility-types 的 DeepReadonly 替代
  mcp: {
    clients: MCPServerConnection[]
    tools: Tool[]
    commands: Command[]
    resources: Record<string, ServerResource[]>
    /**
     * 由 /reload-plugins 递增，触发MCP副作用重新执行
     * 并加载新启用的插件MCP服务器。副作用将此值作为依赖读取；
     * 本身不消费该值
     */
    pluginReconnectKey: number
  }
  plugins: {
    enabled: LoadedPlugin[]
    disabled: LoadedPlugin[]
    commands: Command[]
    /**
     * 加载和初始化期间收集的插件系统错误
     * 完整的错误结构、上下文字段和显示格式详情
     * 参见 {@link PluginError} 类型文档
     */
    errors: PluginError[]
    // 后台插件/市场安装的状态
    installationStatus: {
      marketplaces: Array<{
        name: string
        status: 'pending' | 'installing' | 'installed' | 'failed'
        error?: string
      }>
      plugins: Array<{
        id: string
        name: string
        status: 'pending' | 'installing' | 'installed' | 'failed'
        error?: string
      }>
    }
    /**
     * 当磁盘上的插件状态变更（后台同步、/plugin菜单安装、
     * 外部设置编辑）且活动组件已过时，设为true
     * 交互模式下，用户执行 /reload-plugins 应用变更
     * 无头模式下，refreshPluginState() 通过 refreshActivePlugins() 自动应用
     */
    needsRefresh: boolean
  }
  agentDefinitions: AgentDefinitionsResult
  fileHistory: FileHistoryState
  attribution: AttributionState
  todos: { [agentId: string]: TodoList }
  remoteAgentTaskSuggestions: { summary: string; task: string }[]
  notifications: {
    current: Notification | null
    queue: Notification[]
  }
  elicitation: {
    queue: ElicitationRequestEvent[]
  }
  thinkingEnabled: boolean | undefined
  promptSuggestionEnabled: boolean
  sessionHooks: SessionHooksState
  tungstenActiveSession?: {
    sessionName: string
    socketName: string
    target: string // tmux目标（例如 "session:window.pane"）
  }
  tungstenLastCapturedTime?: number // 为模型捕获画面的时间戳
  tungstenLastCommand?: {
    command: string // 要显示的命令字符串（例如 "Enter", "echo hello"）
    timestamp: number // 命令发送时间
  }
  // 固定tmux面板可见性 - 响应式映射 globalConfig.tungstenPanelVisible
  tungstenPanelVisible?: boolean
  // 回合结束时临时自动隐藏 - 与 tungstenPanelVisible 分离
  // 确保pill项保留在底部栏（用户可重新打开），但空闲下面板不占用屏幕空间
  // 下次使用Tmux工具或用户切换时清除，不持久化
  tungstenPanelAutoHidden?: boolean
  // 网页浏览器工具（代号bagel）：底部栏显示pill项
  bagelActive?: boolean
  // 网页浏览器工具：pill标签显示的当前页面URL
  bagelUrl?: string
  // 网页浏览器工具：固定面板可见性开关
  bagelPanelVisible?: boolean
  // chicago MCP会话状态。类型内联（不从外部包导入）
  // 确保外部类型检查无需解析特定依赖即可通过
  // 结构与 `AppGrant`/`CuGrantFlags` 匹配
  // 仅当 feature('CHICAGO_MCP') 激活时填充
  computerUseMcpState?: {
    // 会话级应用白名单，跨恢复不持久化
    allowedApps?: readonly {
      bundleId: string
      displayName: string
      grantedAt: number
    }[]
    // 剪贴板/系统快捷键授权标记（与白名单独立）
    grantFlags?: {
      clipboardRead: boolean
      clipboardWrite: boolean
      systemKeyCombos: boolean
    }
    // 仅尺寸信息（非图片数据），完整截图结果在局部进程中处理
    lastScreenshotDims?: {
      width: number
      height: number
      displayWidth: number
      displayHeight: number
      displayId?: number
      originX?: number
      originY?: number
    }
    // 由应用隐藏事件累积，回合结束时清除并恢复显示
    hiddenDuringTurn?: ReadonlySet<string>
    // 计算机使用功能的目标显示器
    // 由包的自动目标显示器解析器更新，跨恢复持久化
    // 确保模型操作始终在最后看到的显示器上
    selectedDisplayId?: number
    // 当模型通过 `switch_display` 显式选择显示器时为true
    // 使截图处理直接使用 selectedDisplayId，跳过解析链
    // 解析器回写（指定显示器断开→自动切换主显示器）或执行 `switch_display("auto")` 时清除
    displayPinnedByModel?: boolean
    // 显示器最后自动解析的应用ID集合（逗号分隔排序）
    // 仅当允许的应用集合变更时重新解析，避免每次截图都触发解析
    displayResolvedForApps?: string
  }
  // REPL工具虚拟机上下文 - 在REPL调用间持久化用于状态共享
  replContext?: {
    vmContext: import('vm').Context
    registeredTools: Map<
      string,
      {
        name: string
        description: string
        schema: Record<string, unknown>
        handler: (args: Record<string, unknown>) => Promise<unknown>
      }
    >
    console: {
      log: (...args: unknown[]) => void
      error: (...args: unknown[]) => void
      warn: (...args: unknown[]) => void
      info: (...args: unknown[]) => void
      debug: (...args: unknown[]) => void
      getStdout: () => string
      getStderr: () => string
      clear: () => void
    }
  }
  teamContext?: {
    teamName: string
    teamFilePath: string
    leadAgentId: string
    // 集群成员的自身标识（tmux面板中的独立进程）
    // 注意：与 toolUseContext.agentId 不同，后者用于进程内子代理
    selfAgentId?: string // 集群成员自身ID（领导者与leadAgentId相同）
    selfAgentName?: string // 集群成员名称（领导者为'team-lead'）
    isLeader?: boolean // 当前集群成员是否为团队领导者
    selfAgentColor?: string // UI分配的颜色（动态加入的会话使用）
    teammates: {
      [teammateId: string]: {
        name: string
        agentType?: string
        color?: string
        tmuxSessionName: string
        tmuxPaneId: string
        cwd: string
        worktreePath?: string
        spawnedAt: number
      }
    }
  }
  // 非集群会话的独立代理上下文（自定义名称/颜色）
  standaloneAgentContext?: {
    name: string
    color?: AgentColorName
  }
  inbox: {
    messages: Array<{
      id: string
      from: string
      text: string
      timestamp: string
      status: 'pending' | 'processing' | 'processed'
      color?: string
      summary?: string
    }>
  }
  // 工作沙箱权限请求（领导者端）- 用于网络访问审批
  workerSandboxPermissions: {
    queue: Array<{
      requestId: string
      workerId: string
      workerName: string
      workerColor?: string
      host: string
      createdAt: number
    }>
    selectedIndex: number
  }
  // 工作端待处理权限请求（等待领导者审批时显示）
  pendingWorkerRequest: {
    toolName: string
    toolUseId: string
    description: string
  } | null
  // 工作端待处理沙箱权限请求
  pendingSandboxRequest: {
    requestId: string
    host: string
  } | null
  promptSuggestion: {
    text: string | null
    promptId: 'user_intent' | 'stated_intent' | null
    shownAt: number
    acceptedAt: number
    generationRequestId: string | null
  }
  speculation: SpeculationState
  speculationSessionTimeSavedMs: number
  skillImprovement: {
    suggestion: {
      skillName: string
      updates: { section: string; change: string; reason: string }[]
    } | null
  }
  // 认证版本 - 登录/登出时递增，触发重新获取认证相关数据
  authVersion: number
  // 待处理的初始消息（来自命令行参数或计划模式退出）
  // 设置后，REPL将处理消息并触发查询
  initialMessage: {
    message: UserMessage
    clearContext?: boolean
    mode?: PermissionMode
    // 计划模式的会话级权限规则（例如 "运行测试"、"安装依赖"）
    allowedPrompts?: AllowedPrompt[]
  } | null
  // 待处理计划验证状态（退出计划模式时设置）
  // 供验证计划执行工具触发后台验证
  pendingPlanVerification?: {
    plan: string
    verificationStarted: boolean
    verificationCompleted: boolean
  }
  // 分类器模式的拒绝追踪（极速模式、无头模式等）- 超出限制时回退到提示
  denialTracking?: DenialTrackingState
  // 活动覆盖层（选择对话框等）- 用于Esc键协调
  activeOverlays: ReadonlySet<string>
  // 快速模式
  fastMode?: boolean
  // 服务端顾问工具的顾问模型（未定义 = 禁用）
  advisorModel?: string
  // 努力程度值
  effortValue?: EffortValue
  // 在分离流程开始前于启动超计划时同步设置
  // 防止在 teleportToRemote 设置 ultraplanSessionUrl 前的约5秒窗口内重复启动
  // URL设置或失败后由 launchDetached 清除
  ultraplanLaunching?: boolean
  // 活动超计划CCR会话URL。远程代理任务运行时设置；
  // 真值时禁用关键词触发和彩虹效果。轮询到达终止状态时清除
  ultraplanSessionUrl?: string
  // 已批准的超计划，等待用户选择（在此实现 vs 新建会话）
  // 由远程代理任务轮询在批准时设置，超计划选择对话框清除
  ultraplanPendingChoice?: { plan: string; sessionId: string; taskId: string }
  // 启动前权限对话框。由 /ultraplan（命令或关键词）设置；
  // 超计划启动对话框选择后清除
  ultraplanLaunchPending?: { blurb: string }
  // 远程管理端：通过 set_permission_mode 控制请求设置，
  // 由 onChangeAppState 推送到CCR外部元数据的 is_ultraplan_mode
  isUltraplanMode?: boolean
  // 常驻桥接：双向权限检查的权限回调
  replBridgePermissionCallbacks?: BridgePermissionCallbacks
  // 频道权限回调 - 通过Telegram/iMessage等的权限提示
  // 在交互处理器中通过claim()与本地UI、桥接、钩子、分类器竞争处理
  // 在 useManageMCPConnections 中一次性创建
  channelPermissionCallbacks?: ChannelPermissionCallbacks
}

/** 应用状态存储类型 */
export type AppStateStore = Store<AppState>

/**
 * 获取默认应用状态
 * @returns 默认应用状态对象
 */
export function getDefaultAppState(): AppState {
  // 为需要计划模式的团队成员确定初始权限模式
  // 使用延迟require避免与teammate.ts的循环依赖
  /* eslint-disable @typescript-eslint/no-require-imports */
  const teammateUtils =
    require('../utils/teammate.js') as typeof import('../utils/teammate.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const initialMode: PermissionMode =
    teammateUtils.isTeammate() && teammateUtils.isPlanModeRequired()
      ? 'plan'
      : 'default'

  return {
    settings: getInitialSettings(),
    tasks: {},
    agentNameRegistry: new Map(),
    verbose: false,
    mainLoopModel: null, // 别名、完整名称（与--model或环境变量一致）或null（默认）
    mainLoopModelForSession: null,
    statusLineText: undefined,
    expandedView: 'none',
    isBriefOnly: false,
    showTeammateMessagePreview: false,
    selectedIPAgentIndex: -1,
    coordinatorTaskIndex: -1,
    viewSelectionMode: 'none',
    footerSelection: null,
    kairosEnabled: false,
    remoteSessionUrl: undefined,
    remoteConnectionStatus: 'connecting',
    remoteBackgroundTaskCount: 0,
    replBridgeEnabled: false,
    replBridgeExplicit: false,
    replBridgeOutboundOnly: false,
    replBridgeConnected: false,
    replBridgeSessionActive: false,
    replBridgeReconnecting: false,
    replBridgeConnectUrl: undefined,
    replBridgeSessionUrl: undefined,
    replBridgeEnvironmentId: undefined,
    replBridgeSessionId: undefined,
    replBridgeError: undefined,
    replBridgeInitialName: undefined,
    showRemoteCallout: false,
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: initialMode,
    },
    agent: undefined,
    agentDefinitions: { activeAgents: [], allAgents: [] },
    fileHistory: {
      snapshots: [],
      trackedFiles: new Set(),
      snapshotSequence: 0,
    },
    attribution: createEmptyAttributionState(),
    mcp: {
      clients: [],
      tools: [],
      commands: [],
      resources: {},
      pluginReconnectKey: 0,
    },
    plugins: {
      enabled: [],
      disabled: [],
      commands: [],
      errors: [],
      installationStatus: {
        marketplaces: [],
        plugins: [],
      },
      needsRefresh: false,
    },
    todos: {},
    remoteAgentTaskSuggestions: [],
    notifications: {
      current: null,
      queue: [],
    },
    elicitation: {
      queue: [],
    },
    thinkingEnabled: shouldEnableThinkingByDefault(),
    promptSuggestionEnabled: shouldEnablePromptSuggestion(),
    sessionHooks: new Map(),
    inbox: {
      messages: [],
    },
    workerSandboxPermissions: {
      queue: [],
      selectedIndex: 0,
    },
    pendingWorkerRequest: null,
    pendingSandboxRequest: null,
    promptSuggestion: {
      text: null,
      promptId: null,
      shownAt: 0,
      acceptedAt: 0,
      generationRequestId: null,
    },
    speculation: IDLE_SPECULATION_STATE,
    speculationSessionTimeSavedMs: 0,
    skillImprovement: {
      suggestion: null,
    },
    authVersion: 0,
    initialMessage: null,
    effortValue: undefined,
    activeOverlays: new Set<string>(),
    fastMode: false,
  }
}