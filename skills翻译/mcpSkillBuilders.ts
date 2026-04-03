import type {
  createSkillCommand,
  parseSkillFrontmatterFields,
} from './loadSkillsDir.js'

/**
 * 为MCP技能发现所需的两个loadSkillsDir函数提供一次性写入的注册器。
 * 此模块是依赖图的叶子节点：它仅导入类型，因此mcpSkills.ts和loadSkillsDir.ts均可依赖它
 * 而不会形成循环依赖（client.ts → mcpSkills.ts → loadSkillsDir.ts → … → client.ts）。
 *
 * 非字面量的动态导入方式（"await import(变量)"）在Bun打包的二进制文件中运行时会失效——
 * 导入路径会基于代码块的/$bunfs/root/…路径解析，而非原始源码目录，最终抛出"找不到模块'./loadSkillsDir.js'"错误。
 * 字面量动态导入在bunfs环境中可正常工作，但依赖分析工具会追踪该导入；
 * 由于loadSkillsDir会间接依赖几乎所有模块，新增的这一条依赖边会在差异检查中引发大量新的循环依赖违规。
 *
 * 注册操作在loadSkillsDir.ts模块初始化时执行，该模块会在程序启动时通过commands.ts的静态导入立即加载执行，
 * 远早于任何MCP服务端建立连接。
 */

export type MCPSkillBuilders = {
  createSkillCommand: typeof createSkillCommand
  parseSkillFrontmatterFields: typeof parseSkillFrontmatterFields
}

let builders: MCPSkillBuilders | null = null

export function registerMCPSkillBuilders(b: MCPSkillBuilders): void {
  builders = b
}

export function getMCPSkillBuilders(): MCPSkillBuilders {
  if (!builders) {
    throw new Error(
      'MCP技能构建器未注册——loadSkillsDir.ts尚未加载执行',
    )
  }
  return builders
}