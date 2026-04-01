---
tags: [Mermaid, 设计文档, TypeScript]
成熟度: 验证
---

# Mermaid classDiagram 中 TypeScript 类型语法的兼容问题

## 现象

在 classDiagram 中直接使用 TypeScript 风格的类型注解（如 `onclose?: () => void`、`Promise<void>`）导致 Mermaid 渲染失败。

## 根因

Mermaid classDiagram 有自己的语法规则：
- 不支持 `?` 可选标记
- `<>` 被解析为 HTML 标签，需使用 `~` 替代（如 `Promise~void~`）
- `=>` 箭头函数语法会与 Mermaid 箭头冲突
- 中文冒号在注释中可能导致解析歧义
- **类定义体内不支持 `//` 注释语法**，注释行会被解析为属性/方法声明导致渲染失败

## 方法论

1. 属性/方法声明使用 `+`/`-`/`#` 可见性前缀，不使用 `?`
2. 泛型使用 `~` 包裹：`Promise~void~`
3. 回调类型简化为 `callback` 而非写出完整签名
4. 私有成员用 `-` 前缀声明具体字段，而非注释
5. 需要在类中添加说明性文字时，使用 `<<annotation>>` 语法而非 `//` 注释

## 案例

错误写法：
```
onclose?: () => void
+tokens(): Promise<OAuthTokens>
// 内部状态: peer 引用
```

正确写法：
```
+onclose callback
+tokens() Promise~OAuthTokens~
-peer InProcessTransport
```

错误写法（类内注释）：
```
class MyClass {
    <<stereotype>>
    // 这是注释会导致渲染失败
}
```

正确写法（用 annotation 替代注释）：
```
class MyClass {
    <<stereotype: 说明文字>>
}
```
