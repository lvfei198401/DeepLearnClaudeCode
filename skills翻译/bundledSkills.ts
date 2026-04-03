import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { constants as fsConstants } from 'fs'
import { mkdir, open } from 'fs/promises'
import { dirname, isAbsolute, join, normalize, sep as pathSep } from 'path'
import type { ToolUseContext } from '../Tool.js'
import type { Command } from '../types/command.js'
import { logForDebugging } from '../utils/debug.js'
import { getBundledSkillsRoot } from '../utils/permissions/filesystem.js'
import type { HooksSettings } from '../utils/settings/types.js'

/**
 * 随命令行工具一同发布的内置技能定义
 * 这些技能会在启动时通过代码方式注册
 */
export type BundledSkillDefinition = {
  name: string
  description: string
  aliases?: string[]
  whenToUse?: string
  argumentHint?: string
  allowedTools?: string[]
  model?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  isEnabled?: () => boolean
  hooks?: HooksSettings
  context?: 'inline' | 'fork'
  agent?: string
  /**
   * 首次调用时需要解压到磁盘的额外参考文件
   * 键为相对路径（使用正斜杠，不包含`..`），值为文件内容
   * 设置该属性后，技能提示词会自动添加一行"本技能的基础目录：<目录路径>"
   * 模型可按需读取/检索这些文件 —— 与基于磁盘的技能遵循相同规则
   */
  files?: Record<string, string>
  getPromptForCommand: (
    args: string,
    context: ToolUseContext,
  ) => Promise<ContentBlockParam[]>
}

// 内置技能的内部注册容器
const bundledSkills: Command[] = []

/**
 * 注册一个可供模型使用的内置技能
 * 在模块初始化或初始化函数中调用此方法
 *
 * 内置技能会编译到命令行工具二进制文件中，所有用户均可使用
 * 内部功能的注册逻辑与registerPostSamplingHook()保持一致
 */
export function registerBundledSkill(definition: BundledSkillDefinition): void {
  const { files } = definition

  let skillRoot: string | undefined
  let getPromptForCommand = definition.getPromptForCommand

  if (files && Object.keys(files).length > 0) {
    skillRoot = getBundledSkillExtractDir(definition.name)
    // 闭包内缓存：每个进程仅解压一次
    // 缓存Promise（而非结果），避免并发调用时产生竞争写入
    let extractionPromise: Promise<string | null> | undefined
    const inner = definition.getPromptForCommand
    getPromptForCommand = async (args, ctx) => {
      extractionPromise ??= extractBundledSkillFiles(definition.name, files)
      const extractedDir = await extractionPromise
      const blocks = await inner(args, ctx)
      if (extractedDir === null) return blocks
      return prependBaseDir(blocks, extractedDir)
    }
  }

  const command: Command = {
    type: 'prompt',
    name: definition.name,
    description: definition.description,
    aliases: definition.aliases,
    hasUserSpecifiedDescription: true,
    allowedTools: definition.allowedTools ?? [],
    argumentHint: definition.argumentHint,
    whenToUse: definition.whenToUse,
    model: definition.model,
    disableModelInvocation: definition.disableModelInvocation ?? false,
    userInvocable: definition.userInvocable ?? true,
    contentLength: 0, // 内置技能不适用该属性
    source: 'bundled',
    loadedFrom: 'bundled',
    hooks: definition.hooks,
    skillRoot,
    context: definition.context,
    agent: definition.agent,
    isEnabled: definition.isEnabled,
    isHidden: !(definition.userInvocable ?? true),
    progressMessage: 'running',
    getPromptForCommand,
  }
  bundledSkills.push(command)
}

/**
 * 获取所有已注册的内置技能
 * 返回副本以防止外部修改原数据
 */
export function getBundledSkills(): Command[] {
  return [...bundledSkills]
}

/**
 * 清空内置技能注册容器（用于测试）
 */
export function clearBundledSkills(): void {
  bundledSkills.length = 0
}

/**
 * 生成内置技能参考文件的固定解压目录
 */
export function getBundledSkillExtractDir(skillName: string): string {
  return join(getBundledSkillsRoot(), skillName)
}

/**
 * 将内置技能的参考文件解压到磁盘，供模型按需读取/检索
 * 在技能首次调用时延迟执行
 *
 * 返回写入成功的目录路径，写入失败则返回null（技能仍可正常使用，仅缺少基础目录前缀）
 */
async function extractBundledSkillFiles(
  skillName: string,
  files: Record<string, string>,
): Promise<string | null> {
  const dir = getBundledSkillExtractDir(skillName)
  try {
    await writeSkillFiles(dir, files)
    return dir
  } catch (e) {
    logForDebugging(
      `内置技能'${skillName}'解压到${dir}失败：${e instanceof Error ? e.message : String(e)}`,
    )
    return null
  }
}

async function writeSkillFiles(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  // 按父目录分组，确保每个子目录仅创建一次，再执行写入
  const byParent = new Map<string, [string, string][]>()
  for (const [relPath, content] of Object.entries(files)) {
    const target = resolveSkillFilePath(dir, relPath)
    const parent = dirname(target)
    const entry: [string, string] = [target, content]
    const group = byParent.get(parent)
    if (group) group.push(entry)
    else byParent.set(parent, [entry])
  }
  await Promise.all(
    [...byParent].map(async ([parent, entries]) => {
      await mkdir(parent, { recursive: true, mode: 0o700 })
      await Promise.all(entries.map(([p, c]) => safeWriteFile(p, c)))
    }),
  )
}

// getBundledSkillsRoot()中的进程唯一随机值是防范预创建符号链接/目录的核心防护手段
// 显式设置0o700/0o600权限可确保即使umask=0时，随机值子目录也仅属主可访问
// 即便攻击者通过父目录监听获取随机值，也无法写入目录
// O_NOFOLLOW|O_EXCL是双重防护（O_NOFOLLOW仅保护最后一级路径）
// 刻意不处理EEXIST错误后执行删除重试 —— unlink()同样会跟随中间符号链接
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
// Windows系统使用字符串标识，数字类型的O_EXCL会通过libuv触发EINVAL错误
const SAFE_WRITE_FLAGS =
  process.platform === 'win32'
    ? 'wx'
    : fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      O_NOFOLLOW

async function safeWriteFile(p: string, content: string): Promise<void> {
  const fh = await open(p, SAFE_WRITE_FLAGS, 0o600)
  try {
    await fh.writeFile(content, 'utf8')
  } finally {
    await fh.close()
  }
}

/** 标准化并校验技能相对路径；路径越界时抛出异常 */
function resolveSkillFilePath(baseDir: string, relPath: string): string {
  const normalized = normalize(relPath)
  if (
    isAbsolute(normalized) ||
    normalized.split(pathSep).includes('..') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`内置技能文件路径超出技能目录范围：${relPath}`)
  }
  return join(baseDir, normalized)
}

function prependBaseDir(
  blocks: ContentBlockParam[],
  baseDir: string,
): ContentBlockParam[] {
  const prefix = `本技能的基础目录：${baseDir}\n\n`
  if (blocks.length > 0 && blocks[0]!.type === 'text') {
    return [
      { type: 'text', text: prefix + blocks[0]!.text },
      ...blocks.slice(1),
    ]
  }
  return [{ type: 'text', text: prefix }, ...blocks]
}