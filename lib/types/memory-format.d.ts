/**
 * 角色记忆的格式：固定栏目、解析、规范化输出。不依赖 node，浏览器端的编辑器也用它。
 * 模型的整理结果和用户的手动修改都先解析成栏目，再按固定顺序重新输出，
 * 同样的内容生成的文本逐字节相同，会话快照因此能共用前缀缓存。长度和每栏条数由程序检查。
 */
/** 栏目顺序固定。list 栏每条一行；paragraph 栏只有一段。 */
export declare const MEMORY_SECTIONS: readonly [{
    readonly key: "identity";
    readonly title: "称呼与身份";
    readonly kind: "list";
    readonly limit: 6;
}, {
    readonly key: "relation";
    readonly title: "关系";
    readonly kind: "paragraph";
    readonly limit: 1;
}, {
    readonly key: "preferences";
    readonly title: "偏好与禁忌";
    readonly kind: "list";
    readonly limit: 10;
}, {
    readonly key: "promises";
    readonly title: "约定与待办";
    readonly kind: "list";
    readonly limit: 5;
}, {
    readonly key: "events";
    readonly title: "重要经历";
    readonly kind: "list";
    readonly limit: 5;
}];
export type MemorySectionKey = typeof MEMORY_SECTIONS[number]['key'];
export type Memory = Readonly<Partial<Record<MemorySectionKey, readonly string[]>>>;
/** 渲染后的总长度上限（字符）。 */
export declare const MEMORY_LIMIT = 1500;
/** `qqbot:role-memory` 段落：没有记忆时为空，整段不出现。只由快照决定，所以会话内不变。 */
export declare function memoryRule(memory: string): string;
/** 解析出错的原因，可以直接展示给用户。 */
export declare class MemoryFormatError extends TypeError {
}
/**
 * 解析记忆文本。`## 栏目名` 开头，list 栏每行一条（可带 `- `），paragraph 栏多行合成一段。
 * lenient 用于模型输出：去掉代码围栏，忽略第一个栏目前的文字；用户输入时这些都算错误。
 */
export declare function parseMemory(text: string, lenient?: boolean): Memory;
/** 按固定栏目顺序输出；空记忆为空串。 */
export declare function renderMemory(memory: Memory): string;
/** 解析并检查长度，返回规范化的文本。超长时抛 MemoryFormatError。 */
export declare function normalizeMemory(text: string, lenient?: boolean): string;
