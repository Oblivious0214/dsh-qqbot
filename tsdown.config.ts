import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { defineConfig } from 'tsdown'

const require = createRequire(import.meta.url)

/** 浏览器模块 id，必须与包名一致。 */
const PLUGIN_ID: string = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name

/** 裁剪弹窗的根 class，与 src/client/image-cropper.tsx 的 CROPPER_CLASS 一致。 */
const CROPPER_CLASS = 'dsh-qqbot-cropper'

/**
 * cropper.css 的规则都以 `.cropper-` 开头，全部加上 CROPPER_CLASS 前缀，只在裁剪弹窗里生效（CLAUDE.md 隔离原则第 3 条）。
 * `@media` 块里的选择器同样处理。
 */
function scopedCropperCss(): string {
  const css = readFileSync(require.resolve('cropperjs/dist/cropper.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  return css.replace(/(^|[{}])(\s*)([^{}@]+?)(\s*\{)/g, (_, before: string, space: string, selectors: string, open: string) =>
    `${before}${space}${selectors.split(',').map(s => `.${CROPPER_CLASS} ${s.trim()}`).join(', ')}${open}`)
}

/**
 * 两端构建，格式与 DSH 的 packages/client/tsdown.client.ts 一致：
 * - host：Node ESM，lib/index.js（登记服务）、lib/prompt.js（预设内提示词插件）和 lib/compaction.js（预设内压缩后端）。
 * - client：浏览器 CJS，包在 window.__ModuleLoader__ 闭包里；平台模块经注入的 require 解析。
 */
export default [
  defineConfig({
    name: `${PLUGIN_ID}/host`,
    entry: { index: 'src/index.ts', prompt: 'src/prompt.ts', compaction: 'src/compaction.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    // 必须和宿主共用同一份 cordis（Service 基类、Context）和 compaction-basic；运行时按 peer 声明解析到宿主的包。
    deps: { neverBundle: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-llm'] },
  }),
  defineConfig({
    name: `${PLUGIN_ID}/client`,
    plugins: [{
      name: 'qqbot-cropper-css',
      resolveId(source: string) { return source === 'virtual:cropper-css' ? '\0qqbot-cropper-css' : undefined },
      load(id: string) { return id === '\0qqbot-cropper-css' ? `export default ${JSON.stringify(scopedCropperCss())}` : undefined },
    }],
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    // 只允许把 Cropper.js 打包进 client.js（不从 CDN 加载），打包了别的依赖时构建报错。neverBundle 是 DSH web/src/platform.ts 的 PLATFORM_MODULES。
    deps: { onlyBundle: ['cropperjs'], neverBundle: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-store',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-primitives',
    ] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }),
]
