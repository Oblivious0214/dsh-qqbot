import { type Warn } from '../storage.ts';
import { type AutoReplyPromptView } from './types.ts';
/** Custom notices belong to one conversation; activation is never persisted. */
export declare class AutoReplyPromptSettings {
    private readonly values;
    private readonly file;
    constructor(dir: string, warn: Warn);
    clear(): void;
    get(session: string): AutoReplyPromptView;
    set(session: string, value: unknown): AutoReplyPromptView;
}
