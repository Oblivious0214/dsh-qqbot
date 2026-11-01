/**
 * 每个会话的联动状态，只在内存里。DSH 重启、插件重载后所有会话回到未接入，需要用户重新点"接入对话"。
 * 多个 qqbot 会话各自接入、各自断开（docs/architecture.md 第 5 节）。
 */
import type { SessionRole, ToySessionView, ToySettings } from './api-types.ts';
import { type DeviceStatus } from './core/rules.ts';
import type { Proactivity } from './core/safety.ts';
export type { SessionRole } from './api-types.ts';
export declare function validSessionId(value: unknown): value is string;
export declare class SessionStates {
    private readonly settings;
    private readonly role;
    private readonly sessions;
    constructor(settings: () => ToySettings, role?: (id: string) => SessionRole | undefined);
    attach(id: string, status: DeviceStatus): void;
    setStatus(id: string, status: DeviceStatus): void;
    detach(id: string): void;
    /** 设置保存后调用：撤回授权时全部退出。 */
    settingsChanged(): void;
    clear(): void;
    status(id: string): DeviceStatus | undefined;
    /** 每次现读角色卡的档位；没有设置时为低自主性。 */
    proactivity(id: string): Proactivity;
    /** 登记给 qqbot 的规则。未接入的会话为空串，规则不出现在它的提示词里。角色偏好每次现读。 */
    rules(id: string): string;
    view(id: string): ToySessionView;
}
