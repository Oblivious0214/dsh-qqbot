import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

/** 浏览器模块 id，必须与包名一致。 */
const PLUGIN_ID: string = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name

/**
 * 两端构建，格式与 DSH 的 packages/client/tsdown.client.ts 一致：
 * - host：Node ESM，lib/index.js（登记服务）和 lib/prompt.js（预设内提示词插件）。
 * - client：浏览器 CJS，包在 window.__ModuleLoader__ 闭包里；平台模块经注入的 require 解析。
 */
export default [
  defineConfig({
    name: `${PLUGIN_ID}/host`,
    entry: { index: 'src/index.ts', prompt: 'src/prompt.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }),
  defineConfig({
    name: `${PLUGIN_ID}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    // DSH web/src/platform.ts 的 PLATFORM_MODULES
    deps: { neverBundle: [
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
