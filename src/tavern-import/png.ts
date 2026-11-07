/** 独立实现 PNG 块适配，不执行卡片中的资产或脚本。 */
import { inflateSync } from 'node:zlib'
import { LIMITS, type Diagnostic } from './types.ts'
import { base64, fail, ImportError, json, utf8 } from './util.ts'
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
export function isPng(bytes: Buffer): boolean { return bytes.subarray(0, 8).equals(SIGNATURE) }
export function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
interface Chunk { type: string; data: Buffer }
export function chunks(bytes: Buffer): Chunk[] {
  if (!isPng(bytes)) return fail('malformed', 'PNG 签名无效')
  const result: Chunk[] = []
  let offset = 8, ended = false
  while (offset < bytes.length) {
    if (result.length >= LIMITS.chunks) return fail('too-large', 'PNG 块超过 10000 个')
    if (offset + 12 > bytes.length) return fail('malformed', 'PNG 块长度无效')
    const size = bytes.readUInt32BE(offset), end = offset + 12 + size
    if (end > bytes.length) return fail('malformed', 'PNG 块越界')
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return fail('malformed', 'PNG 块类型或 CRC 无效')
    if (result.length === 0 && type !== 'IHDR') return fail('malformed', 'PNG 缺少首部 IHDR')
    if (type === 'IHDR' && (result.length !== 0 || size !== 13)) return fail('malformed', 'PNG IHDR 无效')
    result.push({ type, data: bytes.subarray(offset + 8, end - 4) }); offset = end
    if (type === 'IEND') { if (size !== 0 || offset !== bytes.length) return fail('malformed', 'PNG IEND 无效'); ended = true; break }
  }
  const header = result[0]?.data
  if (!ended || !header || !header.readUInt32BE(0) || !header.readUInt32BE(4) || !result.some(c => c.type === 'IDAT')) return fail('malformed', 'PNG 图片结构不完整')
  const depths = ({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] } as Record<number, number[]>)[header[9]!]
  if (!depths?.includes(header[8]!) || header[10] !== 0 || header[11] !== 0 || header[12]! > 1 || header.readUInt32BE(0) > 0x7fffffff || header.readUInt32BE(4) > 0x7fffffff) return fail('malformed', 'PNG IHDR 图片参数无效')
  return result
}
function inflate(bytes: Buffer, limit: number): Buffer {
  let out: Buffer
  try { out = inflateSync(bytes, { maxOutputLength: Math.max(1, limit) }) }
  catch (e) { return fail((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ? 'too-large' : 'malformed', 'PNG 压缩数据无效或解压超过上限') }
  if (out.length > limit) return fail('too-large', 'PNG 解压超过上限')
  return out
}
function textChunk(chunk: Chunk, limit: number): { key: string; bytes: Buffer } {
  const zero = chunk.data.indexOf(0)
  if (zero < 1 || zero > 79) return fail('malformed', 'PNG 文本关键字无效')
  const key = chunk.data.toString('latin1', 0, zero).toLowerCase()
  let bytes = chunk.data.subarray(zero + 1)
  if (chunk.type === 'zTXt') {
    if (bytes[0] !== 0) return fail('malformed', 'PNG 文本压缩方式无效')
    bytes = inflate(bytes.subarray(1), limit)
  } else if (chunk.type === 'iTXt') {
    const flag = bytes[0], method = bytes[1]
    if ((flag !== 0 && flag !== 1) || method !== 0) return fail('malformed', 'PNG 国际文本格式无效')
    const lang = bytes.indexOf(0, 2), translated = bytes.indexOf(0, lang + 1)
    if (lang < 2 || translated < 0) return fail('malformed', 'PNG 国际文本字段无效')
    bytes = bytes.subarray(translated + 1)
    if (flag === 1) bytes = inflate(bytes, limit)
  }
  if (bytes.length > limit) return fail('too-large', 'PNG 文本解压累计超过 10 MiB')
  return { key, bytes }
}
export function readCardPng(bytes: Buffer, sourceId: string, validate: (value: unknown) => void): { value: unknown; diagnostics: Diagnostic[] } {
  const candidates = new Map<string, unknown[]>(), diagnostics: Diagnostic[] = []
  let used = 0
  for (const c of chunks(bytes)) {
    if (!['tEXt', 'zTXt', 'iTXt'].includes(c.type)) continue
    const item = textChunk(c, LIMITS.pngText - used); used += item.bytes.length
    if (!['ccv3', 'chara'].includes(item.key)) continue
    try {
      const decoded = base64(utf8(item.bytes)), value = json(utf8(decoded))
      validate(value)
      if (item.key === 'ccv3' && (!value || typeof value !== 'object' || (value as Record<string, unknown>)['spec'] !== 'chara_card_v3')) return fail('malformed', 'ccv3 块不是 V3 角色资料')
      const values = candidates.get(item.key) ?? []
      if (!values.some(v => JSON.stringify(v) === JSON.stringify(value))) values.push(value)
      candidates.set(item.key, values)
    } catch (error) {
      if (error instanceof ImportError && error.code === 'too-large') throw error
      diagnostics.push({ code: 'png-card-invalid', message: `${item.key}：${(error as Error).message}`, sourceId })
    }
  }
  for (const [key, values] of candidates) if (values.length > 1) return fail('conflict', `PNG 中有多份不同的 ${key} 角色资料`)
  const value = candidates.get('ccv3')?.[0] ?? candidates.get('chara')?.[0]
  if (value === undefined) return fail('malformed', diagnostics.length ? diagnostics.map(d => d.message).join('；') : '图片中没有角色卡资料')
  return { value, diagnostics }
}
/** 仅接收裁剪流程的 8 位、非隔行小 PNG；完整解压并验证每行 filter 和数据长度。 */
export function validateAvatar(value: string): Buffer {
  const bytes = base64(value, 1024 ** 2), list = chunks(bytes), header = list[0]!.data
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4), color = header[9]
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[color!]
  if (width > 512 || height > 512 || header[8] !== 8 || !channels || header[10] !== 0 || header[11] !== 0 || header[12] !== 0) return fail('malformed', '头像请先裁剪为不超过 512×512 的 PNG')
  if (list.some(c => !['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'pHYs', 'cHRM'].includes(c.type))) return fail('malformed', '头像含原卡资料，请先裁剪头像')
  const row = width * channels + 1, pixels = inflate(Buffer.concat(list.filter(c => c.type === 'IDAT').map(c => c.data)), row * height)
  if (pixels.length !== row * height) return fail('malformed', '头像像素长度无效')
  for (let i = 0; i < height; i++) if (pixels[i * row]! > 4) return fail('malformed', '头像像素过滤方式无效')
  return bytes
}
