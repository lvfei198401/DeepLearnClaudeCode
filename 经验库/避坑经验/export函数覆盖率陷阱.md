---
现象: 设计文档 4.1 节仅覆盖 ~30/110+ 导出函数，遗漏率 >70%，尤其是工具函数文件（utils.ts 22 个函数全部遗漏）
根因: 生成 skill 倾向于只描述"核心"函数而忽略辅助/工具函数，但对于反向工程文档，所有 export 都是公共 API 的一部分
方法论: |
  1. 用 Grep 提取所有 `export function`、`export const ... = (async)?` 和 `export class` 的完整清单
  2. 将清单按文件分组，与文档 4.1 节逐一比对
  3. 特别关注：memoized 常量（`export const x = memoize(...)`）容易被当作普通变量忽略；re-export 需追溯原始定义
  4. utils.ts 类工具文件通常有大量小函数，是遗漏重灾区
案例: MCP 模块 utils.ts 的 22 个导出函数、xaaIdpLogin.ts 的 11 个函数、以及 10+ 个辅助文件的函数全部未被文档覆盖
标签: TypeScript/设计文档/函数覆盖/completeness
成熟度: 试探
验证记录:
---
