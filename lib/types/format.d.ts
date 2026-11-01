/**
 * 格式规则：分段、表情和语音。语音说明固定，可用状态通过 runtime 提供。
 */
import { type MemeFrequency } from './library-types.ts';
import type { MemePreferences } from './library-types.ts';
/** 分段规则：[qq] 块的格式由 dialogue-timing 协议定义，解析和显示在 dsh-qqbot 的浏览器端。 */
export declare const SEGMENT_RULE: string;
/** 合成和播放仍由界面负责；让模型知道如何回应用户的语音请求。 */
export declare const VOICE_RULE = "\u8BED\u97F3\uFF1A\u53EF\u7528\u72B6\u6001\u89C1\u8FD0\u884C\u65F6 voice \u884C\u3002\u9ED8\u8BA4\u53D1\u6587\u5B57\uFF1B\u8BED\u97F3\u53EF\u7528\u4E14\u7528\u6237\u8981\u6C42\u8BED\u97F3\u65F6\uFF0C\u81F3\u5C11\u4E00\u4E2A\u6BB5\u843D\u52A0 \"voice\":true\u3002\u6309\u4EBA\u8BBE\u548C\u8BED\u5883\u5076\u5C14\u9002\u5408\u7528\u58F0\u97F3\u65F6\uFF0C\u4E5F\u53EF\u9009\u7528\u8BED\u97F3\u3002\u8BED\u97F3\u6BB5\u5728 [qq] \u4E2D\u5148\u5199 \"voice\":true\uFF0C\u518D\u5199 text\uFF0Ctext \u5199\u8981\u8BF4\u7684\u8BDD\uFF0C\u4E0D\u7528\u8C03\u5DE5\u5177\u3002\u4E00\u6761\u56DE\u590D\u53EF\u4EE5\u6587\u5B57\u548C\u8BED\u97F3\u6DF7\u53D1\uFF0C\u53EA\u6709\u4E00\u53E5\u8BED\u97F3\u4E5F\u7528 [qq] \u5757\u3002\u4F8B\u5982\uFF1A\n[qq]{\"version\":1,\"stages\":[{\"text\":\"\u6211\u5728\u5462\u3002\"},{\"voice\":true,\"text\":\"\u665A\u5B89\uFF0C\u505A\u4E2A\u597D\u68A6\u3002\"}]}[/qq]\n\u8FD0\u884C\u65F6\u4E3A\u201C\u5168\u90E8\u8F6C\u8BED\u97F3\u201D\u65F6\u754C\u9762\u81EA\u52A8\u8F6C\u6362\uFF0C\u4E0D\u7528\u9010\u6BB5\u6807\u8BB0\u3002\u672A\u542F\u7528\u6216\u6CA1\u6709\u97F3\u8272\u65F6\u53D1\u6587\u5B57\uFF0C\u6309\u72B6\u6001\u63D0\u793A\u7528\u6237\u5F00\u542F\u8BED\u97F3\u6216\u7ED9\u89D2\u8272\u9009\u97F3\u8272\u3002";
/** dsh-meme 注册的发图工具。它的提示词段在 qqbot 会话里被 complete section 去掉，用法由这里补上。 */
export declare const MEME_TOOL = "send_meme";
export { DEFAULT_MEME_FREQUENCY, MEME_FREQUENCIES, type MemeFrequency } from './library-types.ts';
export declare function isMemeFrequency(value: unknown): value is MemeFrequency;
/**
 * 表情规则。发送方式（Web 写标记还是走 IM 渠道、纯文字模式）以 send_meme 工具说明和结果为准，这里不重复，
 * 免得和 dsh-meme 的设置冲突；这里只管什么时候发、发多少。
 */
export declare function memeRule(frequency: MemeFrequency, preferences?: MemePreferences): string;
