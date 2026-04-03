import { DEFAULT_BINDINGS } from '../../keybindings/defaultBindings.js'
import { isKeybindingCustomizationEnabled } from '../../keybindings/loadUserBindings.js'
import {
  MACOS_RESERVED,
  NON_REBINDABLE,
  TERMINAL_RESERVED,
} from '../../keybindings/reservedShortcuts.js'
import type { KeybindingsSchemaType } from '../../keybindings/schema.js'
import {
  KEYBINDING_ACTIONS,
  KEYBINDING_CONTEXT_DESCRIPTIONS,
  KEYBINDING_CONTEXTS,
} from '../../keybindings/schema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { registerBundledSkill } from '../bundledSkills.js'

/**
 * 构建所有上下文的Markdown表格
 */
function generateContextsTable(): string {
  return markdownTable(
    ['上下文', '描述'],
    KEYBINDING_CONTEXTS.map(ctx => [
      `\`${ctx}\``,
      KEYBINDING_CONTEXT_DESCRIPTIONS[ctx],
    ]),
  )
}

/**
 * 构建所有操作及其默认绑定和上下文的Markdown表格
 */
function generateActionsTable(): string {
  // 构建查找表：操作 -> { 按键, 上下文 }
  const actionInfo: Record<string, { keys: string[]; context: string }> = {}
  for (const block of DEFAULT_BINDINGS) {
    for (const [key, action] of Object.entries(block.bindings)) {
      if (action) {
        if (!actionInfo[action]) {
          actionInfo[action] = { keys: [], context: block.context }
        }
        actionInfo[action].keys.push(key)
      }
    }
  }

  return markdownTable(
    ['操作', '默认按键', '上下文'],
    KEYBINDING_ACTIONS.map(action => {
      const info = actionInfo[action]
      const keys = info ? info.keys.map(k => `\`${k}\``).join(', ') : '(无)'
      const context = info ? info.context : inferContextFromAction(action)
      return [`\`${action}\``, keys, context]
    }),
  )
}

/**
 * 当操作不在默认绑定中时，根据操作前缀推断上下文
 */
function inferContextFromAction(action: string): string {
  const prefix = action.split(':')[0]
  const prefixToContext: Record<string, string> = {
    app: '全局',
    history: '全局或聊天',
    chat: '聊天',
    autocomplete: '自动补全',
    confirm: '确认',
    tabs: '标签页',
    transcript: '会话记录',
    historySearch: '历史记录搜索',
    task: '任务',
    theme: '主题选择器',
    help: '帮助',
    attachments: '附件',
    footer: '页脚',
    messageSelector: '消息选择器',
    diff: '差异对话框',
    modelPicker: '模型选择器',
    select: '选择',
    permission: '确认',
  }
  return prefixToContext[prefix ?? ''] ?? '未知'
}

/**
 * 生成保留快捷键列表
 */
function generateReservedShortcuts(): string {
  const lines: string[] = []

  lines.push('### 不可重新绑定（报错）')
  for (const s of NON_REBINDABLE) {
    lines.push(`- \`${s.key}\` — ${s.reason}`)
  }

  lines.push('')
  lines.push('### 终端保留（报错/警告）')
  for (const s of TERMINAL_RESERVED) {
    lines.push(
      `- \`${s.key}\` — ${s.reason} (${s.severity === 'error' ? '无法使用' : '可能冲突'})`,
    )
  }

  lines.push('')
  lines.push('### macOS系统保留（报错）')
  for (const s of MACOS_RESERVED) {
    lines.push(`- \`${s.key}\` — ${s.reason}`)
  }

  return lines.join('\n')
}

// 文件格式示例
const FILE_FORMAT_EXAMPLE: KeybindingsSchemaType = {
  $schema: 'https://www.schemastore.org/claude-code-keybindings.json',
  $docs: 'https://code.claude.com/docs/en/keybindings',
  bindings: [
    {
      context: 'Chat',
      bindings: {
        'ctrl+e': 'chat:externalEditor',
      },
    },
  ],
}

// 解绑示例
const UNBIND_EXAMPLE: KeybindingsSchemaType['bindings'][number] = {
  context: 'Chat',
  bindings: {
    'ctrl+s': null,
  },
}

// 重新绑定示例
const REBIND_EXAMPLE: KeybindingsSchemaType['bindings'][number] = {
  context: 'Chat',
  bindings: {
    'ctrl+g': null,
    'ctrl+e': 'chat:externalEditor',
  },
}

// 组合键绑定示例
const CHORD_EXAMPLE: KeybindingsSchemaType['bindings'][number] = {
  context: 'Global',
  bindings: {
    'ctrl+k ctrl+t': 'app:toggleTodos',
  },
}

// 章节介绍
const SECTION_INTRO = [
  '# 快捷键绑定功能',
  '',
  '创建或修改 `~/.claude/keybindings.json` 文件来自定义键盘快捷键。',
  '',
  '## 重要提示：修改前必读',
  '',
  '**务必先查看 `~/.claude/keybindings.json` 文件**（该文件可能尚未创建）。将新配置与现有绑定合并——切勿直接替换整个文件。',
  '',
  '- 使用**编辑**工具修改已有文件',
  '- 仅当文件不存在时，使用**写入**工具创建',
].join('\n')

// 文件格式章节
const SECTION_FILE_FORMAT = [
  '## 文件格式',
  '',
  '```json',
  jsonStringify(FILE_FORMAT_EXAMPLE, null, 2),
  '```',
  '',
  '必须包含 `$schema` 和 `$docs` 字段。',
].join('\n')

// 按键语法章节
const SECTION_KEYSTROKE_SYNTAX = [
  '## 按键语法',
  '',
  '**修饰键**（使用 `+` 组合）：',
  '- `ctrl`（别名：`control`）',
  '- `alt`（别名：`opt`、`option`）——注意：终端中 `alt` 和 `meta` 功能相同',
  '- `shift`',
  '- `meta`（别名：`cmd`、`command`）',
  '',
  '**特殊按键**：`escape`/`esc`、`enter`/`return`、`tab`、`space`、`backspace`、`delete`、`up`、`down`、`left`、`right`',
  '',
  '**组合键**：使用空格分隔的按键序列，例如 `ctrl+k ctrl+s`（按键间隔超时时间1秒）',
  '',
  '**示例**：`ctrl+shift+p`、`alt+enter`、`ctrl+k ctrl+n`',
].join('\n')

// 解绑默认快捷键章节
const SECTION_UNBINDING = [
  '## 解绑默认快捷键',
  '',
  '将按键设置为 `null` 即可移除其默认绑定：',
  '',
  '```json',
  jsonStringify(UNBIND_EXAMPLE, null, 2),
  '```',
].join('\n')

// 用户绑定与默认绑定交互规则章节
const SECTION_INTERACTION = [
  '## 用户绑定与默认绑定的交互规则',
  '',
  '- 用户绑定为**追加模式**——会在默认绑定之后加载',
  '- 要**修改**绑定按键：先解绑旧按键（设置为`null`），再添加新绑定',
  "- 仅当需要修改某上下文的绑定时，才需要在用户文件中添加该上下文",
].join('\n')

// 常用配置模式章节
const SECTION_COMMON_PATTERNS = [
  '## 常用配置模式',
  '',
  '### 重新绑定按键',
  '将外部编辑器快捷键从 `ctrl+g` 修改为 `ctrl+e`：',
  '```json',
  jsonStringify(REBIND_EXAMPLE, null, 2),
  '```',
  '',
  '### 添加组合键绑定',
  '```json',
  jsonStringify(CHORD_EXAMPLE, null, 2),
  '```',
].join('\n')

// 行为规则章节
const SECTION_BEHAVIORAL_RULES = [
  '## 行为规则',
  '',
  '1. 仅包含用户需要修改的上下文（最小化覆盖配置）',
  '2. 验证操作和上下文是否在下方的已知列表中',
  '3. 如果用户选择的按键与保留快捷键或tmux（`ctrl+b`）、screen（`ctrl+a`）等常用工具冲突，主动发出警告',
  '4. 为已有操作添加新绑定时，新绑定为追加模式（默认绑定仍有效，除非显式解绑）',
  '5. 要完全替换默认绑定，需先解绑旧按键，再添加新按键',
].join('\n')

// 校验工具章节
const SECTION_DOCTOR = [
  '## 使用 /doctor 命令校验',
  '',
  '`/doctor` 命令包含「快捷键配置问题」板块，用于校验 `~/.claude/keybindings.json` 文件。',
  '',
  '### 常见问题与解决方案',
  '',
  markdownTable(
    ['问题', '原因', '解决方案'],
    [
      [
        '`keybindings.json 必须包含 "bindings" 数组`',
        '缺少外层包装对象',
        '将绑定配置包裹在 `{ "bindings": [...] }` 中',
      ],
      [
        '`"bindings" 必须为数组类型`',
        '`bindings` 不是数组',
        '将 `"bindings"` 设置为数组：`[{ context: ..., bindings: ... }]`',
      ],
      [
        '`未知上下文 "X"`',
        '拼写错误或上下文名称无效',
        '使用「可用上下文」表格中的精确名称',
      ],
      [
        '`Y 绑定中存在重复按键 "X"`',
        '同一上下文中重复定义相同按键',
        '删除重复项；JSON 仅会读取最后一个值',
      ],
      [
        '`"X" 可能无法使用：...`',
        '按键与终端/系统保留快捷键冲突',
        '选择其他按键（参考保留快捷键章节）',
      ],
      [
        '`无法解析按键 "X"`',
        '按键语法无效',
        '检查语法：修饰键之间使用 `+` 连接，使用合法按键名称',
      ],
      [
        '`"X" 对应操作无效`',
        '操作值不是字符串或null',
        '操作必须为字符串（如 `"app:help"`）或 `null`（用于解绑）',
      ],
    ],
  ),
  '',
  '### /doctor 命令输出示例',
  '',
  '```',
  '快捷键配置问题',
  '文件位置：~/.claude/keybindings.json',
  '  └ [错误] 未知上下文 "chat"',
  '    → 有效上下文：Global, Chat, Autocomplete, ...',
  '  └ [警告] "ctrl+c" 可能无法使用：终端中断信号（SIGINT）',
  '```',
  '',
  '**错误**会导致绑定失效，必须修复。**警告**表示存在潜在冲突，但绑定可能仍可使用。',
].join('\n')

// 注册快捷键绑定功能
export function registerKeybindingsSkill(): void {
  registerBundledSkill({
    name: 'keybindings-help',
    description:
      '当用户需要自定义键盘快捷键、重新绑定按键、添加组合键绑定或修改 ~/.claude/keybindings.json 文件时使用。示例："重新绑定ctrl+s"、"添加组合快捷键"、"修改提交按键"、"自定义快捷键"。',
    allowedTools: ['Read'],
    userInvocable: false,
    isEnabled: isKeybindingCustomizationEnabled,
    async getPromptForCommand(args) {
      // 从数据源数组动态生成参考表格
      const contextsTable = generateContextsTable()
      const actionsTable = generateActionsTable()
      const reservedShortcuts = generateReservedShortcuts()

      const sections = [
        SECTION_INTRO,
        SECTION_FILE_FORMAT,
        SECTION_KEYSTROKE_SYNTAX,
        SECTION_UNBINDING,
        SECTION_INTERACTION,
        SECTION_COMMON_PATTERNS,
        SECTION_BEHAVIORAL_RULES,
        SECTION_DOCTOR,
        `## 保留快捷键\n\n${reservedShortcuts}`,
        `## 可用上下文\n\n${contextsTable}`,
        `## 可用操作\n\n${actionsTable}`,
      ]

      if (args) {
        sections.push(`## 用户请求\n\n${args}`)
      }

      return [{ type: 'text', text: sections.join('\n\n') }]
    },
  })
}

/**
 * 根据表头和行数据构建Markdown表格
 */
function markdownTable(headers: string[], rows: string[][]): string {
  const separator = headers.map(() => '---')
  return [
    `| ${headers.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n')
}