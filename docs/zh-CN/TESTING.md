# 测试指南

[English](../en/TESTING.md) · 简体中文 · [日本語](../ja/TESTING.md)

## 确定性门禁

从 `apps/mcp-server` 串行运行:

```sh
npm ci
npm run typecheck
npm test
npm run property-test
npm run coverage
npm run benchmark
npm run audio:oracle
npm run compatibility
npm run package:verify
npm run journey:verify
npm pack --dry-run --json
```

然后从仓库根目录运行:

```sh
python3 -m unittest discover -s remote-script -p 'test_*.py'
git diff --check
git diff --cached --check
```

Node 测试编译到 `dist/`,覆盖:MCP 生命周期、模式验证、有界并发 stdio
组帧、异步适配器行为、已认证回环响应、Session 试听 preflight/apply/
stop、事务、标准响度/真峰值、有界参考对齐、密钥剥离 worker 取消/队列
限制、安全的 WAV/ASD 生命周期、信号链诊断、知情同意捕获的正常/取消
路径、属性、交付、回执驱动的安装/激活/升级/修复/回滚/卸载、旅程规划/
回退/权利/无障碍契约,以及软件包安装。`journey:verify` 安装打包产物,
只翻译允许列表中的特征,阻止身份/复制冲突,并把全部五个计划中每个
`planned` 阶段驱动到真实的工具结果。它验证阶段/状态顺序,跨任何显式
重新规划绑定事件,记录软件包 SHA-256 与终态残留,并覆盖 MIDI/结构/
Arrangement、表情音符、Browser 加载后的能力重新规划与已发布参数撤销、
标准参考分析与非因果 Live 上下文、路由/录音/订阅/实时契约、不确定性,
以及带显式 `fake-live` 来源的恢复。仅真实 Live 的捕获与宿主实时授权在
该证据中保持不可用,而不会被提升。

Python 测试覆盖:零依赖的 Control Surface 入口、规范注册表加载与哈希、
认证、排序/重放拒绝、主线程排队、fake-Live 引用、层级发现、空剪辑槽位、
依形状宣告操作、Session 播放操作、Session MIDI、定位点、结构、设备/
参数验证、轨道作用域路由选择、捕获栅栏/看门狗/紧急/清理,以及桥接拆除。
软件包验证器启动已安装的生产桥接,并检查已认证的 fake Set、场景、轨道、
子槽位与播放发现。

CI 在 Ubuntu 24.04 上构建一个干净的本地未发布 tarball,上传前运行
`package:verify`,再从全新分离的本地克隆加全新 `npm ci` 重复打包并
比对字节,记录精确 Git SHA 与 tarball SHA-256,然后在每个 Node 22/24/25
的 Ubuntu 24.04、macOS 15 与 Windows Server 2025 任务中安装同一产物。
每个候选任务验证严格清单/哈希,并演练生命周期计划/安装、不可用激活、
幂等修复、非自有回滚拒绝与卸载;Windows 还测试原生 ACL 修复、联接点
拒绝、占用文件恢复与随附的版本 2 迁移。稳定的 `Required CI` 检查只有在
候选、完整 Node/OS 矩阵与完整 Python 矩阵全部成功时才通过。这些仍是
宿主/软件包契约。

操作者专用的打包真实 Live Phase 8 验证器不是 CI 替代品。安装 `npm pack`
产物并 visibly 准备一次性 Set/输出/目标路由后,用显式证据输入运行:

```sh
PHASE8_CLI=/absolute/receipt-owned/dist/src/cli.js \
PHASE8_CONFIG=/absolute/receipt-owned/bridge-config.json \
PHASE8_RECEIPT=/absolute/receipt-owned/install-receipt.json \
PHASE8_EXPECTED_GIT_SHA=<40-hex-candidate-sha> \
PHASE8_TARBALL_SHA=<64-hex-artifact-sha256> \
PHASE8_EXPECTED_REGISTRY_HASH=<64-hex-canonical-registry-sha256> \
PHASE8_OUTPUT_SAFETY_PROVENANCE='<fresh operator observation>' \
PHASE8_LIVE_VERSION='<visible Live version>' \
  npm run audio:live-verify > /owner-only/path/phase-8-audio-live.json
```

在触碰 Live 之前,验证器要求已激活的真实 Live 生命周期回执,绑定预期的
干净 Git SHA、产物摘要、规范注册表、回执自有的 CLI/配置、发布清单摘要、
每个已安装软件包文件与每个已安装 Remote Script 文件,并拒绝多余、缺失、
链接或漂移的软件包字节。然后要求运行时 `remote-script`/`real-live`
来源与相同的注册表哈希。验证器还拒绝缺失的原始媒体目录、非空的源设备
基线、缺失的源剪辑,或目标不是 visibly 准备好的
`No Input`/未 armed/监听关闭/为空。它验证在原宿主仍然存活时取消响应
被抑制,在捕获期间杀死另一个宿主,要求映射器看门狗收尾,独立恢复,并在
失败时补偿其临时音符/混音器/设备变更。

内置的 V8 覆盖率门禁测量编译后的运行时代码(不包括独立的仅基准入口点
与墙钟基准测试 —— 后者仅在独立的 `npm run benchmark` 门禁中未插桩运行,
并有意排除在 `npm test` 与覆盖率之外),并强制总体至少 85% 行、65%
分支、84% 函数,生产模块下限,以及 delivery、lifecycle、host、
remote-adapter、project 与 Session MIDI 模块的更强阈值。插桩计时不作为
性能证据。覆盖率是回归信号,不是真实 Live、安全、恢复或平台证据的
替代品。

基准对声明的最大 PCM 输入预热并报告重复延迟测量。`audio:oracle` 生成
临时 PCM,把 BS.1770/EBU 与真峰值输出与 FFmpeg `ebur128` 比较,并移除
owner-only 临时树;不提交第三方音频。延迟、输出大小、有界内存、DSP
对照、软件包与真实 Live 证据是不同的关注点;彼此不能替代。

## 通过意味着什么

通过证明确定性的仓库行为与软件包契约。它不证明真实的 Control Surface
已在 Ableton Live 中加载、受支持的 Live API 形状、可见的 Set 状态、可
发声或实时行为、平台安装器运行时、无障碍、硬件、签名、公证或发布。

## 变更纪律

为每个新的协议方法或 Live 副作用添加成功与故障关闭测试。覆盖陈旧
epoch/游标/修订、过期确认、冲突幂等键、超时、分发前后取消、断连、
确认丢失、部分变更、补偿失败、外部编辑、外部播放与受护栏撤销。打包的
生产旅程与受跟踪的真实 Live 阶段证据必须保持 `fake-live`、模拟器与
`real-live` 来源的区别。Phase 8 证据必须包括正常捕获、受控再捕获、
取消清理、宿主重启看门狗恢复、精确基线回读与零 WAV/ASD 残留。保持
夹具有界且隐私保护。绝不打开、复制、暂存、打包或暴露受保护的本地
SDK 证据。
