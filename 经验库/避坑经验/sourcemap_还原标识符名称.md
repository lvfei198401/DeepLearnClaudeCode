---
现象: 设计文档使用简短类名（如 `McpToolCallError`），但 sourcemap 还原的源码中类名包含长后缀（如 `McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`）
根因: Anthropic 代码中使用长标识符名称作为遥测安全标记，sourcemap 还原保留了完整名称，但运行时 `.name` 属性被设置为短名称
方法论: 审查 Dimension 6（代码引用准确性）时，必须用 Grep 在源码中搜索文档引用的每个标识符，不能假设短名称就是完整导出名。对于 `_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` 后缀的类，需在文档中使用完整名称并注明运行时 `.name`
案例: `McpToolCallError` → 实际为 `McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`（client.ts:177），`TelemetrySafeError` 同理
标签: TypeScript/设计文档/代码引用/sourcemap还原
成熟度: 试探
验证记录:
---
