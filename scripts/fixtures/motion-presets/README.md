# 转换源数据副本

`catalog.json` 与 `default-pools.json` 逐字节复制自工作区 `legacy/dsh-serveu/src/` 的同名内置数据文件，供独立检出的插件仓库复现转换与回归。只含公开内置轨迹和默认池，没有用户设置。

来源 SHA-256 记录在 `assets/motion-presets/index.json`。工作区存在原文件时，转换器优先读取原文件并核对本副本；独立仓库使用本副本。`.gitattributes` 保留源文件字节及轨迹文件的 LF 换行，避免 Windows 检出影响摘要。

版权和同作者 MIT 授权沿用仓库根 `NOTICE`、`LICENSE`；转换时保留这两份声明。
