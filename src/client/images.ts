/**
 * 上传前在浏览器里处理图片：裁剪弹窗（image-cropper.tsx）取景后，头像输出 AVATAR_SIZE 见方的 PNG，
 * 背景按最长边缩到 BACKGROUND_MAX_EDGE 的 JPEG。
 * 输出重新编码过的 data URL，原文件的 EXIF 等元数据不会上传。
 */

import { AVATAR_SIZE, BACKGROUND_MAX_EDGE, IMAGE_BYTE_LIMIT } from '../ui-types.ts'

export type ImageKind = 'avatar' | 'background'

/** 读入的原图上限，防止误选超大文件把页面卡住。 */
const SOURCE_BYTE_LIMIT = 40 * 1024 * 1024
/** 原图像素上限（一亿像素），超过时浏览器解码和裁剪都会很慢。 */
export const SOURCE_PIXEL_LIMIT = 100_000_000

/** 选图后先检查类型和大小，不合格时抛出给用户看的错误。 */
export function checkImageFile(file: File): void {
  if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) throw new Error('只支持 PNG、JPEG、WebP、GIF、BMP 图片')
  if (file.size > SOURCE_BYTE_LIMIT) throw new Error('图片太大，最多 40 MB')
}

/** 裁出来的区域要输出多大：头像固定 AVATAR_SIZE 见方，背景最长边不超过 BACKGROUND_MAX_EDGE，不放大。 */
export function outputSize(kind: ImageKind, width: number, height: number): { width: number; height: number } {
  if (kind === 'avatar') return { width: AVATAR_SIZE, height: AVATAR_SIZE }
  const scale = Math.min(1, BACKGROUND_MAX_EDGE / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** 把裁好的画布编码成上传用的 data URL。头像用 PNG（保留透明），背景用 JPEG。 */
export function encodeImage(kind: ImageKind, canvas: HTMLCanvasElement): string {
  const data = canvas.toDataURL(kind === 'avatar' ? 'image/png' : 'image/jpeg', 0.88)
  // base64 每 4 个字符 3 个字节。
  if ((data.length - data.indexOf(',') - 1) * 3 / 4 > IMAGE_BYTE_LIMIT[kind]) throw new Error('处理后的图片仍然太大，请缩小取景范围或换一张')
  return data
}
