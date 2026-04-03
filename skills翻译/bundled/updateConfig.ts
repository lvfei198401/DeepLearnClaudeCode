import { toJSONSchema } from 'zod/v4'
import { SettingsSchema } from '../../utils/settings/types.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { registerBundledSkill } from '../bundledSkills.js'

/**
 * 从设置的 Zod 模式生成 JSON 模式。
 * 这能让技能提示与实际类型保持同步。
 */
function generateSettingsSchema(): string {
  const jsonSchema = toJSONSchema(SettingsSchema(), { io: 'input' })
  return jsonStringify(jsonSchema, null, 2)
}

const SETTINGS_EXAMPLES_DOCS = `## 设置文件位置

根据作用范围选择合适的文件：

| 文件 | 作用范围 | Git 状态 | 用途 |
|------|----------|----------|------|
| \`~/.claude/settings.json\` | 全局 | 无 | 所有项目的个人偏好设置 |
| \`.claude/settings.json\` | 项目 | 提交 | 团队共用的钩子、权限、插件 |
| \`.claude/settings.local.json\` | 项目 | 忽略 | 本项目的个人覆盖配置 |

设置加载顺序：用户 → 项目 → 本地（后加载的配置会覆盖先加载的）。

## 设置模式参考

### 权限配置
\`\`\`json
{
  "permissions": {
    "allow": ["Bash(npm:*)", "Edit(.claude)", "Read"],
    "deny": ["Bash(rm -rf:*)"],
    "ask": ["Write(/etc/*)"],
    "defaultMode": "default" | "plan" | "acceptEdits" | "dontAsk",
    "additionalDirectories": ["/extra/dir"]
  }
}
\`\`\`

**权限规则语法：**
- 精确匹配：\`"Bash(npm run test)"\`
- 前缀通配符：\`"Bash(git:*)"\` - 匹配 \`git status\`、\`git commit\` 等
- 仅工具类型：\`"Read"\` - 允许所有读取操作

### 环境变量
\`\`\`json
{
  "env": {
    "DEBUG": "true",
    "MY_API_KEY": "value"
  }
}
\`\`\`

### 模型与智能体
\`\`\`json
{
  "model": "sonnet",  // 或 "opus"、"haiku"、完整模型ID
  "agent": "agent-name",
  "alwaysThinkingEnabled": true
}
\`\`\`

### 署名信息（提交与拉取请求）
\`\`\`json
{
  "attribution": {
    "commit": "自定义提交附加文本",
    "pr": "自定义拉取请求描述文本"
  }
}
\`\`\`
将 \`commit\` 或 \`pr\` 设置为空字符串 \`""\` 可隐藏对应署名。

### MCP 服务管理
\`\`\`json
{
  "enableAllProjectMcpServers": true,
  "enabledMcpjsonServers": ["server1", "server2"],
  "disabledMcpjsonServers": ["blocked-server"]
}
\`\`\`

### 插件
\`\`\`json
{
  "enabledPlugins": {
    "formatter@anthropic-tools": true
  }
}
\`\`\`
插件语法：\`插件名@来源\`，来源可为 \`claude-code-marketplace\`、\`claude-plugins-official\` 或 \`builtin\`。

### 其他设置
- \`language\`：首选响应语言（例如："japanese"）
- \`cleanupPeriodDays\`：记录保留天数（默认：30；0 表示完全禁用持久化）
- \`respectGitignore\`：是否遵循 .gitignore 规则（默认：true）
- \`spinnerTipsEnabled\`：在加载指示器中显示提示
- \`spinnerVerbs\`：自定义加载指示器动词（\`{ "mode": "append" | "replace", "verbs": [...] }\`）
- \`spinnerTipsOverride\`：覆盖加载指示器提示（\`{ "excludeDefault": true, "tips": ["自定义提示"] }\`）
- \`syntaxHighlightingDisabled\`：禁用差异高亮显示
`

// 注意：我们保留手动编写的常用模式示例，因为它们比自动生成的模式文档更具实用性。
// 自动生成的模式列表保证了完整性，而示例则提供了清晰性。

const HOOKS_DOCS = `## 钩子配置

钩子会在 Claude Code 生命周期的特定节点执行命令。

### 钩子结构
\`\`\`json
{
  "hooks": {
    "事件名称": [
      {
        "匹配器": "工具名|其他工具",
        "钩子": [
          {
            "类型": "命令",
            "命令": "你的命令",
            "超时时间": 60,
            "状态消息": "执行中..."
          }
        ]
      }
    ]
  }
}
\`\`\`

### 钩子事件

| 事件 | 匹配器 | 用途 |
|------|--------|------|
| PermissionRequest | 工具名称 | 权限提示前执行 |
| PreToolUse | 工具名称 | 工具执行前执行，可阻止操作 |
| PostToolUse | 工具名称 | 工具执行成功后执行 |
| PostToolUseFailure | 工具名称 | 工具执行失败后执行 |
| Notification | 通知类型 | 收到通知时执行 |
| Stop | - | Claude 停止时执行（包括清空、恢复、压缩） |
| PreCompact | "manual"/"auto" | 压缩前执行 |
| PostCompact | "manual"/"auto" | 压缩后执行（接收摘要） |
| UserPromptSubmit | - | 用户提交提示时执行 |
| SessionStart | - | 会话启动时执行 |

**常用工具匹配器：** \`Bash\`、\`Write\`、\`Edit\`、\`Read\`、\`Glob\`、\`Grep\`

### 钩子类型

**1. 命令钩子** - 执行 shell 命令：
\`\`\`json
{ "type": "command", "command": "prettier --write $FILE", "timeout": 30 }
\`\`\`

**2. 提示钩子** - 通过大语言模型评估条件：
\`\`\`json
{ "type": "prompt", "prompt": "是否安全？$ARGUMENTS" }
\`\`\`
仅适用于工具事件：PreToolUse、PostToolUse、PermissionRequest。

**3. 智能体钩子** - 运行带工具的智能体：
\`\`\`json
{ "type": "agent", "prompt": "验证测试通过：$ARGUMENTS" }
\`\`\`
仅适用于工具事件：PreToolUse、PostToolUse、PermissionRequest。

### 钩子输入（标准输入 JSON）
\`\`\`json
{
  "session_id": "abc123",
  "tool_name": "Write",
  "tool_input": { "file_path": "/path/to/file.txt", "content": "..." },
  "tool_response": { "success": true }  // 仅 PostToolUse 事件存在
}
\`\`\`

### 钩子 JSON 输出

钩子可返回 JSON 控制行为：

\`\`\`json
{
  "systemMessage": "在界面向用户显示的警告信息",
  "continue": false,
  "stopReason": "阻止操作时显示的信息",
  "suppressOutput": false,
  "decision": "block",
  "reason": "决策说明",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "回注到模型的上下文信息"
  }
}
\`\`\`

**字段说明：**
- \`systemMessage\` - 向用户显示消息（所有钩子通用）
- \`continue\` - 设置为 \`false\` 可阻止/停止操作（默认：true）
- \`stopReason\` - \`continue\` 为 false 时显示的消息
- \`suppressOutput\` - 隐藏记录中的标准输出（默认：false）
- \`decision\` - "block" 用于 PostToolUse/Stop/UserPromptSubmit 钩子（PreToolUse 已废弃，改用 hookSpecificOutput.permissionDecision）
- \`reason\` - 决策说明
- \`hookSpecificOutput\` - 事件专属输出（必须包含 \`hookEventName\`）：
  - \`additionalContext\` - 注入模型上下文的文本
  - \`permissionDecision\` - "allow"、"deny" 或 "ask"（仅 PreToolUse）
  - \`permissionDecisionReason\` - 权限决策原因（仅 PreToolUse）
  - \`updatedInput\` - 修改后的工具输入（仅 PreToolUse）

### 常用模式

**写入后自动格式化：**
\`\`\`json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "jq -r '.tool_response.filePath // .tool_input.file_path' | { read -r f; prettier --write \\"$f\\"; } 2>/dev/null || true"
      }]
    }]
  }
}
\`\`\`

**记录所有 Bash 命令：**
\`\`\`json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "jq -r '.tool_input.command' >> ~/.claude/bash-log.txt"
      }]
    }]
  }
}
\`\`\`

**向用户显示消息的停止钩子：**

命令必须输出包含 \`systemMessage\` 字段的 JSON：
\`\`\`bash
# 输出示例：{"systemMessage": "会话完成！"}
echo '{"systemMessage": "会话完成！"}'
\`\`\`

**代码修改后运行测试：**
\`\`\`json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "jq -r '.tool_input.file_path // .tool_response.filePath' | grep -E '\\\\.(ts|js)$' && npm test || true"
      }]
    }]
  }
}
\`\`\`
`

const HOOK_VERIFICATION_FLOW = `## 构建钩子（含验证）

根据事件、匹配器、目标文件和预期行为，遵循以下流程。每一步都会捕获不同类型的故障——静默失效的钩子比没有钩子更糟糕。

1. **去重检查。** 读取目标文件。如果同一事件+匹配器已存在钩子，显示现有命令并询问：保留、替换或追加。

2. **为本项目构建命令——切勿假设。** 钩子通过标准输入接收 JSON。构建的命令需满足：
   - 安全提取所需数据——使用 \`jq -r\` 赋值给带引号的变量，或 \`{ read -r f; ... "$f"; }\`，**不要**使用无引号的 \`| xargs\`（会按空格分割）
   - 以本项目的方式调用底层工具（npx/bunx/yarn/pnpm？Makefile 目标？全局安装？）
   - 跳过工具不处理的输入（格式化工具通常有 \`--ignore-unknown\`；若无，按文件后缀过滤）
   - 暂时保持原始命令——不添加 \`|| true\`，不屏蔽标准错误。管道测试通过后再封装。

3. **原始命令管道测试。** 构造钩子将接收的标准输入数据并直接管道传递：
   - \`Pre|PostToolUse\` 作用于 \`Write|Edit\`：\`echo '{"tool_name":"Edit","tool_input":{"file_path":"<仓库中的真实文件>"}}' | <命令>\`
   - \`Pre|PostToolUse\` 作用于 \`Bash\`：\`echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | <命令>\`
   - \`Stop\`/\`UserPromptSubmit\`/\`SessionStart\`：多数命令不读取标准输入，\`echo '{}' | <命令>\` 即可

   检查退出码**和**实际效果（文件是否格式化、测试是否运行）。失败会显示真实错误——修复（包管理器错误？工具未安装？jq 路径错误？）后重新测试。正常工作后，封装为 \`2>/dev/null || true\`（除非用户需要阻塞检查）。

4. **写入 JSON。** 合并到目标文件（模式结构见上方「钩子结构」部分）。如果首次创建 \`.claude/settings.local.json\`，将其添加到 .gitignore——写入工具不会自动忽略。

5. **一次性验证语法+模式：**

   \`jq -e '.hooks.<事件>[] | select(.matcher == "<匹配器>") | .hooks[] | select(.type == "command") | .command' <目标文件>\`

   退出码 0 + 打印命令 = 正确。退出码 4 = 匹配器不匹配。退出码 5 = JSON 格式错误或嵌套错误。损坏的 settings.json 会静默禁用该文件的**所有**设置——同时修复所有已存在的格式错误。

6. **验证钩子触发**——仅针对可依次触发的匹配器（\`Write|Edit\` 通过编辑、\`Bash\` 通过终端）的 \`Pre|PostToolUse\`。\`Stop\`/\`UserPromptSubmit\`/\`SessionStart\` 在本轮外触发——跳过至步骤 7。

   **格式化工具**作用于 \`PostToolUse\`/\`Write|Edit\`：通过编辑引入可检测的问题（连续空行、缩进错误、缺少分号——格式化工具能修复的问题；**不要**用尾部空格，编辑工具写入前会自动清除），重新读取，确认钩子**已修复**。**其他场景**：临时在 settings.json 的命令前添加 \`echo "$(date) 钩子触发" >> /tmp/claude-hook-check.txt; \`，触发匹配工具（\`Write|Edit\` 用编辑，\`Bash\` 用无害的 \`true\`），读取标记文件。

   **必须清理**——还原问题、删除标记前缀——无论验证是否通过。

   **如果管道测试和 \`jq -e\` 都通过，但验证失败**：设置监听器未监听 \`.claude/\`——它仅监听会话启动时已有设置文件的目录。钩子编写正确。告知用户打开一次 \`/hooks\`（重新加载配置）或重启——你无法自动操作；\`/hooks\` 是用户界面菜单，打开会结束本轮操作。

7. **交付。** 告知用户钩子已生效（或因监听器限制需 \`/hooks\`/重启）。指引他们到 \`/hooks\` 后续查看、编辑或禁用。仅当钩子出错或缓慢时，界面才会显示「已运行 N 个钩子」——设计上静默成功不可见。
`

const UPDATE_CONFIG_PROMPT = `# 更新配置技能

通过更新 settings.json 文件修改 Claude Code 配置。

## 何时需要钩子（而非记忆）

如果用户希望某事件**自动触发**操作，需要在 settings.json 中配置**钩子**。记忆/偏好无法触发自动化行为。

**以下场景需要钩子：**
- "压缩前询问保留内容" → PreCompact 钩子
- "写入文件后运行 prettier" → 匹配 Write|Edit 的 PostToolUse 钩子
- "运行终端命令时记录日志" → 匹配 Bash 的 PreToolUse 钩子
- "代码修改后始终运行测试" → PostToolUse 钩子

**钩子事件：** PreToolUse、PostToolUse、PreCompact、PostCompact、Stop、Notification、SessionStart

## 重要：先读后写

**修改前必须读取现有设置文件。** 新设置与现有设置合并——切勿替换整个文件。

## 重要：歧义时使用用户询问

用户请求不明确时，使用 AskUserQuestion 澄清：
- 修改哪个设置文件（用户/项目/本地）
- 追加还是替换现有数组
- 多选项时的具体值

## 决策：配置工具 vs 直接编辑

**使用配置工具**处理以下简单设置：
- \`theme\`、\`editorMode\`、\`verbose\`、\`model\`
- \`language\`、\`alwaysThinkingEnabled\`
- \`permissions.defaultMode\`

**直接编辑 settings.json** 处理：
- 钩子（PreToolUse、PostToolUse 等）
- 复杂权限规则（允许/拒绝数组）
- 环境变量
- MCP 服务配置
- 插件配置

## 工作流程

1. **明确意图** - 请求不明确时询问
2. **读取现有文件** - 使用读取工具读取目标设置文件
3. **谨慎合并** - 保留现有设置，尤其是数组
4. **编辑文件** - 使用编辑工具（文件不存在时，先询问用户创建）
5. **确认** - 告知用户修改内容

## 数组合并（重要！）

添加到权限数组或钩子数组时，**与现有合并**，不要替换：

**错误**（替换现有权限）：
\`\`\`json
{ "permissions": { "allow": ["Bash(npm:*)"] } }
\`\`\`

**正确**（保留现有+新增）：
\`\`\`json
{
  "permissions": {
    "allow": [
      "Bash(git:*)",      // 现有
      "Edit(.claude)",    // 现有
      "Bash(npm:*)"       // 新增
    ]
  }
}
\`\`\`

${SETTINGS_EXAMPLES_DOCS}

${HOOKS_DOCS}

${HOOK_VERIFICATION_FLOW}

## 示例工作流

### 添加钩子

用户："Claude 写入代码后自动格式化"

1. **明确**：使用哪个格式化工具？（prettier、gofmt 等）
2. **读取**：\`.claude/settings.json\`（不存在则创建）
3. **合并**：追加到现有钩子，不替换
4. **结果**：
\`\`\`json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "jq -r '.tool_response.filePath // .tool_input.file_path' | { read -r f; prettier --write \\"$f\\"; } 2>/dev/null || true"
      }]
    }]
  }
}
\`\`\`

### 添加权限

用户："允许 npm 命令无需提示"

1. **读取**：现有权限
2. **合并**：将 \`Bash(npm:*)\` 添加到允许数组
3. **结果**：与现有允许项合并

### 环境变量

用户："设置 DEBUG=true"

1. **决策**：用户设置（全局）还是项目设置？
2. **读取**：目标文件
3. **合并**：添加到 env 对象
\`\`\`json
{ "env": { "DEBUG": "true" } }
\`\`\`

## 常见错误避免

1. **替换而非合并** - 始终保留现有设置
2. **文件错误** - 作用范围不明确时询问用户
3. **JSON 无效** - 修改后验证语法
4. **忘记先读取** - 始终先读后写

## 钩子故障排除

钩子未运行时：
1. **检查设置文件** - 读取 ~/.claude/settings.json 或 .claude/settings.json
2. **验证 JSON 语法** - 无效 JSON 会静默失败
3. **检查匹配器** - 是否匹配工具名称？（例如："Bash"、"Write"、"Edit"）
4. **检查钩子类型** - 是 "command"、"prompt" 还是 "agent"？
5. **测试命令** - 手动运行钩子命令验证
6. **使用 --debug** - 运行 \`claude --debug\` 查看钩子执行日志
`

export function registerUpdateConfigSkill(): void {
  registerBundledSkill({
    name: 'update-config',
    description:
      '使用此技能通过 settings.json 配置 Claude Code 框架。自动化行为（"今后当X时"、"每次X时"、"每当X时"、"X之前/之后"）需要在 settings.json 中配置钩子——框架执行这些操作，而非 Claude，因此记忆/偏好无法实现。也可用于：权限（"允许X"、"添加权限"、"移动权限到"）、环境变量（"设置X=Y"）、钩子故障排除，或修改 settings.json/settings.local.json 文件。示例："允许 npm 命令"、"向全局设置添加 bq 权限"、"将权限移动到用户设置"、"设置 DEBUG=true"、"Claude 停止时显示X"。简单设置如主题/模型，使用配置工具。',
    allowedTools: ['Read'],
    userInvocable: true,
    async getPromptForCommand(args) {
      if (args.startsWith('[hooks-only]')) {
        const req = args.slice('[hooks-only]'.length).trim()
        let prompt = HOOKS_DOCS + '\n\n' + HOOK_VERIFICATION_FLOW
        if (req) {
          prompt += `\n\n## 任务\n\n${req}`
        }
        return [{ type: 'text', text: prompt }]
      }

      // 动态生成模式以保持与类型同步
      const jsonSchema = generateSettingsSchema()

      let prompt = UPDATE_CONFIG_PROMPT
      prompt += `\n\n## 完整设置 JSON 模式\n\n\`\`\`json\n${jsonSchema}\`\`\``

      if (args) {
        prompt += `\n\n## 用户请求\n\n${args}`
      }

      return [{ type: 'text', text: prompt }]
    },
  })
}