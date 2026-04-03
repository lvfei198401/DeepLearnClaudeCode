# Swarm Backends 子模块设计文档

## 1. 文档信息

| 字段 | 值 |
|------|-----|
| 模块名称 | Swarm Backends（后端注册与选择） |
| 文档版本 | v1.0-20260402 |
| 生成日期 | 2026-04-02 |
| 生成方式 | 代码反向工程 |
| 源文件行数 | 2737 行（合计） |
| 版本来源 | @anthropic-ai/claude-code v2.1.88 |

## 2. 模块概述

### 2.1 模块职责

Swarm Backends 子模块负责 Claude Code 多 Agent 协作（Swarm Mode）中队友进程的执行环境管理。其核心职责包括：

1. **后端抽象**：定义统一的 `PaneBackend` 和 `TeammateExecutor` 接口，屏蔽不同终端环境（tmux、iTerm2、进程内）的差异
2. **环境检测**：在启动时自动检测当前运行环境（是否在 tmux 会话内、是否在 iTerm2 中），确定可用的后端
3. **后端注册与选择**：通过工厂注册模式管理后端类的注册，按优先级选择最适合的后端
4. **窗格生命周期管理**：创建、布局、着色、隐藏/显示、销毁终端窗格
5. **队友生命周期管理**：生成（spawn）、消息发送、优雅终止（terminate）、强制杀死（kill）队友

### 2.2 模块边界

| 边界方向 | 交互对象 | 交互内容 |
|----------|---------|---------|
| 上游调用方 | `TeammateTool`、Swarm 编排层 | 通过 `getTeammateExecutor()` 获取执行器，调用 `spawn/sendMessage/terminate/kill` |
| 下游依赖 | tmux CLI、it2 CLI、Node.js 进程 | 通过 `execFileNoThrow` 执行外部命令 |
| 同层协作 | `spawnUtils.ts`、`teammateLayoutManager.ts`、`teammateMailbox.ts` | 构建 CLI 命令、分配颜色、文件邮箱通信 |
| 状态依赖 | `bootstrap/state.ts`、`teammateModeSnapshot.ts` | 获取会话 ID、队友模式快照 |
| 类型共享 | `AgentTool/agentColorManager.ts`、`Tool.ts` | 颜色类型、ToolUseContext |

## 3. 架构设计

### 3.1 模块架构图

```mermaid
graph TB
    subgraph 调用层
        TT[TeammateTool]
        SO[Swarm Orchestrator]
    end

    subgraph "Swarm Backends 子模块"
        REG[registry.ts<br/>后端注册与选择]
        DET[detection.ts<br/>环境检测]
        
        subgraph 后端实现
            TB[TmuxBackend.ts<br/>tmux 后端]
            IB[ITermBackend.ts<br/>iTerm2 后端]
            IPB[InProcessBackend.ts<br/>进程内后端]
        end
        
        PBE[PaneBackendExecutor.ts<br/>窗格适配器]
        TYP[types.ts<br/>核心类型定义]
    end

    subgraph 外部工具
        TMUX[tmux CLI]
        IT2[it2 CLI]
        NODE[Node.js 进程]
    end

    TT --> REG
    SO --> REG
    REG --> DET
    REG --> TB
    REG --> IB
    REG --> IPB
    REG --> PBE
    PBE --> TB
    PBE --> IB
    TB --> TMUX
    IB --> IT2
    IPB --> NODE
    TB -.->|自注册| REG
    IB -.->|自注册| REG
    TYP -.->|类型定义| REG
    TYP -.->|类型定义| TB
    TYP -.->|类型定义| IB
    TYP -.->|类型定义| IPB
    TYP -.->|类型定义| PBE
```

### 3.2 源文件组织

```mermaid
graph LR
    subgraph "utils/swarm/backends/"
        types.ts["types.ts (312行)<br/>核心接口与类型"]
        registry.ts["registry.ts (465行)<br/>注册中心与检测入口"]
        detection.ts["detection.ts (129行)<br/>环境探测函数"]
        TmuxBackend.ts["TmuxBackend.ts (765行)<br/>tmux 窗格管理"]
        ITermBackend.ts["ITermBackend.ts (371行)<br/>iTerm2 窗格管理"]
        InProcessBackend.ts["InProcessBackend.ts (340行)<br/>进程内执行"]
        PaneBackendExecutor.ts["PaneBackendExecutor.ts (355行)<br/>PaneBackend→TeammateExecutor 适配"]
    end
```

### 3.3 外部依赖表

| 依赖模块 | 路径 | 用途 |
|----------|------|------|
| `execFileNoThrow` | `utils/execFileNoThrow.ts` | 安全执行外部命令（不抛异常） |
| `logForDebugging` | `utils/debug.ts` | 调试日志输出 |
| `logError` | `utils/log.ts` | 错误日志记录 |
| `sleep` | `utils/sleep.ts` | 窗格 shell 初始化等待 |
| `getPlatform` | `utils/platform.ts` | 平台检测（用于安装指引） |
| `env` | `utils/env.ts` | 环境变量检测（终端类型） |
| `agentColorManager` | `tools/AgentTool/agentColorManager.ts` | Agent 颜色类型定义 |
| `constants.ts` | `utils/swarm/constants.ts` | Swarm 常量（会话名、命令名） |
| `spawnUtils.ts` | `utils/swarm/spawnUtils.ts` | 构建 CLI 命令与环境变量 |
| `teammateMailbox.ts` | `utils/teammateMailbox.ts` | 文件邮箱读写 |
| `teammateModeSnapshot.ts` | `utils/swarm/backends/teammateModeSnapshot.ts` | 队友模式启动快照 |
| `InProcessTeammateTask` | `tasks/InProcessTeammateTask/` | 进程内队友任务管理 |
| `spawnInProcess.ts` | `utils/swarm/spawnInProcess.ts` | 进程内队友生成与销毁 |
| `inProcessRunner.ts` | `utils/swarm/inProcessRunner.ts` | 进程内队友执行循环 |
| `bootstrap/state.ts` | `bootstrap/state.ts` | 会话 ID、非交互模式检测 |
| `cleanupRegistry.ts` | `utils/cleanupRegistry.ts` | 进程退出清理注册 |
| `bash/shellQuote.ts` | `utils/bash/shellQuote.ts` | Shell 命令引号转义 |

## 4. 数据结构设计

### 4.1 核心接口和类型定义

#### 4.1.1 BackendType 与 PaneBackendType

```typescript
// types.ts:9
type BackendType = 'tmux' | 'iterm2' | 'in-process'

// types.ts:15
type PaneBackendType = 'tmux' | 'iterm2'
```

`BackendType` 枚举全部三种执行模式，`PaneBackendType` 是其子集，仅包含基于终端窗格的后端。通过类型守卫 `isPaneBackend()` (types.ts:309) 进行运行时区分。

#### 4.1.2 PaneId

```typescript
// types.ts:22
type PaneId = string
```

窗格的不透明标识符。对 tmux 为窗格 ID（如 `%1`），对 iTerm2 为会话 UUID。

#### 4.1.3 CreatePaneResult

```typescript
// types.ts:27-32
type CreatePaneResult = {
  paneId: PaneId
  isFirstTeammate: boolean  // 影响布局策略
}
```

#### 4.1.4 TeammateIdentity

```typescript
// types.ts:191-200
type TeammateIdentity = {
  name: string              // Agent 名称（如 "researcher"）
  teamName: string          // 团队名称
  color?: AgentColorName    // UI 颜色
  planModeRequired?: boolean // 是否需要计划模式审批
}
```

#### 4.1.5 TeammateSpawnConfig

```typescript
// types.ts:205-225
type TeammateSpawnConfig = TeammateIdentity & {
  prompt: string            // 初始提示词
  cwd: string               // 工作目录
  model?: string            // 模型选择
  systemPrompt?: string     // 系统提示词
  systemPromptMode?: 'default' | 'replace' | 'append'
  worktreePath?: string     // Git worktree 路径
  parentSessionId: string   // 父会话 ID
  permissions?: string[]    // 工具权限列表
  allowPermissionPrompts?: boolean // 是否允许未列出工具的权限提示
}
```

#### 4.1.6 TeammateSpawnResult

```typescript
// types.ts:230-254
type TeammateSpawnResult = {
  success: boolean
  agentId: string           // 格式: agentName@teamName
  error?: string
  abortController?: AbortController  // 仅进程内模式
  taskId?: string           // 仅进程内模式，AppState.tasks 索引
  paneId?: PaneId           // 仅窗格模式
}
```

#### 4.1.7 TeammateMessage

```typescript
// types.ts:259-270
type TeammateMessage = {
  text: string
  from: string
  color?: string
  timestamp?: string
  summary?: string          // 5-10 词 UI 预览摘要
}
```

#### 4.1.8 BackendDetectionResult

```typescript
// types.ts:173-180
type BackendDetectionResult = {
  backend: PaneBackend      // 选中的后端实例
  isNative: boolean         // 是否在原生环境内运行
  needsIt2Setup?: boolean   // iTerm2 检测到但 it2 未安装
}
```

### 4.2 类继承关系

```mermaid
classDiagram
    class PaneBackend {
        <<interface>>
        +type: BackendType
        +displayName: string
        +supportsHideShow: boolean
        +isAvailable() Promise~boolean~
        +isRunningInside() Promise~boolean~
        +createTeammatePaneInSwarmView(name, color) Promise~CreatePaneResult~
        +sendCommandToPane(paneId, command, useExternalSession?) Promise~void~
        +setPaneBorderColor(paneId, color, useExternalSession?) Promise~void~
        +setPaneTitle(paneId, name, color, useExternalSession?) Promise~void~
        +enablePaneBorderStatus(windowTarget?, useExternalSession?) Promise~void~
        +rebalancePanes(windowTarget, hasLeader) Promise~void~
        +killPane(paneId, useExternalSession?) Promise~boolean~
        +hidePane(paneId, useExternalSession?) Promise~boolean~
        +showPane(paneId, targetWindowOrPane, useExternalSession?) Promise~boolean~
    }

    class TeammateExecutor {
        <<interface>>
        +type: BackendType
        +isAvailable() Promise~boolean~
        +spawn(config) Promise~TeammateSpawnResult~
        +sendMessage(agentId, message) Promise~void~
        +terminate(agentId, reason?) Promise~boolean~
        +kill(agentId) Promise~boolean~
        +isActive(agentId) Promise~boolean~
    }

    class TmuxBackend {
        +type: 'tmux'
        +displayName: 'tmux'
        +supportsHideShow: true
        -getCurrentPaneId() Promise~string~
        -getCurrentWindowTarget() Promise~string~
        -getCurrentWindowPaneCount() Promise~number~
        -hasSessionInSwarm(sessionName) Promise~boolean~
        -createExternalSwarmSession() Promise~object~
        -createTeammatePaneWithLeader(name, color) Promise~CreatePaneResult~
        -createTeammatePaneExternal(name, color) Promise~CreatePaneResult~
        -rebalancePanesWithLeader(windowTarget) Promise~void~
        -rebalancePanesTiled(windowTarget) Promise~void~
    }

    class ITermBackend {
        +type: 'iterm2'
        +displayName: 'iTerm2'
        +supportsHideShow: false
    }

    class InProcessBackend {
        +type: 'in-process'
        -context: ToolUseContext
        +setContext(context) void
    }

    class PaneBackendExecutor {
        +type: BackendType
        -backend: PaneBackend
        -context: ToolUseContext
        -spawnedTeammates: Map
        -cleanupRegistered: boolean
        +setContext(context) void
    }

    PaneBackend <|.. TmuxBackend : 实现
    PaneBackend <|.. ITermBackend : 实现
    TeammateExecutor <|.. InProcessBackend : 实现
    TeammateExecutor <|.. PaneBackendExecutor : 实现
    PaneBackendExecutor --> PaneBackend : 包装/适配
```

## 5. 接口设计

### 5.1 PaneBackend 接口

`PaneBackend`（types.ts:39-168）是窗格管理的底层抽象，定义了终端窗格的全部操作原语。

| 方法 | 职责 | TmuxBackend 实现 | ITermBackend 实现 |
|------|------|-----------------|-----------------|
| `isAvailable()` | 检查后端是否可用 | 调用 `tmux -V` | 检查 iTerm2 环境 + it2 CLI |
| `isRunningInside()` | 是否在原生环境内 | 检查 `TMUX` 环境变量 | 检查 `TERM_PROGRAM` 等 |
| `createTeammatePaneInSwarmView()` | 创建队友窗格 | `split-window` / 外部会话 | `it2 session split` |
| `sendCommandToPane()` | 发送命令到窗格 | `tmux send-keys` | `it2 session run` |
| `setPaneBorderColor()` | 设置边框颜色 | `set-option pane-border-style` | No-op（性能原因） |
| `setPaneTitle()` | 设置窗格标题 | `select-pane -T` + `pane-border-format` | No-op（性能原因） |
| `enablePaneBorderStatus()` | 启用边框状态 | `set-option pane-border-status top` | No-op |
| `rebalancePanes()` | 重新均衡布局 | `select-layout main-vertical/tiled` | No-op（自动均衡） |
| `killPane()` | 关闭窗格 | `tmux kill-pane` | `it2 session close -f` |
| `hidePane()` | 隐藏窗格 | `break-pane` 到隐藏会话 | 不支持，返回 `false` |
| `showPane()` | 显示隐藏窗格 | `join-pane` 回主窗口 | 不支持，返回 `false` |

### 5.2 TeammateExecutor 接口

`TeammateExecutor`（types.ts:279-300）是队友生命周期管理的高层抽象，统一了窗格模式和进程内模式。

| 方法 | 职责 | 窗格模式（PaneBackendExecutor） | 进程内模式（InProcessBackend） |
|------|------|-------------------------------|------------------------------|
| `isAvailable()` | 检查可用性 | 委托给底层 PaneBackend | 始终返回 `true` |
| `spawn()` | 生成队友 | 创建窗格 + 发送 CLI 命令 | 调用 `spawnInProcessTeammate` + `startInProcessTeammate` |
| `sendMessage()` | 发送消息 | 写入文件邮箱 | 写入文件邮箱 |
| `terminate()` | 优雅终止 | 邮箱发送关闭请求 | 邮箱发送关闭请求 + 设置 `shutdownRequested` 标志 |
| `kill()` | 强制杀死 | `killPane()` 销毁窗格 | `AbortController.abort()` 取消异步操作 |
| `isActive()` | 检查存活 | 检查 `spawnedTeammates` Map | 检查 AppState 任务状态 + AbortController |

### 5.3 对外 API（registry.ts 导出）

| 函数 | 签名 | 用途 |
|------|------|------|
| `detectAndGetBackend()` | `() => Promise<BackendDetectionResult>` | 自动检测并返回最佳窗格后端 |
| `getBackendByType()` | `(type: PaneBackendType) => PaneBackend` | 按类型获取后端实例 |
| `getTeammateExecutor()` | `(preferInProcess?: boolean) => Promise<TeammateExecutor>` | 获取队友执行器（统一入口） |
| `getInProcessBackend()` | `() => TeammateExecutor` | 获取进程内后端（单例） |
| `isInProcessEnabled()` | `() => boolean` | 检查当前是否启用进程内模式 |
| `getResolvedTeammateMode()` | `() => 'in-process' \| 'tmux'` | 获取实际解析后的队友模式 |
| `getCachedBackend()` | `() => PaneBackend \| null` | 获取缓存的窗格后端 |
| `getCachedDetectionResult()` | `() => BackendDetectionResult \| null` | 获取缓存的检测结果 |
| `ensureBackendsRegistered()` | `() => Promise<void>` | 确保后端类已动态导入注册 |
| `markInProcessFallback()` | `() => void` | 标记已回退到进程内模式 |
| `resetBackendDetection()` | `() => void` | 重置检测缓存（测试用） |
| `registerTmuxBackend()` | `(cls) => void` | 注册 TmuxBackend 类 |
| `registerITermBackend()` | `(cls) => void` | 注册 ITermBackend 类 |

## 6. 核心流程设计

### 6.1 后端检测流程

`detectAndGetBackend()`（registry.ts:136-254）按严格优先级选择窗格后端：

```mermaid
flowchart TD
    START[detectAndGetBackend] --> CACHE{缓存命中?}
    CACHE -->|是| RET_CACHE[返回缓存结果]
    CACHE -->|否| REG[ensureBackendsRegistered]
    REG --> CHK_TMUX{在 tmux 会话内?<br/>TMUX 环境变量}
    
    CHK_TMUX -->|是| USE_TMUX_NATIVE["创建 TmuxBackend<br/>isNative=true"]
    
    CHK_TMUX -->|否| CHK_ITERM{在 iTerm2 内?<br/>TERM_PROGRAM/ITERM_SESSION_ID}
    
    CHK_ITERM -->|是| CHK_PREFER{"用户偏好 tmux?<br/>getPreferTmuxOverIterm2()"}
    CHK_PREFER -->|是| CHK_TMUX_AVAIL2{tmux 可用?}
    CHK_PREFER -->|否| CHK_IT2{it2 CLI 可用?<br/>it2 session list}
    
    CHK_IT2 -->|是| USE_ITERM["创建 ITermBackend<br/>isNative=true"]
    CHK_IT2 -->|否| CHK_TMUX_AVAIL2
    
    CHK_TMUX_AVAIL2 -->|是| USE_TMUX_FALLBACK["创建 TmuxBackend<br/>isNative=false<br/>needsIt2Setup=!preferTmux"]
    CHK_TMUX_AVAIL2 -->|否| ERR_ITERM[抛出错误：需安装 it2]
    
    CHK_ITERM -->|否| CHK_TMUX_AVAIL3{tmux 可用?<br/>tmux -V}
    CHK_TMUX_AVAIL3 -->|是| USE_TMUX_EXT["创建 TmuxBackend<br/>isNative=false<br/>外部会话模式"]
    CHK_TMUX_AVAIL3 -->|否| ERR_INSTALL[抛出错误：<br/>平台特定安装指引]
    
    USE_TMUX_NATIVE --> CACHE_SET[缓存结果]
    USE_ITERM --> CACHE_SET
    USE_TMUX_FALLBACK --> CACHE_SET
    USE_TMUX_EXT --> CACHE_SET
    CACHE_SET --> RET[返回 BackendDetectionResult]
```

**队友模式解析**（`isInProcessEnabled()`，registry.ts:351-389）：

```mermaid
flowchart TD
    START[isInProcessEnabled] --> NON_INT{非交互会话?<br/>-p 模式}
    NON_INT -->|是| RET_TRUE[返回 true]
    NON_INT -->|否| GET_MODE[getTeammateMode]
    GET_MODE --> CHK_MODE{mode 值?}
    CHK_MODE -->|in-process| RET_TRUE2[返回 true]
    CHK_MODE -->|tmux| RET_FALSE[返回 false]
    CHK_MODE -->|auto| CHK_FALLBACK{inProcessFallbackActive?}
    CHK_FALLBACK -->|是| RET_TRUE3[返回 true]
    CHK_FALLBACK -->|否| CHK_ENV{在 tmux 或 iTerm2 内?}
    CHK_ENV -->|是| RET_FALSE2[返回 false<br/>使用窗格后端]
    CHK_ENV -->|否| RET_TRUE4[返回 true<br/>使用进程内后端]
```

### 6.2 队友生成流程

#### 6.2.1 PaneBackendExecutor.spawn()（PaneBackendExecutor.ts:79-209）

```mermaid
sequenceDiagram
    participant Caller as 调用方
    participant PBE as PaneBackendExecutor
    participant Backend as PaneBackend (tmux/iTerm2)
    participant Mailbox as teammateMailbox
    participant Cleanup as cleanupRegistry

    Caller->>PBE: spawn(config)
    PBE->>PBE: formatAgentId(name, teamName)
    PBE->>PBE: assignTeammateColor(agentId)
    PBE->>Backend: createTeammatePaneInSwarmView(name, color)
    Backend-->>PBE: {paneId, isFirstTeammate}
    
    alt isFirstTeammate && insideTmux
        PBE->>Backend: enablePaneBorderStatus()
    end
    
    PBE->>PBE: buildInheritedCliFlags + buildInheritedEnvVars
    PBE->>PBE: 构建 CLI 命令:<br/>cd $cwd && env $vars claude $args
    PBE->>Backend: sendCommandToPane(paneId, command, !insideTmux)
    PBE->>PBE: spawnedTeammates.set(agentId, {paneId, insideTmux})
    
    alt 首次 spawn
        PBE->>Cleanup: registerCleanup(killAllPanes)
    end
    
    PBE->>Mailbox: writeToMailbox(name, prompt, teamName)
    PBE-->>Caller: {success: true, agentId, paneId}
```

#### 6.2.2 InProcessBackend.spawn()（InProcessBackend.ts:72-143）

```mermaid
sequenceDiagram
    participant Caller as 调用方
    participant IPB as InProcessBackend
    participant Spawn as spawnInProcess
    participant Runner as inProcessRunner

    Caller->>IPB: spawn(config)
    
    alt context 未设置
        IPB-->>Caller: {success: false, error: "not initialized"}
    end
    
    IPB->>Spawn: spawnInProcessTeammate(identity, context)
    Spawn-->>IPB: {success, agentId, taskId, teammateContext, abortController}
    
    alt spawn 成功
        IPB->>Runner: startInProcessTeammate({identity, taskId, prompt, ...})
        Note over Runner: 后台执行（fire-and-forget）
    end
    
    IPB-->>Caller: {success, agentId, taskId, abortController}
```

### 6.3 窗格管理流程

#### 6.3.1 TmuxBackend 窗格创建（内部 tmux 会话）

```mermaid
flowchart TD
    START[createTeammatePaneInSwarmView] --> LOCK[acquirePaneCreationLock]
    LOCK --> CHK{isRunningInside?}
    
    CHK -->|内部模式| WITH_LEADER[createTeammatePaneWithLeader]
    WITH_LEADER --> GET_PANE[获取 leader pane ID<br/>TMUX_PANE 环境变量]
    GET_PANE --> GET_WIN[获取 window target<br/>session:window 格式]
    GET_WIN --> COUNT[获取窗格数量]
    COUNT --> IS_FIRST{paneCount == 1?}
    
    IS_FIRST -->|是| SPLIT_H["split-window -h -l 70%<br/>从 leader 水平分割"]
    IS_FIRST -->|否| CALC_SPLIT[计算分割策略:<br/>奇数队友 → 垂直分割<br/>偶数队友 → 水平分割]
    CALC_SPLIT --> SPLIT_ANY[split-window 从目标窗格]
    
    SPLIT_H --> STYLE[setPaneBorderColor + setPaneTitle]
    SPLIT_ANY --> STYLE
    STYLE --> REBALANCE["rebalancePanesWithLeader<br/>main-vertical 布局<br/>leader 30%, 队友 70%"]
    REBALANCE --> WAIT["waitForPaneShellReady<br/>200ms"]
    
    CHK -->|外部模式| WITHOUT_LEADER[createTeammatePaneExternal]
    WITHOUT_LEADER --> CREATE_SESSION["createExternalSwarmSession<br/>claude-swarm:swarm-view"]
    CREATE_SESSION --> EXT_FIRST{首个队友?}
    EXT_FIRST -->|是| USE_FIRST[使用会话创建时的初始窗格]
    EXT_FIRST -->|否| EXT_SPLIT[计算分割策略并 split-window]
    USE_FIRST --> EXT_STYLE[设置颜色和标题]
    EXT_SPLIT --> EXT_STYLE
    EXT_STYLE --> EXT_REBALANCE["rebalancePanesTiled<br/>tiled 平铺布局"]
    EXT_REBALANCE --> WAIT2["waitForPaneShellReady<br/>200ms"]
    
    WAIT --> RELEASE[释放锁]
    WAIT2 --> RELEASE
```

#### 6.3.2 TmuxBackend 布局策略

**内部模式布局**（有 leader）：
- 使用 `main-vertical` 布局
- Leader 窗格占左侧 30%
- 队友窗格共享右侧 70%
- 分割算法：第 N 个队友（N 从 0 开始），若 N 为奇数则垂直分割，偶数则水平分割，分割目标为 `floor((N-1)/2)` 号队友窗格

**外部模式布局**（无 leader）：
- 使用 `tiled` 平铺布局
- 所有队友窗格均等分布
- 运行在独立 tmux socket（`getSwarmSocketName()`）

#### 6.3.3 ITermBackend 窗格创建（ITermBackend.ts:114-239）

iTerm2 后端使用 `it2 session split` 创建窗格，具有死窗格自动恢复机制：

```mermaid
flowchart TD
    START[createTeammatePaneInSwarmView] --> LOCK[acquirePaneCreationLock]
    LOCK --> LOOP[while true 循环]
    LOOP --> IS_FIRST{firstPaneUsed?}
    
    IS_FIRST -->|首个队友| GET_LEADER["getLeaderSessionId()<br/>从 ITERM_SESSION_ID 提取 UUID"]
    GET_LEADER --> SPLIT_V["it2 session split -v -s leaderSessionId<br/>从 leader 垂直分割"]
    
    IS_FIRST -->|后续队友| GET_LAST["获取最后一个队友 sessionId"]
    GET_LAST --> SPLIT_H["it2 session split -s lastTeammateId<br/>从最后队友水平分割"]
    
    SPLIT_V --> CHK_RESULT{split 成功?}
    SPLIT_H --> CHK_RESULT
    
    CHK_RESULT -->|成功| PARSE["parseSplitOutput<br/>提取 session UUID"]
    CHK_RESULT -->|失败且有目标| VERIFY["it2 session list<br/>验证目标是否已死"]
    
    VERIFY --> IS_DEAD{目标确认已死?}
    IS_DEAD -->|是| PRUNE["修剪死 sessionId<br/>重置 firstPaneUsed 如需"]
    PRUNE --> LOOP
    IS_DEAD -->|否| THROW[抛出错误]
    
    PARSE --> TRACK["teammateSessionIds.push(paneId)"]
    TRACK --> RETURN[返回 {paneId, isFirstTeammate}]
    RETURN --> RELEASE[释放锁]
```

#### 6.3.4 隐藏/显示窗格（仅 TmuxBackend）

```mermaid
sequenceDiagram
    participant Caller as 调用方
    participant TB as TmuxBackend
    participant TMUX as tmux

    Note over Caller,TMUX: hidePane 流程
    Caller->>TB: hidePane(paneId)
    TB->>TMUX: new-session -d -s claude-hidden
    TB->>TMUX: break-pane -d -s paneId -t claude-hidden:
    TMUX-->>TB: 成功/失败
    TB-->>Caller: boolean

    Note over Caller,TMUX: showPane 流程
    Caller->>TB: showPane(paneId, targetWindow)
    TB->>TMUX: join-pane -h -s paneId -t targetWindow
    TB->>TMUX: select-layout -t targetWindow main-vertical
    TB->>TMUX: resize-pane -t firstPane -x 30%
    TB-->>Caller: boolean
```

## 7. 设计模式分析

### 7.1 策略模式（Strategy Pattern）

**体现位置**：`PaneBackend` 接口 + `TmuxBackend` / `ITermBackend` 实现

策略模式在此模块中用于将窗格管理的具体算法封装到不同的后端类中。`PaneBackend` 接口定义了窗格操作的统一契约，而 `TmuxBackend` 和 `ITermBackend` 分别实现了基于 tmux CLI 和 it2 CLI 的具体策略。

registry.ts 中的 `detectAndGetBackend()` 充当策略选择器，根据运行环境动态选择最适合的策略。选择后通过缓存固定，不再改变。

**关键代码**：
```typescript
// registry.ts:136 - 策略选择
export async function detectAndGetBackend(): Promise<BackendDetectionResult> {
  // 优先级: tmux内部 > iTerm2原生 > tmux外部 > 报错
}
```

### 7.2 适配器模式（Adapter Pattern）

**体现位置**：`PaneBackendExecutor`（PaneBackendExecutor.ts:39）

`PaneBackendExecutor` 是经典的对象适配器，将底层的 `PaneBackend`（窗格操作原语）适配为高层的 `TeammateExecutor`（队友生命周期管理）。

适配映射关系：
| TeammateExecutor 方法 | 适配到 PaneBackend 操作 |
|----------------------|----------------------|
| `spawn()` | `createTeammatePaneInSwarmView()` + `sendCommandToPane()` |
| `sendMessage()` | `writeToMailbox()`（旁路，不经过 PaneBackend） |
| `terminate()` | `writeToMailbox()`（邮箱发送关闭请求） |
| `kill()` | `killPane()` |
| `isActive()` | 基于内部 Map 状态判断 |

这使得调用方可以通过统一的 `TeammateExecutor` 接口操作队友，无需关心底层是窗格模式还是进程内模式。

### 7.3 工厂注册模式（Factory Registry Pattern）

**体现位置**：registry.ts 中的后端注册机制

后端类通过模块导入时的副作用自注册到 registry：

```typescript
// TmuxBackend.ts:764 - 模块加载时自注册
registerTmuxBackend(TmuxBackend)

// ITermBackend.ts:370 - 模块加载时自注册
registerITermBackend(ITermBackend)
```

registry.ts 持有类引用（`TmuxBackendClass` / `ITermBackendClass`），通过工厂函数 `createTmuxBackend()` / `createITermBackend()` 延迟实例化。

**设计动机**：避免循环依赖。后端实现依赖 registry（调用 `register*`），registry 依赖后端类（实例化）。通过延迟动态 import（`ensureBackendsRegistered()`，registry.ts:74-79）和自注册机制打断循环。

### 7.4 其他模式

- **单例模式**：`cachedBackend`、`cachedInProcessBackend`、`cachedPaneBackendExecutor` 均为模块级缓存的单例实例
- **锁模式**：`acquirePaneCreationLock()`（TmuxBackend.ts:43-53，ITermBackend.ts:21-31）通过 Promise 链实现异步互斥锁，防止并行创建窗格时的竞态条件
- **模板方法模式**：`TmuxBackend.rebalancePanes()` 根据 `hasLeader` 参数委托到 `rebalancePanesWithLeader()` 或 `rebalancePanesTiled()` 两个不同的布局算法

## 8. 错误处理设计

### 8.1 错误分类

| 错误类型 | 来源 | 处理方式 |
|----------|------|---------|
| 后端不可用 | `detectAndGetBackend()` 无法找到可用后端 | 抛出平台特定安装指引（registry.ts:259-285） |
| 后端未注册 | `createTmuxBackend()` / `createITermBackend()` 在注册前被调用 | 抛出明确错误信息（registry.ts:107-126） |
| 窗格创建失败 | tmux `split-window` / it2 `session split` 返回非零 | 抛出 Error（TmuxBackend.ts:613，ITermBackend.ts:205） |
| 死窗格恢复 | iTerm2 分割目标已死 | 自动修剪并重试（ITermBackend.ts:185-203），有界 O(N+1) |
| 命令发送失败 | `send-keys` / `session run` 失败 | 抛出 Error（TmuxBackend.ts:160，ITermBackend.ts:260） |
| 上下文缺失 | `spawn()` 在 `setContext()` 之前调用 | 返回 `{success: false, error: "not initialized"}`（InProcessBackend.ts:74-82，PaneBackendExecutor.ts:83-91） |
| 队友未找到 | `terminate/kill/isActive` 传入未知 agentId | InProcessBackend 返回 false（InProcessBackend.ts:209），PaneBackendExecutor 返回 false（PaneBackendExecutor.ts:299） |
| agentId 格式错误 | `parseAgentId()` 解析失败 | 抛出 Error（PaneBackendExecutor.ts:223）或返回 false |

### 8.2 防御性设计

1. **环境变量捕获时机**：`ORIGINAL_USER_TMUX` 和 `ORIGINAL_TMUX_PANE` 在模块加载时捕获（detection.ts:10-19），防止后续 Shell.ts 覆盖 `process.env.TMUX` 导致误判

2. **缓存不可变性**：后端检测结果一旦缓存即固定（registry.ts:26-31），进程生命周期内不会重新检测，避免环境变化导致的不一致

3. **并发安全**：窗格创建通过异步锁（Promise 链）序列化，防止多个队友同时 spawn 导致的布局错乱

4. **清理注册**：`PaneBackendExecutor.spawn()` 首次调用时注册退出清理回调（PaneBackendExecutor.ts:164-175），确保 leader 退出时杀死所有队友窗格

5. **回退机制**：`markInProcessFallback()` 记录窗格后端不可用的回退状态，后续 spawn 直接使用进程内模式，避免重复失败

### 8.3 日志策略

全模块使用 `logForDebugging()` 进行详细的调试日志输出，覆盖：
- 环境检测结果（registry.ts:148-156）
- 后端选择决策路径（registry.ts:159-253）
- 窗格创建/销毁操作（TmuxBackend.ts:618-619，ITermBackend.ts:224-225）
- 执行器操作（PaneBackendExecutor.ts:188-189，InProcessBackend.ts:131-133）

日志前缀标识来源：`[BackendRegistry]`、`[TmuxBackend]`、`[ITermBackend]`、`[InProcessBackend]`、`[PaneBackendExecutor]`。

## 9. 设计评估

### 9.1 优点

1. **清晰的抽象层次**：`PaneBackend`（窗格原语）→ `TeammateExecutor`（生命周期管理）两层抽象，职责分离明确。调用方通过 `getTeammateExecutor()` 一个入口即可获取合适的执行器，完全屏蔽后端差异。

2. **健壮的优先级检测**：`detectAndGetBackend()` 实现了完善的五级优先级链（tmux 内 > iTerm2 原生 > tmux 回退 > tmux 外部 > 错误），包含用户偏好记忆（`getPreferTmuxOverIterm2`）和 `needsIt2Setup` 提示。

3. **并发安全设计**：异步锁机制确保窗格创建的原子性，防止并行 spawn 导致的布局问题。使用 Promise 链实现，无需引入外部锁库。

4. **自注册避免循环依赖**：后端实现在模块加载时自注册，registry 通过延迟 import 触发注册，优雅地解决了双向依赖问题。

5. **死窗格恢复**：ITermBackend 的 `createTeammatePaneInSwarmView()` 实现了完整的死窗格检测-修剪-重试循环，且有界（O(N+1)），兼顾了可靠性和安全性。

6. **统一的通信机制**：所有后端（窗格和进程内）均使用文件邮箱进行消息传递，简化了通信层设计。

### 9.2 缺点与风险

1. **模块级可变状态过多**：registry.ts 包含 6 个模块级缓存变量（cachedBackend、cachedDetectionResult、backendsRegistered、cachedInProcessBackend、cachedPaneBackendExecutor、inProcessFallbackActive），TmuxBackend.ts 有 3 个（firstPaneUsedForExternal、cachedLeaderWindowTarget、paneCreationLock），ITermBackend.ts 有 3 个。这增加了状态管理的复杂度，且难以在单元测试中充分隔离。

2. **iTerm2 后端功能不完整**：`setPaneBorderColor()`、`setPaneTitle()`、`rebalancePanes()` 均为 No-op（ITermBackend.ts:270-313），注释说明是因为"每次 it2 调用都会启动 Python 进程，太慢"。这导致 iTerm2 模式下队友窗格缺少视觉区分。

3. **isActive() 实现薄弱**：`PaneBackendExecutor.isActive()`（PaneBackendExecutor.ts:329-344）仅检查内部 Map 是否有记录，不查询窗格实际存活状态。注释承认"a more robust check would query the backend for pane existence"但未实现。

4. **硬编码延迟**：`PANE_SHELL_INIT_DELAY_MS = 200`（TmuxBackend.ts:33）是固定值，对快速 shell 配置浪费时间，对特别慢的配置可能不够。

5. **外部会话 socket 命名**：tmux 外部模式使用 `getSwarmSocketName()` 创建独立 socket，若多个 Claude 实例同时运行可能产生命名冲突（取决于 socket 名称生成逻辑）。

### 9.3 改进建议

1. **状态封装**：将 registry.ts 的模块级变量封装到一个 `BackendRegistry` 类中，支持实例化和独立测试。当前的 `resetBackendDetection()` 是为测试设计的临时方案。

2. **iTerm2 视觉增强**：考虑使用 ANSI 转义序列（而非 it2 CLI）设置窗格标题和颜色，避免 Python 进程开销。iTerm2 支持 `\033]1337;SetBadgeFormat=...` 等私有转义序列。

3. **isActive 增强**：为 `PaneBackend` 接口添加 `isPaneAlive(paneId)` 方法，TmuxBackend 可通过 `tmux list-panes` 检查，ITermBackend 可通过 `it2 session list` 验证。

4. **自适应延迟**：将 shell 初始化延迟改为探测式等待（轮询窗格是否就绪），或允许通过配置调整延迟时间。

5. **TypeScript 严格类型**：`PaneBackend` 当前定义为 `type`（types.ts:39），可考虑改为 `interface`，便于 `extends` 和类型合并。`TeammateExecutor` 同理。
