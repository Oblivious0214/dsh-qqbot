/** Standing qqbot composition; every agent owns its scoped tool and frozen turn. */
import type { Context } from '@deepseek-ai/cordis';
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt';
export declare const name = "qqbot-role-dynamics";
export declare const inject: string[];
/** rc.5 collapses PTC schemas to run_code and complete removes tools:sdk.
 * Carry only this registered capability's existing declaration in qqbot:prompt. */
export declare function toolDeclaration(ctx: Context, input: AssembleContext): string;
export declare function apply(ctx: Context): void;
