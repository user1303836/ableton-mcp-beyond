# 开发者指南

[English](../en/DEVELOPER_GUIDE.md) · 简体中文 · [日本語](../ja/DEVELOPER_GUIDE.md)

本仓库的各部分如何组合在一起、如何开发每个部分，以及如何发布。[测试](TESTING.md)列出了所有测试命令以及 CI 运行的内容。

## 原生版开发

当前应用和桥接位于根目录的 Cargo 工作区：`crates/kumi` 提供 CLI 和界面，
`crates/kumi-runtime` 提供代理与 Live 集成，`crates/kumi-common` 提供公共功能，
`crates/ableton-mcp-server` 提供桥接。需要 Rust、Cargo 和 Python 3.11 或更高版本。

```sh
cargo build --release --locked --workspace --bins
cargo run --release -p kumi --
sh scripts/test-isolated.sh   # PowerShell: ./scripts/test-isolated.ps1
cargo run --locked --release -p ableton-mcp-server --bin ableton-mcp-benchmark
```

测试使用临时主目录。基准程序调用同目录中的分析工作进程，输出 JSON 测量结果，
超出预算时返回失败。请使用优化后的 release 构建，并避免与大型构建同时运行。
内存列统计 Rust 分配量。

在没有未提交修改的检出中，本地准备 Mac 发布包的示例：

```sh
python3 scripts/build-hands.py
MACOSX_DEPLOYMENT_TARGET=13.0 python3 scripts/build-native-release.py --target aarch64-apple-darwin --out release/native/aarch64-apple-darwin
python3 -m unittest discover -s scripts/tests -p test_native_release.py
```

辅助程序保留原来的 `packages/runtime/hands/` 路径。发布包必须同时包含服务器和
分析工作进程。各平台包的聚合、旧版本更新验证和版本号同步见
[英文版当前发布流程](../en/DEVELOPER_GUIDE.md#releasing)。普通安装无需 Node；
保留的 TypeScript 参考测试需要 Node.js 22 或 24。

以下内容介绍保留的 **TypeScript 参考实现及旧版发布流程**。

## 布局

| 文件夹 | 内容 |
| --- | --- |
| `apps/kumi` | `kumi` 命令和终端应用（`src/tui/`）；`scripts/` 存放针对模型或真实 Live 的、需要手动启用的检查 |
| `packages/runtime` | Kumi 的代理核心：`kernel/`（代理循环）、`providers/` 和 `auth/`（模型与登录）、`core/`（会话、记忆、技巧、配方、目标、匹配）、`integrations/ableton/`（Kumi 的 Live 工具）、`audio/`、`video/`、`web/`、`devices/`（Max for Live 设备）、`mcp/`（桥接客户端） |
| `apps/mcp-server` | 桥接 `@ableton-mcp/mcp-server`：一个基于 stdio 的 MCP 服务器，有自己的锁文件、测试和 CI。还包括生命周期、设置、迁移和诊断命令 |
| `remote-script` | 桥接的 Remote Script，运行在 Live 内部（`ableton_mcp_remote_script.py`、`AbletonMcpBridge/` 入口、Python 测试） |
| `apps/live-extension` | Kumi 的 Live 扩展，适用于 Live 12.4 及更高版本，基于 Live 的 Extensions SDK |
| `protocol` | `ableton-live-v1.operations.json`，桥接与 Remote Script 共用的操作注册表 |
| `scripts` | `build-release.mjs`（安装程序使用的包）和 `test-isolated.mjs` |
| `install.sh`、`install.ps1` | 安装程序 |

根目录是由 `apps/kumi` 和 `packages/runtime` 组成的 npm 工作区。桥接是刻意分开的：它独立构建、测试和打包，没有 Kumi 也能工作。

## 各部分如何通信

```text
kumi (apps/kumi, packages/runtime)
  │  MCP over stdio: Kumi starts the bridge as a child process
  ▼
bridge (apps/mcp-server)
  │  ableton-loopback/v1: authenticated TCP on 127.0.0.1
  ├──► Remote Script inside Live (remote-script/)
  │  local channel to the Extension Host
  └──► Kumi's Live extension (apps/live-extension), Live 12.4+
```

- Kumi 以 `full` 部署策略启动桥接，并附带一个只包含它所用工具的允许列表（`ABLETON_MCP_TOOL_ALLOW`）。模型直接调用少数几个桥接读取工具（`packages/runtime/src/mcp/allowed-tools.ts` 中的 `MODEL_TOOLS`）；其余的由 Kumi 自己的工具调用。
- 桥接的路由器（`apps/mcp-server/src/bridge/router.ts`）把每个操作发送给 Remote Script，或者在只有扩展具备该操作时发送给扩展。当 Live 的 Developer Mode 让 Live 不启动扩展时，桥接可以自己启动 Live 的 Extension Host。
- `kumi bridge` 通过桥接的生命周期命令把桥接安装到 Live 中，之后通过 `Remote Scripts/AbletonMcpBridge/bridge-reference.json` 找到它。

## 环境搭建

需要 Node.js 22 或 24、Python 3 和 git：

```sh
npm ci
npm run build
npm ci --prefix apps/mcp-server
npm run build --prefix apps/mcp-server
npm test
npm test --prefix apps/mcp-server
```

检出与已安装的 Kumi 共用 `~/.kumi`（设置、登录信息、对话、桥接的状态）。`--allow-dirty` 允许 `kumi bridge` 从带有未提交修改的检出中安装桥接。在 Windows 上，如果没有开启开发者模式、也没有使用提升权限的 shell，创建符号链接的测试会跳过或失败；CI 的运行器可以创建符号链接。

## 开发 Kumi

**一个修改类型**（一种拥有自己的 HISTORY 行和撤销的修改）是 `BASE_CHANGES`（`packages/runtime/src/integrations/ableton/changes.ts`）或 `MORE_CHANGES`（`more-changes.ts`）中的一个条目，`CHANGES` 把两者合并起来。条目包括：Kumi 的工具名称、桥接的 preview 和 apply、一个 family（HISTORY 和 NOW 所绘制的一组固定图形之一）、给模型的描述，以及把预览转成通俗文字的 `summarize`。如果较旧的桥接会拒绝它，就给它加上 `since`（它适用的第一个桥接版本，定义在 `bridge-version.ts` 中）；如果 Live 没有办法撤回它，就加上 `permanent`。测试会检查每个修改类型：工具唯一、只凭最简的预览也能得出标题、描述绝不要求模型确认，以及所用的桥接工具仅限宿主使用。在提供它之前，先在真实 Live 上运行它及其撤销（`accept:live`）。

**一个动作**（不是对工程的修改、没有可撤销的内容，比如播放）放在 `actions.ts` 的 `ACTIONS` 中。

当桥接的工具发生变化时，重新生成修改评估所用的合成桥接：`node apps/kumi/scripts/make-bridge-tools.mjs`（需要已构建的桥接）。

终端应用的设计和基础见[命令、按键与界面](KUMI_TUI.md#设计说明)。

## 开发桥接

| 路径 | 说明 |
| --- | --- |
| `src/host.ts` | MCP 分发、严格的工具模式、事务、撤销与恢复 |
| `src/tool-catalog.ts` | 唯一的工具目录：模式、注解、每个工具所需的能力，以及它的部署策略类别 |
| `src/live.ts`、`src/registry.ts` | Live 类型与适配器；注册表及其哈希的加载与验证 |
| `src/bridge/` | 经过认证的回环客户端（`remote-adapter.ts`）、路由器，以及扩展的通道、启动器和文件夹 |
| `src/transactions/` | 批处理、设备状态、Session MIDI 和发现辅助工具 |
| `src/mcp-protocol.ts`、`src/stdio.ts` | 两个协议版本的 MCP 传输处理 |
| `src/analysis*.ts`、`src/audio-*.ts`、`src/reference-analysis.ts` | 在隔离的 worker 中进行音频分析 |
| `src/delivery.ts`、`src/lifecycle*.ts`、`src/setup.ts`、`src/migrate.ts`、`src/diagnostics.ts` | 配置、密钥、安装、升级、回滚与诊断 |
| `src/als.ts`、`src/project*.ts`、`src/library-search.ts` | 已保存的工程、工程快照与差异、Live 的库数据库 |
| `src/follow-actions.ts` | 可选的 [Willington](WILLINGTON_INTEGRATION.md) Follow Actions |

**契约规则。**

- 传输协议是 `ableton-loopback/v1`：规范 JSON（键排序、负零归一化）、请求和响应上的 HMAC-SHA256、有界的帧和集合、序列号，以及每次 Remote Script 启动时都会改变的 epoch。详情见 `remote-script/README.md`。
- `protocol/` 中的注册表是唯一的操作列表。宿主和 Remote Script 各自计算它的哈希，两者必须一致，否则 Live 永远不会连接；有一个宿主测试会运行 Remote Script 的哈希计算，确保两者相等。绝不要把操作名称或哈希复制到其他源文件中。修改注册表后，在 `apps/mcp-server` 中运行 `npm run capability:manifest`。
- 修改通过各有专门用途的操作进行，每个操作都有预览、应用和撤销。唯一的例外是 `python.run`（`live_run_python`），它在 Live 的主线程上运行 Python，唯一的回退方式是 Live 的撤销；它有自己的策略类别 `python`，只有 `full` 配置文件允许使用。
- 桥接内部的 `get(ref)` 是基于固定行的有界序列化器，而不是 Live 对象模型的通用读取器；MCP 读取保持各有专门用途。
- Remote Script 在 Live 的主线程上完成它与 Live 打交道的全部工作：它在 Live 的显示刷新周期内、在限定的时间预算内自己处理套接字。它仅有的其他线程用于写入诊断文件和接收实时 UDP。新的 epoch 会使之前的所有引用和游标失效。Remote Script 无法识别的 Live 结构会被报告为不可用，绝不伪造。
- stdout 只承载 MCP 协议。诊断信息输出到 stderr，且不含请求数据。
- 基于进程的适配器是异步的（`snapshotAsync`、`invokeAsync`、…），而共享接口和模拟器仍有同步方法；`McpHost.handleAsync` 是基于进程的工具所走的路径。在同步接口移除之前，兼容性改动要针对两者测试。
- 测试绝不需要正在运行的 Live、某个设备、某台特定的机器或仅限本地的材料。每个新操作都要有测试，包括错误输入和恢复。

**MCP 版本。** 桥接同时支持 `2025-11-25`（先 initialize，再发请求）和 `2026-07-28`（每个请求的 `params._meta` 带有协议版本和客户端能力，另有 `server/discover`）；一个进程只使用其中一种。未知版本返回 `-32022`；错误的元数据返回 `-32602`。新版本的结果带有 `resultType: "complete"`，并且也会在 `structuredContent` 中返回 JSON。新版本没有推送：`live_subscribe` 只在旧版本中可用，新版本的客户端需要轮询。客户端元数据绝不会授予对 Live 的访问权限。请见[规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)。

## 开发 Live 扩展

`apps/live-extension` 基于 Live 的 Extensions SDK 构建，而这个 SDK 的许可证禁止再分发，所以它不在仓库中：请把一份副本放到仓库根目录的 `vendor/ableton-extensions-sdk-1.0.0-beta.1/`（构建会读取其中的 `package 3/dist/index.cjs`）。`apps/live-extension` 不属于根工作区：在该目录中运行 `npm ci`，然后运行 `npm run build`，它会写出 `dist/extension.js` 及其 `.sha256`；两者都要提交。没有 SDK 时，构建会停止，已提交的包保持不变；测试会根据校验和检查这个包。关于 Live 如何运行该扩展的测量数据，见[证据](../evidence/live-extension.md)。

## 发布

**提交**的标题用通俗的英文，说明对制作人来说改变了什么（“Kumi: talk to it while it works”）。桥接或 Remote Script 的修改要提升 `apps/mcp-server/package.json`（及其锁文件）的版本，标题以新版本开头（“Bridge 1.0.71: …”），提升 `apps/kumi/scripts/eval-changes.mjs` 中假桥接的版本，并在 `CHANGELOG.md` 的 `## Unreleased` 下添加一个 `### Bridge x.y.z` 块。如果桥接的工具变了，重新生成 `apps/kumi/scripts/bridge-tools.json`；如果扩展变了，重新构建并提交它的包。工作在分支上进行，通过拉取请求合并到 `main`。

**一次 Kumi 发布：**

1. 在分支上，用一个标题为 “Kumi X.Y.Z: the changelog, READMEs and versions” 的提交完成以下改动：在根目录的 `package.json` 和锁文件、`apps/kumi/package.json`（它的版本及其 `@kumi/runtime` 依赖）、`packages/runtime/package.json` 和 `packages/runtime/src/version.ts` 中设置版本（有一个测试确保这四处相等）；更新三个 README 中当前状态（Status）的那一行；更新三个 `KUMI_CHANGES.md` 中“桥接版本”（Bridge versions）下说明随附哪个桥接的那一行；并把 `CHANGELOG.md` 的 `## Unreleased` 改为 `## X.Y.Z — date`，加上一行说明它随附哪个桥接。
2. 用标题为 “Kumi X.Y.Z (#PR)” 的合并提交合并该拉取请求。
3. 给合并提交打上标签 `vX.Y.Z` 并推送该标签。Installer 工作流会构建包，在 macOS、Linux 和 Windows 上测试安装，并把 `kumi.tar.gz`、`kumi-release.json` 和 `SHA256SUMS` 附加到名为 “Kumi X.Y.Z” 的草稿发布中。
4. 撰写发布说明并发布该版本。只有在此之后，安装程序、`kumi update` 和更新检查才能看到它。

`kumi-release.json` 记录了构建该包所用的确切 Node 24 版本，安装程序会从 nodejs.org 下载这个 Node，与 Kumi 放在一起。如果某个版本换到了新的 Node 主版本，`kumi update` 会请用户重新运行安装程序。

**桥接**没有单独的发布：它随每个 Kumi 版本一起发布，`main` 上的每次 CI 运行都会把一个打包好的候选版本保留 90 天。[分发](DISTRIBUTION_POLICY.md)介绍了一个发布版本包含什么，以及如何检查。

## 文档

`docs/en` 中的每篇文档在 `docs/ja` 和 `docs/zh-CN` 中都有日文和中文版本，README 也有 `README.ja.md` 和 `README.zh-CN.md`。对其中一种语言的修改，要在同一个拉取请求中同步到全部三种语言。桥接的文档（它的 README，以及 `apps/mcp-server/scripts/release-documentation.mjs` 中列出的十四篇 `docs/en` 页面）会随桥接一起打包，所以它们的名称是固定的，链接也必须能够解析。`apps/mcp-server` 中的检查（见[测试](TESTING.md#文档)）会核对文档中写明的 Node 版本、三种语言的用户指南列出的工具名称，以及文件数量。

## 前人的工作

桥接最初是在其他 Ableton MCP 服务器的基础上开始的：[bschoepke/ableton-live-mcp](https://github.com/bschoepke/ableton-live-mcp)、[uisato/ableton-mcp-extended](https://github.com/uisato/ableton-mcp-extended)、[Simon-Kansara/ableton-live-mcp-server](https://github.com/Simon-Kansara/ableton-live-mcp-server)、[jasper-zheng/ableton-sdk-mcp](https://github.com/jasper-zheng/ableton-sdk-mcp) 和 [ahujasid/ableton-mcp](https://github.com/ahujasid/ableton-mcp)。
