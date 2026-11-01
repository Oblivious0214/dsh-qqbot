/**
 * 程序层的停止规则。提示词只是让 AI 配合，真正让设备停下的是这里和播放器（CLAUDE.md"急停只能由程序执行"）。
 * 任何档位都保留：暂停按钮、暂停快捷键、行程和速度上限、最后一段显示后自动停止、首包限速进入。
 * 不检测用户消息里的停止词或安全词：用户说"停"时由 AI 按档位配合，要确保停下就用按钮或快捷键（docs/architecture.md 第 10 节）。
 */
/** 最后一段显示后多久自动停止。 */
export declare const LAST_STAGE_STOP_MS = 30000;
/** 等下一段出现时，在预定间隔之外多给的余量；超过就停，防止显示卡住时设备一直动。 */
export declare const STAGE_GRACE_MS = 5000;
/**
 * 自主性档位。0 低自主性（默认）、1 中自主性、2 高自主性。
 * 档位只由角色卡决定并随角色保存；没有设置时使用低自主性。
 */
export declare const PROACTIVITY_LEVELS: readonly [0, 1, 2];
export type Proactivity = (typeof PROACTIVITY_LEVELS)[number];
export declare function isProactivity(value: unknown): value is Proactivity;
/** 设置文件和 dsh-qqbot 角色卡里档位的写法，按档位序号排列。 */
export declare const PROACTIVITY_KEYS: readonly ["follow", "situational", "high"];
export type ProactivityKey = (typeof PROACTIVITY_KEYS)[number];
export declare function proactivityOfKey(value: unknown): Proactivity | undefined;
