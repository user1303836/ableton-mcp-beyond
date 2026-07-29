# 支持与取证平台矩阵

[English](../en/SUPPORT_MATRIX.md) · 简体中文 · [日本語](../ja/SUPPORT_MATRIX.md)

"支持"分为宿主/软件包支持与真实 Ableton Live 认证。绿色的宿主单元格
绝不会被提升为 Live 单元格。

## 运行时与操作系统

| 平台 | 版本 / 架构 | 状态 | 证据 |
|---|---|---|---|
| Node.js | 22.x、24.x、25.x | 仅当精确 SHA 矩阵为绿时,该候选才具有受支持的宿主/软件包契约 | [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml);来自其他 SHA 的配置或结果不是证据 |
| Node.js | 26.x 或未来主版本 | 不受支持的发布运行时 | 需要显式的矩阵与引擎范围更新 |
| macOS 宿主 | GitHub `macos-15`;本地 macOS arm64 环境 | 仅当精确 SHA 任务通过时支持宿主/软件包契约 | Node/软件包/生命周期门禁;需要单独的本地 Live 证据 |
| Windows 宿主 | GitHub Windows Server 2025 x64(`windows-2025`) | 仅当精确 SHA 任务通过时支持宿主/软件包契约 | Node/软件包/生命周期/ACL/联接点/占用文件门禁;不是 Windows 11 或 Live 证据 |
| Windows 桌面 | Windows 11 x64 | 过程已记录,未认证 | 需要精确候选宿主加 Live 证据;不得继承 Server 状态 |
| Linux 宿主 | Ubuntu 24.04 x64(`ubuntu-24.04`) | 仅支持宿主契约 | Node/软件包门禁;无 Live 声明 |

软件包引擎范围为 `>=22 <26`;一个精确的发布可以使用 Node 22、24 或 25。
操作系统供应商生命周期变化需要矩阵更新,而不是隐式支持。

## Ableton Live

| 操作系统 | Live 版本 / 版本层级 | 状态 | 证据 / 限制 |
|---|---|---|---|
| macOS | Live 12.4.5b8 beta;已安装的版本层级不会通过 Remote Script 状态 API 暴露 | 观察到的工程目标,不是公开发布认证 | [`../evidence/`](../evidence/);必须为最终候选摘要重新运行;版本层级明确未知 |
| macOS | Live 12 Suite | 协商契约,缺少版本层级特定认证 | 通用 API 在运行时发现;绝不假设 Suite 设备/内容 |
| macOS | Live 12 Standard | 协商契约,缺少版本层级特定认证 | 缺失的设备/内容保持不可用 |
| macOS | Live 12 Intro | 协商契约,缺少版本层级特定认证 | 精简的功能/内容面保持不可用 |
| Windows 11 | Live 12 Suite / Standard / Intro | 未认证 / 外部环境不可用 | 服务器宿主 CI 不是 Windows Live;每个层级都需要安装、激活、变更、重启、恢复与卸载证据 |
| Linux | 任意 | 不支持 | 本产品不在 Linux 上提供 Ableton Live |
| Live 11 或更早 | 任意 | 不支持/未验证 | 不声明协议/API 兼容性 |

## 无障碍

服务器自有的 stdio 文本契约经过语义顺序、纯文本、非颜色状态与无指针
依赖的测试。VoiceOver、Narrator、Ableton Live、插件窗口、终端与第三方
MCP 客户端是版本依赖的外部界面,不在服务器测试的认证范围内。

## 发布含义

打包的 tarball 可以在没有签名的情况下构建并通过生命周期测试。只有当
每个精确 SHA 的 CI 矩阵任务通过时,候选才是宿主发布就绪的。Windows
Server 宿主证据不认证 Windows 11、Ableton Live、Narrator 或插件窗口。
这些外部单元格保持明确不可用,直到合适的环境产生绑定候选的证据;绝不
得把它们改写为通过单元格。
