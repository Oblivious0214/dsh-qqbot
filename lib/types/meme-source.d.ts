import type { MemePackChoice } from './library-types.ts';
import type { MemeScopeView } from './meme-scope.ts';
export interface MemeSettings {
    readonly enabledPacks?: readonly string[];
    readonly sendMode?: string;
}
export declare function readMemeSettings(): MemeSettings;
export declare class MemeSource {
    private readonly origin;
    private readonly settings;
    private readonly request;
    constructor(origin: () => string, settings?: typeof readMemeSettings, request?: typeof fetch);
    read(selected: readonly MemePackChoice[], signal: AbortSignal): Promise<MemeScopeView>;
}
