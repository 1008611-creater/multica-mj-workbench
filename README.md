# Multica MJ 中文创作工作台

Windows 本地创作工作台：准备创意 → 组织批次 → 检查并保存 → 运行监控 → 图片筛选与比较 → 归档和复用。

权威版本 **2026.10.08.1**。源码以本仓库 tag `v2026.10.08.1` 为准；安装包与 SHA256 在该 tag 的 GitHub Release assets。安装包为可安装的 Windows x64 ZIP，解压后用 `Install-Multica.cmd` 安装，或用 `Multica.exe` 便携运行。需要 Edge 和 WebView2 Runtime。

## 图片工作区

- 状态、批次、标签、模型、画幅与多词搜索组合，支持排序和清空筛选。
- 选择跨筛选保留，比较托盘最多四张，标记提示词、版本、画幅与参数差异。
- 批量复用到新草稿，不继承运行状态或付费授权；缺失字段单独确认。
- 默认原图位置和批次指定位置；用户指定的素材目录中保存原图副本和来源 JSON。
- 素材复制逐项校验完整哈希，重复复制不产生重复文件，冲突不覆盖。

## 开始使用

下载 Release assets 中的 ZIP 并校验 SHA256。解压到新目录运行 `Multica.exe`，或执行 `Install-Multica.cmd -TargetRoot "D:\Multica"`。已有安装升级前先备份程序与本机数据；登录资料、任务、回执、成品及本地配置不得随源码发布。

生成平台仍使用已有 MJ 浏览器适配器。登录由用户手动完成，开始或继续付费生成需要本次确认。启动、刷新、保存草稿、复用与素材复制均不提交生成。共享档案单路；独立档案本地最多三路，真实平台并发仍未验证。

## 源码运行与验证

Windows 需 Node.js、Python 3.10+ 和 .NET 10 SDK。执行 `Setup-Multica.cmd` 准备本地依赖，之后运行 `npm test`、`npm run verify`。构建命令：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build_multica_portable.ps1 -Version 2026.10.08.1`。构建依赖本机准备的 Python、Node 和 Playwright；不会将账号档案放入分发包。

本仓库只含软件源码和发行资料，独立于私人项目控制台。`SOURCE_FILES.json` 记录本次从工作区取出的每份软件源码哈希，可核对安装包。公开代码尚未选择额外许可证；第三方依赖遵循各自许可证。

## 验证边界

本版本通过 31 项 Node、31 项 Python 测试及隔离本地 HTTP 检查。HTTP 测试用明确标注的一像素测试文件，不代表真实生成成品。本轮没有新增付费生成。真实成功出图、高级参数采用、平台三路并发、异机安装和代码签名仍未验证。最终上传与本机升级以 Release 发行记录为准。

## 产品设计参考

借鉴 [InvokeAI](https://github.com/invoke-ai/InvokeAI) 的图库和元数据回溯、[ComfyUI](https://github.com/Comfy-Org/ComfyUI) 的队列与模板、[shadcn/ui](https://github.com/shadcn-ui/ui) 的可组合分层操作。采用现有原生 HTML/JS 自行实现，没有复制这些项目源码或接入其生成引擎，避免增加 GPU、模型与新前端构建依赖。
