import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import type { ToolUseContext } from '../../Tool.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import { REMOTE_TRIGGER_TOOL_NAME } from '../../tools/RemoteTriggerTool/prompt.js'
import { getClaudeAIOAuthTokens } from '../../utils/auth.js'
import { checkRepoForRemoteAccess } from '../../utils/background/remote/preconditions.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  detectCurrentRepositoryWithHost,
  parseGitRemote,
} from '../../utils/detectRepository.js'
import { getRemoteUrl } from '../../utils/git.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  createDefaultCloudEnvironment,
  type EnvironmentResource,
  fetchEnvironments,
} from '../../utils/teleport/environments.js'
import { registerBundledSkill } from '../bundledSkills.js'

// 标签ID系统使用的Base58字符集（比特币风格）
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/**
 * 将带 mcpsrv_ 前缀的标签ID解码为UUID字符串
 * 标签ID格式：mcpsrv_01{base58(uuid.int)}
 * 其中 01 是版本前缀
 *
 * TODO(公开上线)：公开上线前，/v1/mcp_servers 接口
 * 应直接返回原始UUID，无需在客户端进行此解码操作
 * 标签ID格式为内部实现细节，可能会发生变更
 */
function taggedIdToUUID(taggedId: string): string | null {
  const prefix = 'mcpsrv_'
  if (!taggedId.startsWith(prefix)) {
    return null
  }
  const rest = taggedId.slice(prefix.length)
  // 跳过版本前缀（2个字符，固定为"01"）
  const base58Data = rest.slice(2)

  // 将Base58解码为大整数
  let n = 0n
  for (const c of base58Data) {
    const idx = BASE58.indexOf(c)
    if (idx === -1) {
      return null
    }
    n = n * 58n + BigInt(idx)
  }

  // 转换为UUID十六进制字符串
  const hex = n.toString(16).padStart(32, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

type ConnectorInfo = {
  uuid: string
  name: string
  url: string
}

/**
 * 获取已连接的Claude AI连接器信息
 */
function getConnectedClaudeAIConnectors(
  mcpClients: MCPServerConnection[],
): ConnectorInfo[] {
  const connectors: ConnectorInfo[] = []
  for (const client of mcpClients) {
    if (client.type !== 'connected') {
      continue
    }
    if (client.config.type !== 'claudeai-proxy') {
      continue
    }
    const uuid = taggedIdToUUID(client.config.id)
    if (!uuid) {
      continue
    }
    connectors.push({
      uuid,
      name: client.name,
      url: client.config.url,
    })
  }
  return connectors
}

/**
 * 清理连接器名称，移除非法字符
 */
function sanitizeConnectorName(name: string): string {
  return name
    .replace(/^claude[.\s-]ai[.\s-]/i, '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * 格式化连接器信息为可读文本
 */
function formatConnectorsInfo(connectors: ConnectorInfo[]): string {
  if (connectors.length === 0) {
    return '未找到已连接的MCP连接器。用户可前往 https://claude.ai/settings/connectors 连接服务器'
  }
  const lines = ['已连接的连接器（可用于触发器）：']
  for (const c of connectors) {
    const safeName = sanitizeConnectorName(c.name)
    lines.push(
      `- ${c.name} (连接器UUID: ${c.uuid}, 名称: ${safeName}, 地址: ${c.url})`,
    )
  }
  return lines.join('\n')
}

// 基础问题文本
const BASE_QUESTION = '你希望对定时远程代理执行什么操作？'

/**
 * 将设置说明格式化为项目符号提示块
 * 在初始用户提问对话框（无参数路径）和提示体部分（参数路径）之间共享
 * 确保说明不会被静默忽略
 */
function formatSetupNotes(notes: string[]): string {
  const items = notes.map(n => `- ${n}`).join('\n')
  return `⚠ 注意：\n${items}`
}

/**
 * 获取当前仓库的HTTPS格式远程地址
 */
async function getCurrentRepoHttpsUrl(): Promise<string | null> {
  const remoteUrl = await getRemoteUrl()
  if (!remoteUrl) {
    return null
  }
  const parsed = parseGitRemote(remoteUrl)
  if (!parsed) {
    return null
  }
  return `https://${parsed.host}/${parsed.owner}/${parsed.name}`
}

/**
 * 构建完整的提示词
 */
function buildPrompt(opts: {
  userTimezone: string
  connectorsInfo: string
  gitRepoUrl: string | null
  environmentsInfo: string
  createdEnvironment: EnvironmentResource | null
  setupNotes: string[]
  needsGitHubAccessReminder: boolean
  userArgs: string
}): string {
  const {
    userTimezone,
    connectorsInfo,
    gitRepoUrl,
    environmentsInfo,
    createdEnvironment,
    setupNotes,
    needsGitHubAccessReminder,
    userArgs,
  } = opts
  // 当用户传入参数时，跳过初始的用户提问对话框
  // 设置说明必须在提示词主体中展示，否则会被计算后静默丢弃（相比旧的硬阻塞方案是回归）
  const setupNotesSection =
    userArgs && setupNotes.length > 0
      ? `\n## 设置说明\n\n${formatSetupNotes(setupNotes)}\n`
      : ''
  const initialQuestion =
    setupNotes.length > 0
      ? `${formatSetupNotes(setupNotes)}\n\n${BASE_QUESTION}`
      : BASE_QUESTION
  const firstStep = userArgs
    ? `用户已经告知需求（查看底部的用户请求）。跳过初始问题，直接执行匹配的工作流程。`
    : `你的第一步必须是调用一次 ${ASK_USER_QUESTION_TOOL_NAME} 工具（无需前置说明）。在 \`question\` 字段中使用以下**精确字符串**——不要改写或缩写：

${jsonStringify(initialQuestion)}

设置 \`header: "操作"\`，并提供四个操作选项（创建/列表/更新/立即运行）。用户选择后，按照下方匹配的工作流程执行。`

  return `# 定时远程代理

你正在协助用户创建、更新、查看或运行**远程**Claude代码代理。这些代理**不是**本地定时任务——每个触发器都会在Anthropic云基础设施中，按照定时计划启动一个完全隔离的远程会话（CCR）。代理运行在沙箱环境中，拥有独立的Git仓库、工具和可选的MCP连接。

## 第一步

${firstStep}
${setupNotesSection}

## 支持操作

使用 \`${REMOTE_TRIGGER_TOOL_NAME}\` 工具（先通过 \`ToolSearch select:${REMOTE_TRIGGER_TOOL_NAME}\` 加载；认证已内部处理，无需使用curl）：

- \`{action: "list"}\` — 查看所有触发器
- \`{action: "get", trigger_id: "..."}\` — 获取单个触发器详情
- \`{action: "create", body: {...}}\` — 创建触发器
- \`{action: "update", trigger_id: "...", body: {...}}\` — 部分更新触发器
- \`{action: "run", trigger_id: "..."}\` — 立即运行触发器

**不支持删除触发器**。如果用户要求删除，请引导至：https://claude.ai/code/scheduled

## 创建请求体格式

\`\`\`json
{
  "name": "代理名称",
  "cron_expression": "定时表达式",
  "enabled": true,
  "job_config": {
    "ccr": {
      "environment_id": "环境ID",
      "session_context": {
        "model": "claude-sonnet-4-6",
        "sources": [
          {"git_repository": {"url": "${gitRepoUrl || 'https://github.com/组织/仓库'}"}}
        ],
        "allowed_tools": ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]
      },
      "events": [
        {"data": {
          "uuid": "<小写v4格式UUID>",
          "session_id": "",
          "type": "user",
          "parent_tool_use_id": null,
          "message": {"content": "提示词内容", "role": "user"}
        }}
      ]
    }
  }
}
\`\`\`

请自行生成一个全新的小写UUID，用于 \`events[].data.uuid\` 字段。

## 可用MCP连接器

以下是用户当前已连接的claude.ai MCP连接器：

${connectorsInfo}

将连接器关联到触发器时，使用上方展示的 \`connector_uuid\`、\`name\`（名称已清理，仅包含字母、数字、连字符和下划线）和连接器地址。\`mcp_connections\` 中的 \`name\` 字段**仅允许** \`[a-zA-Z0-9_-]\` 字符——不允许点号和空格。

**重要**：根据用户描述推断代理所需的服务。例如，用户说“检查Datadog并通过Slack发送错误”，则代理需要Datadog和Slack连接器。与上方列表交叉核对，若缺少必需服务，需提醒用户。如果所需连接器未连接，引导用户先前往 https://claude.ai/settings/connectors 完成连接。

## 运行环境

每个触发器都需要在任务配置中指定 \`environment_id\`，用于决定远程代理的运行环境。请询问用户使用哪个环境。

${environmentsInfo}

请使用 \`id\` 值作为 \`job_config.ccr.environment_id\`。
${createdEnvironment ? `\n**注意**：由于用户无可用环境，已为其自动创建新环境 \`${createdEnvironment.name}\`（ID：\`${createdEnvironment.environment_id}\`）。请将该ID用于 \`job_config.ccr.environment_id\`，并在确认触发器配置时告知用户已自动创建环境。\n` : ''}

## API字段说明

### 创建触发器 — 必填字段
- \`name\` (字符串) — 描述性名称
- \`cron_expression\` (字符串) — 5位定时表达式。**最小间隔为1小时**
- \`job_config\` (对象) — 会话配置（参考上方结构）

### 创建触发器 — 可选字段
- \`enabled\` (布尔值，默认：true)
- \`mcp_connections\` (数组) — 关联的MCP服务器：
  \`\`\`json
  [{"connector_uuid": "UUID", "name": "服务器名称", "url": "https://..."}]
  \`\`\`

### 更新触发器 — 可选字段
所有字段均为可选（支持部分更新）：
- \`name\`、\`cron_expression\`、\`enabled\`、\`job_config\`
- \`mcp_connections\` — 替换MCP连接
- \`clear_mcp_connections\` (布尔值) — 移除所有MCP连接

### 定时表达式示例

用户本地时区为 **${userTimezone}**。定时表达式**始终使用UTC时间**。当用户提及本地时间时，需转换为UTC时间并向用户确认：“${userTimezone} 时间上午9点 = UTC时间X点，因此定时表达式为 \`0 X * * 1-5\`。”

- \`0 9 * * 1-5\` — 每周一至周五UTC时间上午9点
- \`0 */2 * * *\` — 每2小时
- \`0 0 * * *\` — 每日UTC时间零点
- \`30 14 * * 1\` — 每周一UTC时间下午2点30分
- \`0 8 1 * *\` — 每月1日UTC时间上午8点

最小间隔为1小时，\`*/30 * * * *\` 会被拒绝。

## 工作流程

### 创建新触发器：

1. **明确目标** — 询问用户远程代理的执行任务、所需仓库等。提醒用户代理运行在远程环境，**无法访问本地机器、文件或环境变量**。
2. **编写提示词** — 协助用户编写有效的代理提示词。优质提示词应具备：
   - 明确任务内容和成功标准
   - 清晰指定操作的文件/范围
   - 明确执行动作（创建PR、提交代码、仅分析等）
3. **设置定时计划** — 询问执行时间和频率。用户时区为 ${userTimezone}，当用户提及具体时间（如“每天上午9点”），默认按本地时间转换为UTC时间，并**务必向用户确认转换结果**：“${userTimezone} 时间上午9点 = UTC时间X点”。
4. **选择模型** — 默认使用 \`claude-sonnet-4-6\`。告知用户默认模型，并询问是否需要更换。
5. **验证连接** — 根据用户描述推断所需服务，与上方连接器列表核对。若缺少必需连接器，提醒用户并提供连接地址。${gitRepoUrl ? ` 默认Git仓库已设置为 \`${gitRepoUrl}\`，询问用户是否正确，或需要更换其他仓库。` : ' 询问远程代理需要克隆的Git仓库。'}
6. **核对确认** — 创建前展示完整配置，允许用户调整。
7. **执行创建** — 调用 \`${REMOTE_TRIGGER_TOOL_NAME}\` 并传入 \`action: "create"\`，展示执行结果。响应包含触发器ID，**务必在最后输出链接**：\`https://claude.ai/code/scheduled/{触发器ID}\`

### 更新触发器：

1. 先列出所有触发器供用户选择
2. 询问需要修改的内容
3. 展示当前值与修改后的值
4. 确认后执行更新

### 查看触发器列表：

1. 获取并以可读格式展示
2. 展示内容：名称、人性化定时计划、启用状态、下次运行时间、关联仓库

### 立即运行：

1. 若用户未指定触发器，先列出列表
2. 确认目标触发器
3. 执行并告知结果

## 重要说明

- 代理运行在**远程环境**（Anthropic云端），非用户本地机器，无法访问本地文件、服务或环境变量
- 展示定时计划时，始终转换为人性化可读格式
- 默认启用触发器（\`enabled: true\`），除非用户明确要求关闭
- 支持任意格式的GitHub地址（https://github.com/组织/仓库、组织/仓库等），统一转换为完整HTTPS地址（无.git后缀）
- 提示词是核心，务必确保准确。远程代理无上下文，提示词必须完整自包含
- 删除触发器请引导用户访问 https://claude.ai/code/scheduled
${needsGitHubAccessReminder ? `- 如果用户请求需要访问GitHub仓库（如克隆、创建PR、读取代码），提醒用户：${getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_lantern', false) ? "需执行 /web-setup 连接GitHub账号（或在仓库安装Claude GitHub应用作为备选），否则远程代理无法访问仓库" : "需在仓库安装Claude GitHub应用，否则远程代理无法访问仓库"}。` : ''}
${userArgs ? `\n## 用户请求\n\n用户指令："${userArgs}"\n\n请先理解用户意图，然后按照对应工作流程执行。` : ''}`
}

/**
 * 注册定时远程代理技能
 */
export function registerScheduleRemoteAgentsSkill(): void {
  registerBundledSkill({
    name: 'schedule',
    description:
      '创建、更新、查看或运行定时远程代理（触发器），支持按定时计划自动执行',
    whenToUse:
      '用户需要创建循环执行的远程代理、设置自动化任务、创建Claude代码定时任务，或管理定时代理/触发器时使用',
    userInvocable: true,
    isEnabled: () =>
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_surreal_dali', false) &&
      isPolicyAllowed('allow_remote_sessions'),
    allowedTools: [REMOTE_TRIGGER_TOOL_NAME, ASK_USER_QUESTION_TOOL_NAME],
    async getPromptForCommand(args: string, context: ToolUseContext) {
      // 校验用户认证状态
      if (!getClaudeAIOAuthTokens()?.accessToken) {
        return [
          {
            type: 'text',
            text: '请先使用claude.ai账号完成认证，API账号不支持该功能。执行 /login 登录后，重试 /schedule 命令。',
          },
        ]
      }

      let environments: EnvironmentResource[]
      try {
        environments = await fetchEnvironments()
      } catch (err) {
        logForDebugging(`[定时任务] 获取环境失败：${err}`, {
          level: 'warn',
        })
        return [
          {
            type: 'text',
            text: '无法连接远程claude.ai账号创建定时任务，请稍后重试 /schedule 命令。',
          },
        ]
      }

      // 无可用环境时自动创建默认环境
      let createdEnvironment: EnvironmentResource | null = null
      if (environments.length === 0) {
        try {
          createdEnvironment = await createDefaultCloudEnvironment(
            'claude-code-default',
          )
          environments = [createdEnvironment]
        } catch (err) {
          logForDebugging(`[定时任务] 创建环境失败：${err}`, {
            level: 'warn',
          })
          return [
            {
              type: 'text',
              text: '未找到远程环境，且无法自动创建。请访问 https://claude.ai/code 手动创建环境，然后重试 /schedule 命令。',
            },
          ]
        }
      }

      // 软校验设置项——收集为前置说明，嵌入初始用户提问对话框
      // 不阻塞流程：触发器并非必须依赖Git源（如仅Slack轮询），且触发器源可能指向非当前目录的仓库
      const setupNotes: string[] = []
      let needsGitHubAccessReminder = false

      const repo = await detectCurrentRepositoryWithHost()
      if (repo === null) {
        setupNotes.push(
          `当前不在Git仓库中——需手动指定仓库地址（也可完全不使用仓库）。`,
        )
      } else if (repo.host === 'github.com') {
        const { hasAccess } = await checkRepoForRemoteAccess(
          repo.owner,
          repo.name,
        )
        if (!hasAccess) {
          needsGitHubAccessReminder = true
          const webSetupEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
            'tengu_cobalt_lantern',
            false,
          )
          const msg = webSetupEnabled
            ? `未为 ${repo.owner}/${repo.name} 连接GitHub —— 执行 /web-setup 同步GitHub凭证，或访问 https://claude.ai/code/onboarding?magic=github-app-setup 安装Claude GitHub应用。`
            : `未在 ${repo.owner}/${repo.name} 安装Claude GitHub应用 —— 若触发器需要访问该仓库，请前往 https://claude.ai/code/onboarding?magic=github-app-setup 安装。`
          setupNotes.push(msg)
        }
      }
      // 非github.com平台（企业版GitHub/GitLab等）：静默跳过
      // GitHub应用校验仅针对github.com，且“非Git仓库”提示不适用——下方getCurrentRepoHttpsUrl()仍会获取企业版GitHub地址

      // 获取已连接的MCP连接器
      const connectors = getConnectedClaudeAIConnectors(
        context.options.mcpClients,
      )
      if (connectors.length === 0) {
        setupNotes.push(
          `无可用MCP连接器——如需使用，可访问 https://claude.ai/settings/connectors 进行连接。`,
        )
      }

      // 获取用户时区并格式化各类信息
      const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const connectorsInfo = formatConnectorsInfo(connectors)
      const gitRepoUrl = await getCurrentRepoHttpsUrl()
      const lines = ['可用环境：']
      for (const env of environments) {
        lines.push(
          `- ${env.name} (ID：${env.environment_id}，类型：${env.kind})`,
        )
      }
      const environmentsInfo = lines.join('\n')
      // 构建最终提示词
      const prompt = buildPrompt({
        userTimezone,
        connectorsInfo,
        gitRepoUrl,
        environmentsInfo,
        createdEnvironment,
        setupNotes,
        needsGitHubAccessReminder,
        userArgs: args,
      })
      return [{ type: 'text', text: prompt }]
    },
  })
}