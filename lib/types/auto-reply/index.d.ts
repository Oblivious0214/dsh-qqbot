import type { Context } from '@deepseek-ai/cordis';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'qqbot-auto-reply': {
            kind: 'qqbot-auto-reply';
            form: 'notice';
            summary: string;
        };
    }
}
export declare const name = "qqbot-auto-reply";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
