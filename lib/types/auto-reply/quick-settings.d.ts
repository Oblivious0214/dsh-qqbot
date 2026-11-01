import { type Warn } from '../storage.ts';
import { type AutoReplyPromptView, type QuickReplyClickMode } from './types.ts';
/** Per-session preference; unlike automatic wakeup, this is safe to remember across restarts. */
export declare class QuickReplySettings {
    private readonly enabled;
    private readonly prompts;
    private readonly clickModes;
    private readonly file;
    constructor(dir: string, warn: Warn);
    clear(): void;
    get(session: string): boolean;
    clickMode(session: string): QuickReplyClickMode;
    setClickMode(session: string, value: unknown): void;
    private save;
    set(session: string, enabled: boolean): void;
    promptView(session: string): AutoReplyPromptView;
    setPrompt(session: string, value: unknown): AutoReplyPromptView;
    prompt(session: string): string;
}
