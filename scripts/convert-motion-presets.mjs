/** 内置数据迁自同一项目的 dsh-serveu；MIT 及原版权声明见 ../NOTICE、../LICENSE。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { parseFunscript } from '../src/toy/motion-library/script.ts'
import { DESCRIPTIONS, GENERATED, RENAMES, defaultPool, lastRoundTrip } from './motion-preset-defs.mjs'

export { defaultPool }

export const pluginRoot = new URL('../', import.meta.url)
export const workspaceRoot = new URL('../../../', import.meta.url)
export const assetRoot = new URL('assets/motion-presets/', pluginRoot)
export const sourcePaths = {
  catalog: 'legacy/dsh-serveu/src/catalog.json',
  pools: 'legacy/dsh-serveu/src/default-pools.json',
}
export const sha256 = text => createHash('sha256').update(text).digest('hex')
export const jsonText = value => `${JSON.stringify(value, null, 2)}\n`

/** 只读内置 catalog/default-pools；不读取用户数据。相对脚本定位，不依赖 cwd。 */
export function readSources() {
  return Object.fromEntries(Object.entries(sourcePaths).map(([key, path]) => {
    const original = new URL(path, workspaceRoot)
    const fixture = new URL(`./fixtures/motion-presets/${key === 'catalog' ? 'catalog.json' : 'default-pools.json'}`, import.meta.url)
    const bytes = readFileSync(existsSync(original) ? original : fixture)
    assert.equal(sha256(bytes), sha256(readFileSync(fixture)), `${key}: source differs from recorded fixture`)
    return [key, { path, sha256: sha256(bytes), value: JSON.parse(bytes.toString('utf8')) }]
  }))
}

export function convertPreset(key, preset) {
  assert.ok(Array.isArray(preset.segments) && preset.segments.length > 0, `${key}: empty`)
  const actions = [{ at: 0, pos: preset.segments[0][0] }]
  let elapsed = 0
  preset.segments.forEach(([from, to, ms], index) => {
    assert.equal(from, actions.at(-1).pos, `${key}/${index}: discontinuous`)
    assert.ok(Number.isFinite(ms) && ms >= 0, `${key}/${index}: invalid duration`)
    if (ms === 0) {
      // 仅省略已核对的末尾空段；新增坏段不能被静默丢弃。
      assert.equal(key, 'zipper')
      assert.equal(index, preset.segments.length - 1)
      assert.deepEqual([from, to, ms], [50, 50, 0])
      return
    }
    elapsed += ms
    actions.push({ at: Math.round(elapsed), pos: to })
  })
  assert.equal(actions[0].pos, actions.at(-1).pos, `${key}: open loop`)
  const result = { version: '1.0', actions }
  parseFunscript(jsonText(result)) // 使用用户导入的同一个解析器。
  return result
}

export function generateAssets() {
  const sources = readSources()
  const catalog = sources.catalog.value
  const files = new Map()
  const entries = [
    ...Object.entries(catalog).map(([key, preset]) => ({ key, name: RENAMES[key] ?? preset.name, script: convertPreset(key, preset), generated: false })),
    ...GENERATED.map(item => ({ key: item.key, name: item.name, script: { version: '1.0', actions: item.actions }, generated: true,
      ...item.loop === 'last' ? { loopFromMs: lastRoundTrip(item.actions) } : {} })),
  ]
  const presets = entries.map(({ key, name, script, generated, loopFromMs }, index) => {
    parseFunscript(jsonText(script))
    assert.equal(script.actions[0].pos, script.actions.at(-1).pos, `${key}: open loop`)
    assert.ok(DESCRIPTIONS[key], `${key}: missing description`)
    const id = `motion-${index + 1}`
    const file = `${id}.funscript`
    const text = jsonText(script)
    files.set(file, text)
    return {
      id, file, name, description: DESCRIPTIONS[key], playback: 'loop', ...loopFromMs === undefined ? {} : { loopFromMs },
      sourceKey: key, sourceOrdinal: index + 1, ...generated ? { generated: true } : {}, sha256: sha256(text),
    }
  })
  assert.equal(presets.length, 24 + GENERATED.length)
  const pools = Object.fromEntries(Object.entries(sources.pools.value).map(([tier, pool]) => [tier, defaultPool(tier, pool, catalog)]))
  const index = {
    format: 'dsh-motion-preset-assets', version: 1,
    sources: Object.fromEntries(Object.entries(sources).map(([key, { path, sha256 }]) => [key, { path, sha256 }])),
    conversion: { time: 'Math.round(cumulative source milliseconds)', omitted: 'zipper final [50,50,0] only' },
    presets, pools,
  }
  files.set('index.json', jsonText(index))
  const rows = presets.map(p => `| ${p.sourceOrdinal} | ${p.name} | [${p.file}](${p.file}) | ${p.generated ? `生成：${p.sourceKey}` : p.sourceKey} |`).join('\n')
  files.set('README.md', `# 内置动作轨迹（${presets.length} 套）\n\n由 \`../../scripts/convert-motion-presets.mjs\` 自动生成，名称、描述、生成轨迹和默认动作池定义在 \`../../scripts/motion-preset-defs.mjs\`。前 24 套轨迹来自 \`legacy/dsh-serveu/src/catalog.json\`，其中 normal 改名稳定节奏、takeit 改名滑动；后 ${GENERATED.length} 套由程序生成（渐快、渐慢、间歇、快去慢回、慢去快回）。来源 SHA-256、名称、描述、循环方式与默认动作池在 [index.json](index.json)，轨迹只含 version/actions/at/pos。\n\n全部循环播放；渐快、渐慢带 \`loopFromMs\`，走完一遍后只循环最后一个往返（保持最快／最慢）。默认动作池按档位拉开：慢档偏舒缓、中档以稳定节奏为主、快档偏激烈；爆发与温存没有自己的池时分别用快档、慢档池。内部文件名按顺序生成，界面只显示名称。\n\n累计毫秒四舍五入，不逐段独立取整；位置、顺序及正时长停留原样保留。仅省略 zipper 末尾 [50,50,0] 空段。各点及各段误差见工作区 \`work/funscript-presets-20261031/verification.json\`。全部闭合；0.7.0 起运行时从这些文件读取，用户轨迹也单独保存为 funscript，名称与配置分开存储。\n\n版权与来源沿用 [NOTICE](../../NOTICE) 和 [LICENSE](../../LICENSE)：同一项目作者将旧 dsh-serveu 内置数据按 MIT 纳入；原版权声明保留。分发这些资产时同时保留上述文件。\n\n| 顺序 | 中文名称 | 轨迹文件 | 旧 catalog 键 |\n| --- | --- | --- | --- |\n${rows}\n\n在工作区根目录执行：\n\n\x60\x60\x60powershell\nnode plugins/dsh-qqbot/scripts/convert-motion-presets.mjs\nnode plugins/dsh-qqbot/scripts/convert-motion-presets.mjs --check\nnode plugins/dsh-qqbot/scripts/verify-motion-presets.mjs\n\x60\x60\x60\n\n转换需 Node 24；优先读取本工作区只读旧内置 JSON，独立仓库使用 scripts/fixtures/motion-presets 中的逐字节副本；无新增依赖。\n`)
  return files
}

export function runConversion(check = false) {
  const files = generateAssets()
  if (check) {
    assert.deepEqual(readdirSync(assetRoot).sort(), [...files.keys()].sort(), 'asset file set differs')
    for (const [name, expected] of files) assert.equal(readFileSync(new URL(name, assetRoot), 'utf8'), expected, `${name}: not reproducible`)
  } else {
    mkdirSync(assetRoot, { recursive: true })
    for (const [name, text] of files) writeFileSync(new URL(name, assetRoot), text)
  }
  return files.size
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.ok(process.argv.slice(2).every(arg => arg === '--check'), 'Usage: node convert-motion-presets.mjs [--check]')
  const count = runConversion(process.argv.includes('--check'))
  console.log(`${process.argv.includes('--check') ? 'Verified' : 'Generated'} ${count} files in ${fileURLToPath(assetRoot)}`)
}
