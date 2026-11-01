/** 构建时由 tsdown.config.ts 生成：加了 CROPPER_CLASS 前缀的 cropper.css。 */
declare module 'virtual:cropper-css' {
  const css: string
  export default css
}

/** 插件版本来自构建时的 package.json，不另行维护版本常量。 */
declare module 'virtual:qqbot-version' {
  const version: string
  export default version
}
