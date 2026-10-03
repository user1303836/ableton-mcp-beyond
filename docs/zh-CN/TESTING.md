# 测试

[English](../en/TESTING.md) · 简体中文 · [日本語](../ja/TESTING.md)

如何运行仓库各部分的测试、它们需要什么，以及 CI 运行什么。所有常规测试都不需要 Live，也不需要登录。

## 快速开始

在源码副本中，使用 Node 22/24（推荐 Node 24 LTS）：

```sh
npm run setup                                   # 安装并构建所有内容
npm test                                        # Kumi：应用、运行时和 Live 扩展
(cd apps/mcp-server && npm test)                # 桥接
python3 -m unittest discover -s remote-script -p 'test_*.py'   # Remote Script
```

有些检查需要 Node 以外的东西：

| 需要 | 用于 |
| --- | --- |
| PATH 上的 Python 3（`python3`，在 Windows 上为 `python.exe`；CI 使用 3.11） | Remote Script 测试、`package:verify`、`journey:verify` |
| PATH 上的 `ffmpeg` | `audio:oracle` |
| 在 `vendor/` 中本地提供的 Extensions SDK | 构建 Live 扩展或对其做类型检查（它的测试不需要） |

在 Windows 上，有几个测试会创建符号链接，这需要开发人员模式或管理员账户。没有这项权限时，其中一些会跳过，少数会以 `EPERM` 失败；CI 的 Windows 运行器具有这项权限。

## Kumi

在仓库根目录运行。

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | 先构建运行时，再对应用和运行时做类型检查 |
| `npm test` | 先构建，再运行应用、运行时和 Live 扩展的测试 |
| `KUMI_TEST_BRIDGE=1 npm test` | 同上，但桥接互操作测试为必需而不是跳过；需先构建桥接（`npm run setup` 会构建） |

`npm test` 为测试提供独立的主目录：`HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`XDG_CONFIG_HOME` 和 `KUMI_HOME` 都指向一个全新的临时文件夹，`KUMI_REMOTE_SCRIPTS_DIR` 和 `KUMI_LIVE_EXTENSIONS_DIR` 则被移除，因此任何测试都无法触及你的 Live 文件夹或 `~/.kumi`。

## 桥接

在 `apps/mcp-server` 中运行过 `npm ci` 之后，在该目录中运行。

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | 对桥接做类型检查 |
| `npm test` | 先构建，逐个运行每个测试文件，然后运行脚本测试：发布文档、能力清单、文档漂移和 CI 保留期 |
| `npm run property-test` | 在生成的音频上对音频分析做属性测试：有界、有限、结果中没有原始 PCM |
| `npm run coverage` | 带 V8 覆盖率的测试：总体至少 85% 的行、65% 的分支和 84% 的函数，每个模块都有下限，delivery、lifecycle、host、remote-adapter、project 和 Session MIDI 的门槛更高 |
| `npm run benchmark` | 在最大音频输入下测量延迟，不插桩；不属于 `npm test` 或覆盖率 |
| `npm run audio:oracle` | 在生成的音频上，把响度和真峰值的测量结果与 FFmpeg 的 `ebur128` 对比 |
| `npm run compatibility` | 先运行 `policy:verify`（检查 package.json、CI 和文档中的 Node 策略），再检查当前的 Node 和系统 |
| `npm run package:verify` | 打包桥接，安装该 tarball 并进行检查（见下文） |
| `npm run journey:verify` | 安装打包好的桥接，并通过它针对假 Live 走完五个用户旅程 |
| `npm run capability:manifest` | 注册表变化后重新生成 `docs/evidence/capability-manifest.json`；有测试会对比它 |

`package:verify` 会拒绝其列表之外的任何文件，检查 `release-manifest.json` 中的每个哈希，并检查 `LICENSE.md` 与仓库中的一致。然后，它在两代 MCP 协议下启动已安装的服务器，运行 `setup`、`migrate` 和 `diagnostics`，在名称含空格和非 ASCII 字母的文件夹中运行生命周期（安装、一次连不上 Live 的激活、修复、一次被拒绝的回滚、卸载），并让已安装的 Remote Script 针对假 Live 应答一次经认证的探查。`ABLETON_MCP_ARTIFACT=<tarball>` 让 `package:verify` 和 `journey:verify` 检查指定的 tarball，而不是自己打包。

## Remote Script

在仓库根目录运行：

```sh
python3 -m unittest discover -s remote-script -p 'test_*.py'
python3 -m compileall -q remote-script/AbletonMcpBridge
```

这些测试针对假 Live 对象运行 Remote Script，覆盖：认证、顺序控制、主线程队列、注册表及其哈希、探查、事务、捕获与实时安全，以及可选的 Willington 提供方。

## Kumi 的 Live 扩展

根目录的 `npm test` 会运行 `apps/live-extension/test`，它针对假 Live 加载已提交的 `dist/extension.js`，并对照记录的 sha256 检查它。构建扩展（在 `apps/live-extension` 中运行 `npm run build`）需要 `vendor/` 中的 Extensions SDK；没有 SDK 时，已提交的构建保持原样。重新构建之后，请把 `dist/extension.js` 连同它的 `.sha256` 一起提交。

## 需要 Live 或模型的检查

这些检查需要主动运行。它们会改动真实的东西或消耗真实的 token，所以 CI 不运行它们。

| 命令（在根目录运行） | 需要 | 作用 |
| --- | --- | --- |
| `npm run accept:live --workspace @kumi/app -- --set "<Set>"` | 打开了某个工程的一次性副本的 Live | 做出 Kumi 能做的每一类修改，用 Kumi 的撤销逐一撤销，播放、并轨、聆听和观看，并测量读取大型工程的耗时。不使用模型。 |
| `npm run eval:changes --workspace @kumi/app [-- <case>, <case>]` | 你的登录和模型 | 检验模型如何使用 Kumi 的工具，针对一个带有真实桥接工具 schema 的合成桥接进行。从不触及 Live。每个用例给出所用时间、其中工具所占的时间，以及调用模型的次数；`EVAL_EFFORT` 设置模型的推理强度，`EVAL_TRACE=1` 逐一打印每次调用。 |
| `npm run probe:inference --workspace @kumi/app` | 你的登录 | 用一个无害的工具发送一次经认证的请求。从不触及 Live。 |

桥接的工具变化之后，运行 `node apps/kumi/scripts/make-bridge-tools.mjs`（需已构建桥接），以刷新 `eval:changes` 使用的 schema。其中的 Operator、Saturator 和 EQ Eight 带有 Live 12.4 给它们的全部参数（从 Live 读入 `apps/kumi/scripts/live-devices.json`），并像 Live 一样运行 Kumi 自己设置参数的脚本。

桥接还有一项仅供操作者使用的捕获检查：`apps/mcp-server` 中的 `npm run audio:live-verify`。它需要一个由生命周期安装并在真实 Live 上激活的桥接、一个准备好的一次性工程，以及 `PHASE8_CLI`、`PHASE8_RECEIPT`、`PHASE8_EXPECTED_GIT_SHA`、`PHASE8_TARBALL_SHA`、`PHASE8_EXPECTED_REGISTRY_HASH` 和 `PHASE8_OUTPUT_SAFETY_PROVENANCE`（可选：`PHASE8_CONFIG`、`PHASE8_SET_NAME`、`PHASE8_LIVE_VERSION`、`PHASE8_SOURCE_TRACK_INDEX`、`PHASE8_DESTINATION_TRACK_INDEX`、`PHASE8_RECORDED_DIRECTORY`）。它在触及 Live 之前对照回执检查已安装的文件，然后录制、取消并恢复一次捕获，并还原它改动过的所有内容。

## 文档

编辑文档之后，在 `apps/mcp-server` 中（先在那里运行过 `npm ci`）运行：

```sh
npm run policy:verify
node --test scripts/docs-drift.test.mjs scripts/release-documentation.test.mjs
```

`policy:verify` 检查写明受支持 Node 版本的文档以及 README 徽章是否仍然写着 22 和 24。漂移测试检查英文、中文和日文的用户指南是否列出相同的工具，以及是否没有文件数量紧挨着清单（manifest）或 tarball 之类的词（请改为写出 `release-manifest.json`）。发布文档测试会暂存桥接打包的指南，并检查其中的每个链接。`npm run package:verify` 会在已安装的包中检查同样的指南。

## CI

每个拉取请求以及每次推送到 `main` 时，都会运行三个工作流：

| 工作流 | 作业 | 运行内容 |
| --- | --- | --- |
| **CI** | `Build exact local candidate`（Ubuntu，Node 24） | 空白字符检查；打包桥接两次（第二次在全新的克隆中）并要求字节完全相同；把 tarball 作为 `exact-local-candidate` 产物保留 90 天 |
| | `Coverage, benchmarks and the audio oracle`（Ubuntu，Node 24，与候选并行） | 桥接的类型检查、覆盖率（功能测试）、发布脚本的测试、属性测试、基准测试、`audio:oracle`、`compatibility` 和 `package:verify` |
| | `Node 22, 24 / ubuntu-24.04`、`Node 24 / macos-15`、`Node 24 / windows-2025 / candidate` 以及 `/ tests 1/4` 到 `4/4` | 桥接的类型检查和测试（在 Windows 上分为按各文件耗时均衡的四个分片；`TEST_SHARD=1/4` 选择其一）、属性测试和 `compatibility`；针对同一个 tarball 运行 `package:verify`、`scripts/verify-candidate.mjs` 和 `journey:verify`；设置、迁移和诊断 |
| | `Python Remote Script contract`（同样的三个系统，Python 3.11） | 对照 tarball 检查 Remote Script 的文件，运行 Python 测试，编译该包 |
| | `Required CI` | 只有以上全部通过时才通过 |
| **Kumi** | `Kumi / Node 22`、`Kumi / Node 24`（Ubuntu）、`Kumi / macOS / Node 24`、`Kumi / Windows / Node 24` | 根目录类型检查，构建桥接，使用 `KUMI_TEST_BRIDGE=1` 运行 `npm test`，`git diff --check` |
| **Installer** | `Build Kumi's Mac helper`、`Build the release bundle`，然后是 `Install / macOS`、`Linux`、`Windows` | 构建 Kumi 在 Mac 上使用 Live 菜单的辅助程序（通用、已签名），再构建包含它的发行包并在本地提供。在每个系统上：像制作人那样安装（在 Windows 上使用 Windows PowerShell 5.1），检查版本、`doctor` 和桥接加载，再次安装作为修复，运行 `kumi bridge --yes` 安装到一个临时的 Remote Scripts 文件夹，运行 `kumi update`（在 macOS 和 Linux 上还有 `--rollback`），以及 `kumi uninstall`。在 `v*` 标签上，`publish` 随后把发行包附加到发布版本上。 |

要合并到 `main`，`Required CI` 和四个 Kumi 作业必须通过。Installer 不是必需的。其余规则见[发布与分发](DISTRIBUTION_POLICY.md#合并门禁)。

## 通过意味着什么

通过表明代码的行为与其测试所描述的一致，各个包能在 macOS、Linux 和 Windows 上安装和运行，安装程序能在 GitHub 的运行器上工作。它并不表明 Remote Script 能在你的 Live 中加载、Live 的 API 与假对象的结构一致、任何东西听起来如何，或者某个终端或屏幕阅读器能与 Kumi 配合使用。上面那些需要主动运行的检查，以及[实现状态](IMPLEMENTATION_STATUS.md#证据)中的记录，覆盖的是真实的 Live。

## 编写测试

对于每个新的协议方法或对 Live 的修改，请添加一个证明它能工作的测试，并添加测试证明它会拒绝应当拒绝的情况：过期的引用、修订号和纪元（epoch）、过期的确认、重复使用的幂等键、超时、发送前和发送后的取消、断开连接、丢失的确认应答、部分修改、失败的补偿、期间在 Live 中做出的修改，以及撤销。在测试声称的内容中把假 Live、模拟器和真实 Live 区分开（`fake-live`、`simulator` 和 `real-live` 来源）。保持测试夹具小巧且不含隐私数据，绝不让测试触及真实的 Live 文件夹或 `~/.kumi`。
