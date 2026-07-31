<p align="center">
  <img src="docs/assets/logo.svg" width="100" alt="Ableton MCP Beyond 标志" />
</p>

<h1 align="center">Ableton MCP Beyond</h1>

<p align="center">
  以安全为先的 Ableton Live 12 MCP 控制 ——<br/>
  76 个工具、经认证的本地回环桥接,以及基于标准的音频分析。
</p>

<p align="center">
  <a href="README.md">English</a> · 简体中文 · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="https://github.com/user1303836/ableton-mcp-beyond/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://github.com/user1303836/ableton-mcp-beyond/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT 许可证" /></a>
  <a href="apps/mcp-server/package.json"><img src="https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2025-339933?style=flat-square" alt="Node 22 | 24 | 25" /></a>
  <a href="https://modelcontextprotocol.io/specification/2025-11-25"><img src="https://img.shields.io/badge/MCP-2025--11--25-blue?style=flat-square" alt="MCP 协议 2025-11-25" /></a>
  <a href="docs/en/SUPPORT_MATRIX.md"><img src="https://img.shields.io/badge/Ableton%20Live-12-555555?style=flat-square" alt="Ableton Live 12" /></a>
</p>

---

**一个绝不臆测、也绝不毁掉您工程(Set)的 MCP 宿主。**

- **深度 Live 控制** —— 走带、Session 与 Arrangement、剪辑、MIDI 音符、混音器、自动化、路由、录音、工程、订阅。
- **设备精通** —— 递归发现 rack/chain/pad/macro,受护栏约束的参数编辑,Browser 搜索与加载。
- **音频智能** —— ITU-R BS.1770-5 / EBU R128 响度、经验证的真峰值、参考曲目混音对比。无需 Live 即可使用。
- **知情同意的音频捕获** —— 重采样单个剪辑、内部分析、删除所有痕迹。内置看门狗与紧急停止。
- **实时控制** —— 令牌隔离的 UDP/OSC/XY 通道,写入经校验,并配有独立的紧急停止。
- **引导式旅程** —— `plan_user_journey` 将“做一段 lo-fi 节拍”变成有序、可确认、感知当前能力的计划。

## 快速上手

需要 Node.js 22、24 或 25。桥接需要 Ableton Live 12;宿主、测试与演示无需 Live 即可运行。

```sh
cd apps/mcp-server
npm ci && npm run build
npm run demo      # 真实的 MCP 会话,无需 Live
npm test          # 完整测试套件
```

将您的 MCP 客户端指向服务器;如需控制 Live,请配置桥接并安装 Remote Script:

```sh
npm run setup -- --output /abs/path/client-config.json
npm run setup -- --output /abs/path/bridge-config.json \
  --bridge-host 127.0.0.1 --bridge-port 9000 \
  --secret-file /abs/path/bridge.secret
node dist/src/install-remote-script.js --destination '/abs/.../Remote Scripts/AbletonMcpBridge' --dry-run
```

重启 Live,然后验证:`npm run diagnostics -- --config /abs/path/bridge-config.json`。
完整教程:[docs/zh-CN/USER_GUIDE.md](docs/zh-CN/USER_GUIDE.md)。

## 安全模型

每项变更都遵循 **发现 → 预览 → 确认 → 应用 → 验证 → 撤销** 的流程。幂等键、epoch 隔离与执行账本,使丢失的确认也能安全地对账;任意删除一律被拒绝。未经显式桥接配置,服务器处于故障关闭状态 —— 无法读取或改动 Live。参见 [docs/zh-CN/LIVE_SAFETY.md](docs/zh-CN/LIVE_SAFETY.md)。

## 兼容性

| 平台 | 状态 |
|---|---|
| Node.js 22 / 24 / 25 | 支持的契约;必须取得当前精确 SHA 的完整矩阵成功结果 |
| macOS + Live 12 | 已对 12.4.5b8 beta 验证([证据](docs/evidence/)) |
| Windows 宿主 | 已配置 CI 契约;仍需当前精确 SHA 的结果;Windows 11 + Live 尚未认证 |
| Linux / Live 11 或更早 | 不支持 |

能力在连接时协商确定,您的代理始终清楚当前 Live 安装能做什么。完整矩阵:[docs/SUPPORT_MATRIX.md](docs/zh-CN/SUPPORT_MATRIX.md)。

## 文档


| 文档 | 内容 |
|---|---|
| [USER_GUIDE](docs/zh-CN/USER_GUIDE.md) | 工具列表、变更工作流、资源与提示词 |
| [LIVE_SAFETY](docs/zh-CN/LIVE_SAFETY.md) | 真实 Live 的安全边界 |
| [OPERATIONS](docs/zh-CN/OPERATIONS.md) / [RECOVERY](docs/zh-CN/RECOVERY.md) | 运行监督、故障处理、不确定状态恢复 |
| [AUDIO_INTELLIGENCE](docs/zh-CN/AUDIO_INTELLIGENCE.md) | DSP 标准、捕获同意、隐私限制 |
| [USER_JOURNEYS](docs/zh-CN/USER_JOURNEYS.md) | 五个引导式创作工作流 |
| [REALTIME_CONTROL](docs/zh-CN/REALTIME_CONTROL.md) | 已布防的 UDP/OSC/XY 控制平面 |
| [CAPABILITY_MATRIX](docs/zh-CN/CAPABILITY_MATRIX.md) | 代理能力速览,以及按域划分的能力与证据细节 |
| [DELIVERY](docs/zh-CN/DELIVERY.md) | 打包产物的安装、升级、回滚与卸载 |
| [DISTRIBUTION_POLICY](docs/zh-CN/DISTRIBUTION_POLICY.md) | 本地 MIT 产物、必需检查与紧急流程 |
| [IMPLEMENTATION_STATUS](docs/zh-CN/IMPLEMENTATION_STATUS.md) | 已验证内容与当前限制 |

## 许可证

基于 [MIT 许可证](LICENSE.md)开源。软件包的 `private: true` 与本地、未发布、未签名、未公证的交付渠道仅用于防止意外发布,不会改变 MIT 权利。Ableton Live 是 Ableton AG 的商标;MIT 不授予 Ableton 商标权,也不表示关联、认可、签名或认证。
