/**
 * 上传前在浏览器里处理图片：头像居中裁成正方形并缩到 AVATAR_SIZE，背景按最长边缩到 BACKGROUND_MAX_EDGE。
 * 输出重新编码过的 data URL，原文件的 EXIF 等元数据不会上传。
 */

import { AVATAR_SIZE, BACKGROUND_MAX_EDGE, IMAGE_BYTE_LIMIT } from '../ui-types.ts'

/** 读入的原图上限，防止误选超大文件把页面卡住。 */
const SOURCE_BYTE_LIMIT = 40 * 1024 * 1024

async function decode(file: File): Promise<ImageBitmap> {
  if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) throw new Error('只支持 PNG、JPEG、WebP、GIF、BMP 图片')
  if (file.size > SOURCE_BYTE_LIMIT) throw new Error('图片太大，最多 40 MB')
  try {
    return await createImageBitmap(file)
  } catch {
    throw new Error('读不了这张图片')
  }
}

function encode(canvas: HTMLCanvasElement, type: 'image/png' | 'image/jpeg', limit: number): string {
  const data = canvas.toDataURL(type, 0.88)
  // base64 每 4 个字符 3 个字节。
  if ((data.length - data.indexOf(',') - 1) * 3 / 4 > limit) throw new Error('处理后的图片仍然太大，请换一张')
  return data
}

function canvasOf(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('浏览器不支持处理图片')
  context.imageSmoothingQuality = 'high'
  return [canvas, context]
}

export async function avatarFromFile(file: File): Promise<string> {
  const bitmap = await decode(file)
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    const [canvas, context] = canvasOf(AVATAR_SIZE, AVATAR_SIZE)
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
    return encode(canvas, 'image/png', IMAGE_BYTE_LIMIT.avatar)
  } finally {
    bitmap.close()
  }
}

export async function backgroundFromFile(file: File): Promise<string> {
  const bitmap = await decode(file)
  try {
    const scale = Math.min(1, BACKGROUND_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const [canvas, context] = canvasOf(width, height)
    context.drawImage(bitmap, 0, 0, width, height)
    return encode(canvas, 'image/jpeg', IMAGE_BYTE_LIMIT.background)
  } finally {
    bitmap.close()
  }
}
