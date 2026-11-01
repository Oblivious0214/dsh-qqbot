/** 角色自己的表情偏好。格式独立于 dsh-meme，只借用它的只读图库目录。 */
import type { MemePreferences } from './library-types.ts';
/** 表单严格校验；空值不写入角色卡。 */
export declare function validateMemePreferences(value: Record<string, unknown>): MemePreferences;
