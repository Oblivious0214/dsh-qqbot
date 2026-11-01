export declare function isPrivateAddress(address: string): boolean;
export declare const validCode: (code: unknown) => code is string;
export interface GatewayOptions {
    host: string;
    port: number;
    upstream: string;
    accessCode: string;
    authenticate(): Promise<string>;
    externalOrigin?: string;
    sessionMs?: number;
    now?: () => number;
}
export interface PhoneGateway {
    url: string;
    close(): Promise<void>;
}
export declare function createGateway(options: GatewayOptions): Promise<PhoneGateway>;
