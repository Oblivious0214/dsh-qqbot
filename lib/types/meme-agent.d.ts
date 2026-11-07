/** 每个 QQ agent 自己的 send_meme，遮蔽继承的全局工具；不改标准会话。 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt';
export declare const MEME_DESCRIPTION = "\u4ECE\u5F53\u524D\u89D2\u8272\u7684\u53EF\u7528\u56FE\u5E93\u4E2D\u6309\u6807\u7B7E\u6216\u5173\u952E\u8BCD\u627E\u8868\u60C5\u3002\u6311\u9009\u8D34\u5408\u7684\u4E00\u5F20\uFF0C\u5C06\u5019\u9009\u7684 marker \u539F\u6837\u5199\u8FDB\u56DE\u590D\uFF1B\u6CA1\u6709\u5408\u9002\u5019\u9009\u65F6\u7EE7\u7EED\u6587\u5B57\u56DE\u5E94\u3002";
export declare const MEME_PARAMETERS: {
    type: "object";
    properties: {
        tag: {
            type: "string";
            description: string;
        };
        query: {
            type: "string";
            description: string;
        };
        limit: {
            type: "number";
            description: string;
        };
    };
    additionalProperties: boolean;
};
/** rc.5 的 complete section 会移除 PTC SDK，补回本工具自己的声明。 */
export declare function toolDeclaration(ctx: Context, input: AssembleContext): string;
export declare function scopedMemeTool(ctx: Context, agent: Agent): ToolDefinition;
export declare const name = "qqbot-meme-scope";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
