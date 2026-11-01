import { type TailscaleEntry } from './tailscale.ts';
import type { PhoneAction, PhoneNetwork, PhoneView } from '../phone-types.ts';
import { type GatewayOptions, type PhoneGateway } from './gateway.ts';
export declare const networks: () => PhoneNetwork[];
export interface ControllerOptions {
    file: string;
    upstream(): string;
    authenticate(): Promise<string>;
    warn(message: string): void;
    tailscale?: (port: number) => Promise<TailscaleEntry>;
    networks?: () => PhoneNetwork[];
    create?: (options: GatewayOptions) => Promise<PhoneGateway>;
}
export declare class PhoneController {
    private readonly options;
    private settings;
    private gateway;
    private remote;
    private revision;
    private error;
    private closed;
    private resetting;
    private queue;
    constructor(options: ControllerOptions);
    private available;
    private address;
    snapshot(): PhoneView;
    initialize(): Promise<void>;
    private serial;
    private save;
    private start;
    action(body: PhoneAction): Promise<PhoneView>;
    private close;
    /** 全部清理撤销登录并回到默认关闭，不导入旧插件资料。 */
    prepareReset(): void;
    reset(): Promise<void>;
    reload(): void;
    dispose(): Promise<void>;
}
