// 构建独立无第三方运行依赖的 Node 连接器；不触碰 DSH 的 lib 或 profile。
import ts from 'typescript'
import { readFile, writeFile, mkdir, cp, stat } from 'node:fs/promises'
import { resolve, relative, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const plugin = dirname(root)
const out = resolve(process.argv[2] ?? '')
if (!process.argv[2] || out === plugin || out.startsWith(root + sep)) throw Error('请提供新的独立输出目录')
try { await stat(out); throw Error('输出目录已存在，请使用新目录') } catch (error) { if (error.code !== 'ENOENT') throw error }
await mkdir(resolve(out, 'lib'), { recursive: true })
const seen = new Set()
async function emit(source) {
  source = resolve(source)
  if (!source.startsWith(root + sep)) throw Error('依赖越过源码边界')
  if (seen.has(source)) return
  seen.add(source)
  const input = await readFile(source, 'utf8')
  const result = ts.transpileModule(input, { fileName: source, compilerOptions: {
    target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true,
  } })
  const dest = resolve(out, 'lib', relative(root, source).replace(/\.ts$/, '.js'))
  await mkdir(dirname(dest), { recursive: true }); await writeFile(dest, result.outputText)
  const ast = ts.createSourceFile(dest, result.outputText, ts.ScriptTarget.ES2024, true)
  for (const item of ast.statements) {
    if ((!ts.isImportDeclaration(item) && !ts.isExportDeclaration(item)) || !item.moduleSpecifier || !ts.isStringLiteral(item.moduleSpecifier)) continue
    const specifier = item.moduleSpecifier.text
    if (specifier.startsWith('.')) await emit(resolve(dirname(source), specifier.replace(/\.js$/, '.ts')))
    else if (!specifier.startsWith('node:')) throw Error(`未打包运行依赖：${specifier}`)
  }
}
await emit(resolve(root, 'toy/remote/cli.ts'))
await cp(resolve(root, 'toy/remote/control.html'), resolve(out, 'lib/toy/remote/control.html'))
await cp(resolve(plugin, 'assets/motion-presets'), resolve(out, 'assets/motion-presets'), { recursive: true })
for (const name of ['LICENSE', 'NOTICE']) await cp(resolve(plugin, name), resolve(out, name))
for (const name of ['README.md', 'PROTOCOL.md']) await cp(resolve(root, 'toy/remote', name), resolve(out, name))
await writeFile(resolve(out, 'package.json'), JSON.stringify({ name: 'serveu-device-connector', version: '0.1.1', private: true, type: 'module', license: 'MIT', engines: { node: '>=24' }, scripts: { start: 'node lib/toy/remote/cli.js', simulate: 'node lib/toy/remote/cli.js --simulate' } }, null, 2) + '\n')
await writeFile(resolve(out, '启动模拟设备.bat'), '@echo off\r\ncd /d "%~dp0"\r\nnode lib/toy/remote/cli.js --simulate\r\npause\r\n')
await writeFile(resolve(out, '启动设备连接器.bat'), '@echo off\r\ncd /d "%~dp0"\r\nnode lib/toy/remote/cli.js\r\npause\r\n')
console.log(JSON.stringify({ version: '0.1.1', modules: seen.size, output: out }))
