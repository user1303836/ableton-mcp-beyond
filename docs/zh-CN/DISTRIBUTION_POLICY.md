# 分发、签名与发布策略

[English](../en/DISTRIBUTION_POLICY.md) · 简体中文 · [日本語](../ja/DISTRIBUTION_POLICY.md)

## 选定渠道

仓库唯一配置的发布渠道是由 `npm pack` 创建的**精确本地 npm tarball**。
软件与 tarball 采用 [MIT 许可证](../../LICENSE.md)。软件包保留
`private: true` 以防止意外执行 `npm publish`;候选不会发布到 npm、GitHub
Releases 或其他注册表。安装必须绑定精确本地路径与 SHA-256。SHA 证明字节
完整性,不证明发布者身份。

本地产物未签名、未经过 Apple 公证,也不提供原生 macOS 或 Windows 安装器。
公开发布、代码签名、公证与商标审查需要所有者另行决定、经授权的身份与专用
发布门禁。MIT 授予软件使用与再分发权,但不授予 Ableton 商标权,不表示 Ableton
认可,也不证明发布者身份或平台认证。

## 产物允许列表

tarball 仅可包含:

- 编译后的运行时 JavaScript 与声明(不含源码映射或测试);
- Remote Script、规范操作注册表及其清单;
- 发布清单/来源记录与软件包元数据;
- MIT 许可证;以及
- 允许列表中的用户、安全、运维、恢复、测试、支持、分发与实现状态文档。

它不得包含验证/测试运行器、测试夹具、依赖、凭据、配置、本地状态、日志、
备份、捕获媒体、生成证据或受保护的本地 SDK 材料。`package:verify` 拒绝独立
枚举允许列表之外的任何路径并验证所有清单哈希。发布来源记录精确 Node、npm、
TypeScript 版本,平台/架构与托管映像标识,package-lock/工作流 SHA-256,源码
提交/脏状态和可运行配方。CI 从全新分离克隆与全新 `npm ci` 重复打包并逐字节
比较;只有实际执行的精确 SHA 任务才构成证据。

## 必需检查与紧急流程

`Required CI` 是稳定的合并门禁上下文。只有精确候选构建、完整 Node/OS 已安装
候选矩阵与完整 Python Remote Script 矩阵全部成功时,它才成功。仓库不应存在
常驻 ruleset 绕过主体。

紧急设置变更仅限仓库所有者。更改规则前,所有者必须创建事件 issue,记录原因、
精确提交 SHA、失败/不可用检查、风险与恢复计划。然后只能临时更改阻塞设置,
合并所记录的 SHA,立即恢复规则,运行完整精确候选矩阵,并在事件中记录绕过后
审查与结果。绕过绝不会把缺失或失败的证据变成通过声明。

## 证据边界

Linux 仅是宿主/软件包契约平台;不认证 Ableton Live。macOS 真实 Live 证据仅
覆盖明确记录的 Live 12.4.5b8 beta 环境。Windows CI 可证明宿主、ACL、生命周期
与软件包契约,但不是 Windows Live 证据。精确支持矩阵见
[SUPPORT_MATRIX.md](SUPPORT_MATRIX.md)。

只有同一 tarball 可复现、清单标识精确干净 Git 提交、该 SHA 的所有本地与托管
门禁通过,且适用的真实 Live 证据命名同一产物摘要时,候选才符合当前本地渠道。
历史、模拟器、fake-Live 或陈旧证据绝不会填补缺失的候选单元格。
