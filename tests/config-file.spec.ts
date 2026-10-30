import { describe, expect, it } from 'vitest'
import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js/lib/zip-core-native.js'
import { ConfigPasswordError, readConfigFile } from '../src/client/config-file.ts'
import { CONFIG_MAX_BYTES } from '../src/config-types.ts'

const config = { format: 'dsh-qqbot-config', version: 1, presets: [{ name: '测试', head: '提示词' }] }
const signal = () => new AbortController().signal
async function zip(entries = [{ name: 'config.json', text: JSON.stringify(config) }], password?: string, zipCrypto = false, level = 5) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: true })
  for (const entry of entries) await writer.add(entry.name, new TextReader(entry.text), { level, ...password === undefined ? {} : { password, zipCrypto } })
  return new File([await writer.close()], '配置.zip')
}

describe('configuration files', () => {
  it('keeps JSON and BOM support', async () => {
    expect(await readConfigFile(new File(['\uFEFF' + JSON.stringify(config)], '配置.json'), signal())).toEqual(config)
  })
  it('reads a multi-chunk JSON larger than the old 2 MB limit without changing Unicode content', async () => {
    const large = { format: config.format, version: 1, presets: Array.from({ length: 40 }, (_, n) => ({ name: `大包 ${n}`, head: '字'.repeat(20000) })) }
    expect(await readConfigFile(await zip([{ name: 'config.json', text: JSON.stringify(large) }]), signal())).toEqual(large)
  })
  it('reads a plain ZIP, including a config in a folder and unrelated files', async () => {
    expect(await readConfigFile(await zip([{ name: '分享/配置.JSON', text: JSON.stringify(config) }, { name: '说明.txt', text: '说明' }]), signal())).toEqual(config)
  })
  it.each([false, true])('requires password, rejects wrong password, and allows retry (ZipCrypto=%s)', async zipCrypto => {
    const file = await zip(undefined, ' 密码🔑 ', zipCrypto)
    await expect(readConfigFile(file, signal())).rejects.toMatchObject({ retry: false })
    await expect(readConfigFile(file, signal(), 'wrong')).rejects.toBeInstanceOf(ConfigPasswordError)
    expect(await readConfigFile(file, signal(), ' 密码🔑 ')).toEqual(config)
  })
  it('supports uncompressed encrypted ZIPs and signature detection without a zip extension', async () => {
    const file = new File([await zip(undefined, 'secret', true, 0)], '无扩展名')
    expect(await readConfigFile(file, signal(), 'secret')).toEqual(config)
  })
  it('rejects missing and ambiguous configuration files', async () => {
    await expect(readConfigFile(await zip([{ name: 'readme.txt', text: '' }]), signal())).rejects.toThrow('没有 JSON')
    await expect(readConfigFile(await zip([{ name: 'one.json', text: '{}' }, { name: 'two.json', text: '{}' }]), signal())).rejects.toThrow('多份 JSON')
  })
  it('rejects invalid JSON after decryption', async () => {
    await expect(readConfigFile(await zip([{ name: 'config.json', text: '{' }], 'secret'), signal(), 'secret')).rejects.toThrow('不是有效的 JSON')
  })
  it('rejects oversized JSON, ZIP and decompressed data', async () => {
    await expect(readConfigFile(new File(['x'.repeat(CONFIG_MAX_BYTES + 1)], '配置.json'), signal())).rejects.toThrow('不能超过 10 MB')
    await expect(readConfigFile(new File(['x'.repeat(CONFIG_MAX_BYTES + 1)], '配置.zip'), signal())).rejects.toThrow('不能超过 10 MB')
    await expect(readConfigFile(await zip([{ name: 'config.json', text: 'x'.repeat(CONFIG_MAX_BYTES + 1) }]), signal())).rejects.toThrow('解压后的配置文件不能超过')
  })
  it('rejects forged decompressed sizes while streaming', async () => {
    const bytes = new Uint8Array(await (await zip([{ name: 'config.json', text: 'x'.repeat(CONFIG_MAX_BYTES + 1) }])).arrayBuffer())
    const view = new DataView(bytes.buffer)
    for (let i = 0; i < bytes.length - 28; i++) if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 1, true)
    await expect(readConfigFile(new File([bytes], '伪造.zip'), signal())).rejects.toThrow()
  })
  it('rejects damaged archives', async () => {
    await expect(readConfigFile(new File(['PKbroken'], '坏包.zip'), signal())).rejects.toThrow('ZIP 无法读取')
  })
  it('honors cancellation', async () => {
    const abort = new AbortController(); abort.abort()
    await expect(readConfigFile(await zip(undefined, 'secret'), abort.signal, 'secret')).rejects.toMatchObject({ name: 'AbortError' })
  })
})
