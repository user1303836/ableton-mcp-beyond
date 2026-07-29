# 能力与证据矩阵

[English](../en/CAPABILITY_MATRIX.md) · 简体中文 · [日本語](../ja/CAPABILITY_MATRIX.md)

本矩阵是各平台域与北极星旅程的版本控制事实来源。"已实现"绝不意味着
"已在所有外部环境证明"。证据范围是显式的:

- **unit/property/simulator** —— 仅确定性仓库契约;
- **packaged fake-Live** —— 已安装 tarball、已认证跨进程桥接、刻意的
  fake Live 来源;
- **real-Live** —— 在指定一次性 Live 环境中的已认证 Remote Script 观察;
- **host matrix** —— Node/软件包/生命周期行为,绝不是 Windows Live。

安全等级:**R** 只读;**G** 绑定修订/epoch 的预览-确认-验证变更;
**A** 带输出/录音门与独立停止的可发声或录音;**RT** 短时实时授权;
**FS** 绑定所有者/允许列表的文件系统变更;**P** 同意/隐私敏感的音频;
**D** 交付与安装授权。

## 基础与控制域

| 域 | 公开 API / 规范操作 | 实现与安全 | 主要测试 | 平台 / 生产证据 | 文档与已协商限制 |
|---|---|---|---|---|---|
| MCP 传输与宿主 | initialize、tools/resources/prompts、stdio JSON-RPC | `host.ts`、`stdio.ts`、`framing.ts`;R/G;有界帧、工作、速率、取消、顺序 | `host.test.ts`、`stdio.test.ts`、`framing.test.ts`、属性/基准 | Node 22/24/25 宿主矩阵已配置;打包 fake-Live 旅程;需要精确 SHA 结果 | `DEVELOPER_GUIDE.md`、`OPERATIONS.md`;无通用变更工具 |
| 规范 Live 契约 | `ableton-live/v1`、操作注册表、清单/哈希 | `registry.ts`、`live.ts`、Python 映射器;R/G/A/RT;严格模式与单一规范摘要 | `registry.test.ts`、Python 契约测试、软件包/候选验证器 | 历史 macOS 真实 Live 协商使用旧注册表摘要;需要当前摘要的精确候选证明 | `DEVELOPER_GUIDE.md`、`LIVE_SAFETY.md`;不支持的形态保持不可用 |
| 已认证桥接 | status/snapshot/discover/get 加用途特定操作 | `remote-adapter.ts`、Python 监听器;回环挑战、HMAC、epoch/序列/截止时间栅栏 | `registry.test.ts`、`live.test.ts`、软件包旅程 | 打包 fake-Live 与 macOS 真实 Live | `OPERATIONS.md`、`RECOVERY.md`;无远程网络模式 |
| 引用、发现、选择 | set、track/return/main、scene、slot、clip、note、locator、device、parameter、routing、playback、selection | 注册表 + 映射器遍历;R;父级作用域引用/游标/修订;选择复用规范可解引用的 track/scene/slot 引用 | registry、host、Python 测试 | `phase-3-readonly-live-discovery.json` 及后续真实 Live 阶段证据 | `USER_GUIDE.md`;陈旧引用/epoch 被拒绝 |
| 走带、循环、节拍器、插入、预备拍 | `transport.set`、走带 preview/apply/undo | 宿主事务 + 映射器;播放可改变时为 G/A | host/Python/软件包旅程 | `phase-5a-transport-clip-live.txt`(macOS 真实 Live) | `LIVE_SAFETY.md`;需要新鲜播放/录音状态 |
| Session 试听与紧急停止 | `session.audition-launch/stop`、`session.emergency-stop`、播放发现 | 专用宿主/映射器事务;A;不可预测令牌、精确目标、重放、自有停止 | host、Python、软件包旅程 | `phase-4-guarded-audition.json`,外部保留精确候选只读状态 | `LIVE_SAFETY.md`、`RECOVERY.md`;外部播放绝不声称自有 |
| Session 结构 | track/scene 创建/删除/重命名,clip/device/locator 重命名;slot 与 Session clip 发现 | preview/apply/undo 管理器 + 映射器;G;插入索引在变更前对照常规轨道与场景有界检查 | host/Python/软件包旅程 | 真实 Live phase 5 证据;打包 fake-Live | `USER_GUIDE.md`;创建绝不把 return/main 轨道当作常规轨道插入位置;group/return/main 编辑只在存在规范操作时暴露 |
| Session MIDI 剪辑与音符 | `clip.create/delete`、单音符 `note.add`、原子 `note.add-batch`、`note.update/delete`、Session MIDI preview/apply/undo | `session-midi.ts`、host、映射器;G;稳定音符身份、每剪辑创建一次有界原生批处理、补偿 | `session-midi.test.ts`、host/Python/软件包旅程 | 历史真实 Live 阶段覆盖当时的基本生命周期;当前契约与表情生命周期是打包 fake-Live,待精确候选真实 Live 证明 | `USER_GUIDE.md`;音高、力度、通道、时长、概率、偏移、释放力度、静音均可协商 |
| 高级 MIDI / MPE | 概率、力度偏移、释放力度、静音(在暴露处) | 音符模式与映射器;G | registry/host/Python 旅程测试 | 表情字段仅在打包 fake-Live 证明;当前候选真实 Live 证明待定;逐音符 MPE 压力/滑音/调音不可用 | `USER_GUIDE.md`;扩展点是规范音符模式加已协商映射器操作,绝不虚构字段 |
| Session 捕获 | `session.capture-midi`、`scene.capture` | 宿主 preview/apply/幂等/受护栏撤销事务,加映射器 preflight、不可变对象身份删除栅栏与新鲜修订/回读;G/A | host/Python/软件包旅程 | 真实 Live phase 5 证据 | `LIVE_SAFETY.md`;捕获结果必须可重新发现;MIDI 捕获仅在所有 Session 槽位为空时宣告,因此原生失败清理无法改变预先存在的剪辑内容 |
| Arrangement 导航与剪辑 | arrangement 发现;clip 创建/复制/移动;事务自有清理;locator 添加/删除 | 宿主事务管理器 + 映射器;G | host/Python/软件包旅程 | `phase-5cd-clip-arrangement-live.txt` 加当前测试 | `USER_GUIDE.md`;任意 Arrangement 删除被拒绝;精确创建身份+指纹清理仅适用于创建/复制;移动隔离源/目标内容并使用精确逆移动恢复,绝不产生删除授权,并为事务创建的源消费任何先前清理令牌 |
| 音频剪辑属性 | `audio.clip.set` 中逐字段协商的增益、音高、循环、warp 开关/模式与淡化;有界 warp 标记回读 | host/registry/映射器;G;每个请求字段必须出现在该精确剪辑的 `availableAudioFields` 中 | host、registry 与 Python fake-Live 测试 | 真实 Live phase 5cd 证明了对 MIDI 目标的安全拒绝,而非成功的音频编辑 | `USER_GUIDE.md`;成功的当前候选真实 Live 音频编辑以及 warp 标记编辑/take 通道/comp API 仍未证明或不可用;标记回读绝不意味着编辑授权;保留的规范 `audio.warp-marker.*`、`audio.take-lane.read`、`audio.comp.read` 契约在可执行前保持不宣告 |
| 自动化 | 剪辑包络与点的创建/读取/插入/删除/恢复 | host + 映射器;G,绑定父级/修订 | host/Python/软件包旅程 | `phase-5e-mixer-automation-live.txt` | `USER_GUIDE.md`;观察到的 API 中 Arrangement 自动化/调制不可用;严格的 `arrangement.automation.*` 契约经注册表测试,在可执行前保持不宣告 |
| 混音器、发送、返回、编组、cue | 带精确行修订的混音器发现/设置 | host + 映射器;G/A | host/Python/软件包旅程 | `phase-5e-mixer-automation-live.txt` | `LIVE_SAFETY.md`;只改变已发现的可写字段;不推断消除削波 |
| 路由、监听、arm | 路由选择发现、`routing.set` | host + 映射器;G/A;反馈拒绝、精确路由、arm/监听栅栏 | host/Python/软件包旅程 | `phase-6cd-routing-recording-live.txt` | `LIVE_SAFETY.md`;需要操作者准备的捕获路由 |
| Session/Arrangement 录音 | `recording.session`、`recording.arrangement` preview/apply/stop | host + 映射器;A;精确先前录音状态、armed 目标与输出安全授权在映射器中原子复检;已验证停止 | host/Python/软件包旅程 | `phase-6cd-routing-recording-live.txt` | `LIVE_SAFETY.md`、`RECOVERY.md`;无无界录音命令 |
| 设备层级 | devices、racks、chains、drum pads、macros、parameters | 递归展平的父级作用域嵌套设备/参数发现,加设备/参数事务;G/A | host/registry/Python/软件包旅程 | `phase-6ab-devices-browser-live.txt` | `USER_GUIDE.md`;macro 变体与侧链字段只在 Live 暴露时报告 |
| 设备生命周期与参数 | 插入/启用/移动、事务自有清理、有界已发布参数设置/撤销 | host + 映射器;G;变更绑定精确设备、所有者、轨道、同级顺序、状态与创建指纹(如适用) | host/Python/软件包旅程 | `phase-6ab-devices-browser-live.txt` 加当前测试 | 任意设备删除与插件 UI 控制不受支持;清理限于精确的事务创建设备;插入/加载保守地限于空设备所有者,使清理不影响无关同级 |
| 预设与第三方插件 | 精确 Browser 条目检查与仅设备加载;发现后的已发布参数 | browser/device 事务;G;非设备结果在变更前被拒绝;所有权/可用性是操作者事实 | journey/host/Python 测试 | 打包 fake-Live;macOS 真实 Live 中的原生 Browser 加载 | 精确的第三方预设工作流与 UI 自动化未认证;扩展点是已发现 Browser 身份 + 已发布参数 |
| Browser | 搜索/过滤/检查,加精确的仅设备加载 | host + 映射器;R/G;加载前复检检查栅栏 | host/Python/软件包旅程 | `phase-6ab-devices-browser-live.txt` | 没有权威 preview/stop API 时 Browser 音频预览/停止不可用;严格的 `browser.preview.start/stop` 契约作为未宣告扩展点测试 |
| 工程与文件 | 工程信息、清单、缺失媒体元数据、已验证同地备份 | `project.ts`;R/FS;调用方允许根、`.als` 内容标记、有界文件、无媒体读取、原子哈希验证复制 | `project.test.ts`、host/Python 阶段测试 | `phase-7a-project-ops-live.txt` | 规范 `project.new/open/save/save-as/collect/export/bounce` 扩展 ID 存在,但在适配器能执行并验证前保持不宣告且不可调用 |
| 订阅/事件 | 已认证 subscribe/unsubscribe,支持已产生的 `transport`、`object`、`reset` 事件;有界事件队列 | adapter/映射器;R;签名的绑定 epoch 事件携带 epoch;未送达相邻合并保持连续性;真实溢出发出 reset 事件 | loopback/Python/软件包旅程 | `phase-7b-subscriptions-live.txt` | 不支持的状态/电表/Max/OSC 事件过滤被拒绝而非静默接受;epoch 变化、reset 或序列缺口要求重新快照;事件不是变更授权 |
| UDP/OSC/XY/Max 数据包兼容实时 | realtime arm/disarm/stats;有界 JSON、OSC、XY 与 `max` 标签数据包入口 | 映射器实时平面;RT/A;令牌/TTL/源/通道/速率/队列/代际栅栏,加每个 Live 线程数据包上复检的精确参数、所有者、轨道、路径与同级身份;诚实的 `ableton://max-extension` 资源 | host/Python/软件包旅程 | `phase-7c-realtime-live.json` | 运行时宣告 OSC/realtime,而非 `max` 能力。数据包标签只是扩展格式;不声明捆绑 Max 设备、握手、`.amxd` 或任意数据包授权 |
| 紧急恢复 | Session 紧急停止、捕获紧急停止/状态、实时 disarm | 用途特定的独立授权;A/RT/P;Session 紧急停止原子清除剪辑播放、走带与两种录音模式 | host/Python/软件包/重启测试 | 真实 Live phase 4、7c、8 | `RECOVERY.md`;不确定变更绝不自动重放 |

## 音频智能与隐私

| 域 | API / 实现 | 安全 | 测试与对照 | 生产证据 | 限制 / 文档 |
|---|---|---|---|---|---|
| PCM 分析 | `audio_analyze`;`analysis.ts` 与一次性 worker 运行器 | P;有界输入/时间/内存/输出、取消、密钥剥离 worker、结果无原始 PCM | analysis、worker、property、benchmark 测试 | 打包本地分析 | `AUDIO_INTELLIGENCE.md`;所供 PCM 的关系由调用方声明 |
| 波形/频谱/时频/瞬态/相位/动态 | `pcm-analysis/v2` 聚合摘要 | P/R | 确定性夹具与边界 | 打包旅程 | 有损聚合证据,不是源重建或母带判定 |
| 响度/LRA/真峰值 | `audio-standards.ts`、BS.1770-5 / EBU R128/Tech 3341/3342 | P/R | `phase-8-audio-oracle.json` 中的独立 FFmpeg 对照 | 打包分析 | 真峰值仅在 44.1/48 kHz 验证;沉浸式/对象布局不可用 |
| 参考对比 | `audio_compare_reference`;有界重采样、对齐、电平匹配 | P/R | `reference-analysis.test.ts`、property/benchmark | 打包参考旅程 | 32–96 kHz 输入;歧义通过扣留重叠、跨源差值与增益建议而故障关闭,同时保留各自分析;不推断法律/来源关系 |
| 信号链诊断 | `diagnoseAudioWithLiveContext` | R/P;精确引用、非因果语言 | diagnosis/host 测试 | 打包旅程与 phase 8 | 测量不证明某设备造成了差异 |
| Live 音频捕获 | 受护栏 Session Resampling 开始/状态/停止/清理/紧急停止 | A/P;同意、源/目标身份、看门狗、媒体身份/解除链接、状态恢复 | capture host/file/Python/软件包恢复测试 | macOS Live 12.4.5b8 上的 `phase-8-audio-live.json` | 不声明原生 PCM 分接;需要已保存 Set、WAV、安全路由与真实 Live 来源 |

## 北极星用户旅程

所有旅程计划都是用途特定工具之上的只读创作层;不授予变更授权。

| 旅程 | 工具/资源/提示词与实现 | 关键路径 | 打包证据 | 真实 Live / 平台状态 | 权利、无障碍、回退 |
|---|---|---|---|---|---|
| 创建节拍或歌曲 | `plan_user_journey`、`ableton://journeys`、`create_beat_or_song`;`journeys.ts` | MIDI/结构/Arrangement/试听预览与精确确认 | `phase-9-journeys-packaged.json` | 受护栏原语有 macOS 真实 Live 阶段证据;完整组合旅程是打包 fake-Live | 仅高层特征;不可用的 Arrangement 阶段重新规划/回退 |
| 编排进阶鼓组 | `sequence_advanced_drums` | Session MIDI 创建、表情修订、试听、回读 | phase 9 打包证据 | MIDI/试听原语在 macOS 观察到 | 不虚构套件映射;仅操作者自有/已发现映射 |
| 设计自有/原生音色 | `design_owned_sound` | Browser 加载、已发现参数塑形、试听/恢复 | phase 9 打包证据 | Browser/设备原语在 macOS 观察到 | 不虚构所有权、插件可用性、预设或艺人身份 |
| 对比参考混音 | `compare_reference_mix` | 本地标准/参考分析、可选受护栏捕获/混音器假设与恢复 | phase 9 打包证据 | 捕获原语在 macOS 观察到;本地分析跨平台 | 无精确复制/法律许可声明;不保留原始音频 |
| 诊断演出/录音设置 | `diagnose_performance_setup` | 路由/混音器预览、有界录音、可选实时、最终恢复 | phase 9 打包证据 | 组成原语在 macOS 观察到 | 没有权威 API 时延迟保持未知;实时/捕获需要真实 Live |
| 旅程内的 Session/Arrangement 编辑 | 创建/歌曲与鼓组计划中的阶段 | 现有用途特定剪辑/定位点/自动化工具 | phase 9 打包证据 | phase 5–6 的组成真实 Live 证据 | 不支持的 Arrangement 自动化与 comp 工作流保持不可用 |

## 交付、兼容性与无障碍

| 域 | 实现 / 安全 | 测试与证据 | 支持状态 | 限制 / 文档 |
|---|---|---|---|---|
| 发布产物 | 严格 77 路径 npm tarball、发布清单、负载角色/哈希、MIT 许可证 | `package:verify`、候选与 Python 绑定器、全新克隆字节比对 | 精确 SHA 本地 tarball;未发布到 npm | `DELIVERY.md`;未签名、未公证 |
| 安装/激活 | `ableton-mcp-lifecycle` 回执/日志/锁;D/FS | 生命周期单元 + 已安装候选矩阵;激活要求真实 Live 与完整的回执绑定软件包 | macOS 15 与 Windows Server 2025 宿主契约,以精确 SHA CI 为条件 | Windows Live/Windows 11 激活未认证;`DELIVERY.md` |
| 升级/修复/回滚/卸载 | 精确的更新产物、隔离/保留清理、精确先前代际、owner-only 清除 | 生命周期单元、候选 OS 矩阵(含 Windows ACL/联接点/占用文件用例) | 托管精确 SHA 结果前仅为宿主契约 | 无原生安装器;操作者必须停止/重启 Live |
| Node/OS 兼容性 | Node 22/24/25;Ubuntu 24.04、macOS 15、Windows Server 2025 工作流 | 完整 Node 测试加精确已安装候选;Python 3.11 映射器 | 有条件;见当前检查结果 | Linux 无 Live 声明;Windows 11 不继承自 Server |
| 键盘操作 | 服务器 stdio 与生命周期 CLI 只需要键盘/stdin;有序文本状态 | 打包旅程与候选 CLI 测试 | 服务器自有文本边界 | 第三方客户端、终端与 Live 拥有焦点行为 |
| 屏幕阅读器 | 无服务器自有视觉 UI;语义文本与非颜色状态 | 仅契约检查,不是 VoiceOver/Narrator 交互证据 | **未认证** | VoiceOver、Narrator、Live、插件与 MCP 客户端行为需要单独的交互平台证据;`USER_JOURNEYS.md`、`SUPPORT_MATRIX.md` |
| 签名/发布 | 显式不可用诊断与策略 | 软件包/候选策略断言 | 不适用于当前本地 tarball 渠道 | 需要授权身份与单独的渠道决策 |

## 证据新鲜度规则

受跟踪的阶段证据证明指定的历史阶段与环境。它不会被静默提升到后来的
产物。最终就绪还要求:推送头的 CI 产物元数据、精确候选宿主结果,以及
命名同一 Git SHA 与产物 SHA-256 的外部保留真实 Live 观察。Windows
Server 宿主证据绝不填充 Windows Live/Windows 11 单元格。
