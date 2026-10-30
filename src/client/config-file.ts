/** 配置文件仅在浏览器内解密；服务端只接收解析后的配置，不接收 ZIP 或密码。 */
import { BlobReader, ZipReader, ERR_INVALID_PASSWORD, ERR_INVALID_AUTHENTICATION_CODE, ERR_INVALID_CRC32, ERR_INVALID_COMPRESSED_DATA, ERR_INVALID_UNCOMPRESSED_SIZE, type FileEntry } from '@zip.js/zip.js/lib/zip-core-native.js'
import { CONFIG_MAX_BYTES } from '../config-types.ts'

export class ConfigPasswordError extends Error {
  constructor(readonly retry: boolean) { super(retry ? '密码错误或压缩包已损坏，请重试' : '此 ZIP 已加密，请输入密码') }
}

function parse(text: string): unknown {
  let value: unknown
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { throw new Error('配置文件不是有效的 JSON，请重新选择') }
  if (value === undefined || value === null) throw new Error('配置文件为空，请重新选择')
  return value
}

export async function readConfigFile(file: File, signal: AbortSignal, password?: string): Promise<unknown> {
  if (file.size > CONFIG_MAX_BYTES) throw new Error('配置文件不能超过 10 MB')
  signal.throwIfAborted()
  const header = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  signal.throwIfAborted()
  const zipped = /\.zip$/i.test(file.name) || header[0] === 0x50 && header[1] === 0x4b
  if (!zipped) {
    const text = await file.text()
    signal.throwIfAborted()
    return parse(text)
  }
  // 使用浏览器内建解压流，不创建 Worker、不从外部加载脚本或 WASM。
  const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false, useCompressionStream: true, signal })
  try {
    let config: FileEntry | undefined
    let count = 0
    for await (const entry of reader.getEntriesGenerator()) {
      if (++count > 1000) throw new Error('ZIP 内文件过多，请只打包配置文件')
      if (!entry.directory && /\.json$/i.test(entry.filename) && !entry.filename.startsWith('__MACOSX/')) {
        if (config !== undefined) throw new Error('ZIP 内有多份 JSON，请只保留一份配置文件')
        config = entry
      }
    }
    if (config === undefined) throw new Error('ZIP 内没有 JSON 配置文件')
    if (config.uncompressedSize > CONFIG_MAX_BYTES) throw new Error('解压后的配置文件不能超过 10 MB')
    if (config.encrypted && password === undefined) throw new ConfigPasswordError(false)
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      await config.getData(new WritableStream<Uint8Array>({ write(chunk) {
        size += chunk.byteLength
        if (size > CONFIG_MAX_BYTES) throw new Error('解压后的配置文件不能超过 10 MB')
        chunks.push(chunk)
      } }), { checkSignature: true, ...password === undefined ? {} : { password } })
    } catch (error) {
      if (config.encrypted && error instanceof Error && [ERR_INVALID_PASSWORD, ERR_INVALID_AUTHENTICATION_CODE, ERR_INVALID_CRC32,
        ERR_INVALID_COMPRESSED_DATA, ERR_INVALID_UNCOMPRESSED_SIZE].includes(error.message)) throw new ConfigPasswordError(true)
      throw error
    }
    signal.throwIfAborted()
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return parse(new TextDecoder().decode(bytes))
  } catch (error) {
    if (error instanceof ConfigPasswordError || signal.aborted) throw error
    throw new Error(error instanceof Error && /^(ZIP|解压后|配置文件)/.test(error.message) ? error.message : 'ZIP 无法读取，请检查压缩包和其中的 JSON 配置文件', { cause: error })
  } finally { await reader.close() }
}
