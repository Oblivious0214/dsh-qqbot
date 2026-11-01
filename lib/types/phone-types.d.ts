/** 手机入口的设置接口与两端共用数据，不参与提示词组装。 */
export declare const PHONE_PATH = "/api/qqbot/phone";
export declare const PHONE_LOGIN = "/__qqbot_phone/login";
export declare const PHONE_LOGOUT = "/__qqbot_phone/logout";
export interface PhoneNetwork {
    address: string;
    name: string;
}
export interface PhoneView {
    mode?: 'local' | 'tailscale';
    running: boolean;
    enabled: boolean;
    address: string;
    networks: PhoneNetwork[];
    port: number;
    accessCode: string;
    url: string;
    revision: string;
    error: string;
}
export type PhoneAction = {
    action: 'start';
    revision: string;
} | {
    action: 'stop';
    revision: string;
} | {
    action: 'save';
    revision: string;
    address: string;
    port: number;
    accessCode: string;
    mode?: 'local' | 'tailscale';
};
