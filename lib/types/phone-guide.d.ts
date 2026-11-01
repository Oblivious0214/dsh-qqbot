/** 用户点击“怎么做”后，作为新标准会话的普通用户消息发送。 */
export type PhoneGuideRoute = 'local' | 'tailscale';
export declare function phoneGuidePrompt(route: PhoneGuideRoute): string;
