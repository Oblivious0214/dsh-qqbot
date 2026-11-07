import { deflateSync } from 'node:zlib'
import { crc32 } from '../../src/tavern-import/png.ts'
import type { ExtractInput, ImportKind, ImportPayload, SourceInput } from '../../src/tavern-import/types.ts'
import { extract } from '../../src/tavern-import/extract.ts'
import { adoptStatic, defaultSelections } from '../../src/tavern-import/static.ts'
export const v1 = { name: '小岚', description: '小岚是图书管理员。', personality: '温柔、耐心', scenario: '', first_mes: '下午好。', mes_example: '小岚：要找哪本书？' }
export const v2 = { spec: 'chara_card_v2', spec_version: '2.0', data: { ...v1 } }
export const v3 = { spec: 'chara_card_v3', spec_version: '3.0', data: { ...v1, nickname: '岚', group_only_greetings: ['大家好。'] } }
export function source(value: unknown, name = 'input.json'): SourceInput { return { name, originalBase64: Buffer.from(JSON.stringify(value)).toString('base64') } }
export function input(value: unknown = v2, kind: ImportKind = 'role'): ExtractInput { return { kind, sources: [source(value)] } }
export function payload(kind: ImportKind = 'role', name = '导入角色'): ImportPayload {
  const request = input(v2, kind), extracted = extract(request), selections = defaultSelections(extracted)
  if (kind === 'preset') { selections[0]!.selected = true }
  return { ...request, name, selections, body: adoptStatic(extracted, selections) }
}
export function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8), crc = Buffer.alloc(4); header.writeUInt32BE(data.length); header.write(type, 4)
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])))
  return Buffer.concat([header, data, crc])
}
export function png(extra: Buffer[] = [], pixels = Buffer.from([0, 120, 100, 80, 255])): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
export function cardChunk(key: string, value: unknown, type = 'tEXt'): Buffer {
  const encoded = Buffer.from(Buffer.from(JSON.stringify(value)).toString('base64'))
  const content = type === 'tEXt' ? encoded : type === 'zTXt' ? Buffer.concat([Buffer.from([0]), deflateSync(encoded)])
    : Buffer.concat([Buffer.from([1, 0, 0, 0]), deflateSync(encoded)])
  return chunk(type, Buffer.concat([Buffer.from(key), Buffer.from([0]), content]))
}
export function pngInput(bytes: Buffer): ExtractInput { return { kind: 'role', sources: [{ name: '../../card.png', originalBase64: bytes.toString('base64') }] } }
