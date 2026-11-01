import type { PhoneController } from './controller.ts';
/** 两种宿主传输共用同一请求处理，也供真实控制器回归验证。 */
export declare function phoneResponse(controller: PhoneController, request: Request): Promise<Response>;
