# 用户指南

[English](../en/USER_GUIDE.md) · 简体中文 · [日本語](../ja/USER_GUIDE.md)

如何从 MCP 客户端安装、配置并驱动 Ableton MCP Beyond。

服务器是故障关闭(fail-closed)的:不带 `--config` 时使用
`UnavailableLiveAdapter`,绝不检查或改动 Live。只有在回环地址、密钥、协议、
操作注册表哈希与状态协商全部成功后,桥接才会被接受。

## 安装与启动

支持的运行时:Node.js 22、24、25。Node 21、23、26、27 以及未列出的/
未来主版本均不受支持。从源码检出目录:

```sh
cd apps/mcp-server
npm ci
npm run build
node dist/src/cli.js                              # 故障关闭的宿主
node dist/src/cli.js --config /absolute/path/bridge-config.json
```

唯一接受的 CLI 选项是一个 `--config PATH`。密钥、端点、适配器与能力都
**不能**通过 MCP 参数或客户端元数据选择。请用协议版本 `2025-11-25`
初始化 JSON-RPC,然后发送 `notifications/initialized`。

tarball 安装请使用 [DELIVERY.md](DELIVERY.md) 中基于回执(receipt)的
`ableton-mcp-lifecycle` 流程进行安装、激活、升级、修复、回滚与卸载。
产物采用 MIT 许可,通过本地渠道交付,未发布、未签名,并按精确路径与
SHA-256 安装。`private: true` 仅防止意外发布,不改变 MIT 权利;见
[DISTRIBUTION_POLICY.md](DISTRIBUTION_POLICY.md)。

## 只读工具

- `server_status` 与 `capabilities` 报告宿主状态与已协商的目录。
- `live_status` 报告协议、适配器、epoch、注册表哈希、操作与连接状态。
- `live_snapshot` 在协商了 `session.read` 时返回有界的 Set 快照。伪造或
  不完整 Live 形态中的回退值应视为不可用证据,而不是 Live 状态的证明。
- `live_discover` 校验所有已协商的种类,子级种类需要父级。当适配器暴露
  映射器发现能力时,它接受 `set`、`track`、`return-track`、`main-track`、
  `scene`、`clip-slot`、`session-clip`、`arrangement-clip`、`note`、
  `locator`、`device`、`parameter`、`selection`、`routing-choice` 与
  `session-playback`,支持有界父级、最多八个标量过滤器、请求字段、遍历
  预算、分页以及绑定 epoch/修订的游标。兼容回退仍限于 `track`、`scene`、
  `clip`、`note`。
- `audio_analyze` 分析调用方提供的 float32 PCM,返回有界的聚合、波形、
  频谱、瞬态、动态、削波、ITU-R BS.1770-5/EBU 响度、LRA 以及经验证的
  44.1/48 kHz 真峰值摘要。它在隔离的可取消 worker 中运行,绝不捕获 Live
  音频,也绝不返回原始采样。
- `audio_compare_reference` 比较两个有界 PCM 源:带限重采样、由粗到精
  (或显式手动/禁用)对齐、基于标准的电平匹配建议与聚合差值。自动对齐
  不可靠时,保留各自的独立分析,但重叠与比较差值将被 withheld。不返回
  对齐后的 PCM。
- `audio_diagnose_live_context` 将调用方 PCM 测量与一个新鲜的精确 Live
  轨道快照关联。该关系由调用方声明且未经核实;观察到的设备只是上下文,
  绝不断言为原因。
- `live_audio_capture_status` 在真实桥接协商了捕获提供方时为只读。它会
  隐去映射器凭据与原始文件路径。
- `plan_user_journey` 返回一个不变更的、感知当前能力的计划,覆盖节拍/歌曲
  创作、进阶鼓组、声音设计、参考对比或混音/录音/演出诊断。参见
  [USER_JOURNEYS.md](USER_JOURNEYS.md)。

## 变更工作流

所有 Live 变更都要求:已连接的协商适配器、新鲜的发现、只读预览、精确
确认、有界幂等键、epoch/修订检查,以及权威的事后验证。已实现的工作流:

- `live_device_parameter_preview/apply` —— 针对权威设备上已发现的已启用
  数值参数。检查边界、有限值、量化、归属与修订;通过 `live_undo` 受护栏
  撤销。
- `live_session_structure_preview/apply` —— 有界的命名 MIDI/音频轨道与
  场景创建。插入索引仅对应常规轨道,并在变更前对照当前集合检查。既有
  对象、剪辑、设备、路由、走带与录音均不受影响。
- `live_midi_clip_preview/apply` —— 在空的 Session 槽位中创建有界 MIDI
  剪辑(含归一化音符)。应用时创建剪辑,通过一次规范的 `note.add-batch`
  变更提交完整校验过的音符集,然后验证权威音符内容。
- `live_arrangement_section_preview/apply` —— 在有界且不冲突的范围内创建
  两个命名定位点。
- `live_tempo_preview/apply` —— 有界的速度变更。
- `live_undo` —— 撤销一个 epoch 与已验证事后状态仍匹配的事务,或在
  epoch 未变时对确认丢失的撤销进行精确键对账。
- `live_recovery_finalize` —— 仅在具备明确的权威人工恢复证据后,注销受
  恢复保护的记录。它绝不变更 Live,拒绝活跃的 audible 工作,并在遗忘
  记录前注销 Remote Script 的重放权。
- 当各自精确操作已协商时,可用的还有:用途特定的剪辑启动/停止、走带、
  音符更新/删除、剪辑复制/移动/重命名/属性、轨道/场景/设备/定位点重命名、
  Arrangement 剪辑创建/移动与文件音频导入、音频剪辑、混音器、Session 自动化、
  Browser/设备插入、路由、录音、工程备份、订阅、定位点跳转、视图与实时
  工作流。Capture
  MIDI 仅在所有 Session 槽位为空时才可协商。任意删除设备或 Arrangement
  剪辑会被拒绝,因为先前状态无法重建;只有通过 `live_undo` 的、绑定身份
  与指纹的事务自有清理才可用。
- 音频剪辑预览只接受该精确剪辑所宣告的字段(`availableAudioFields`):
  增益、音高、循环、warp 开关/模式与淡化(视支持情况)。Warp 标记仅为
  有界回读;标记编辑、take 通道与 comping 仍不可用。
- 设备发现以规范父级引用递归遍历 rack/chain。Browser 加载需要新鲜的精确
  `browser.inspect` 结果,拒绝非设备条目,并以空的设备所有者为目标,使
  任何加载失败的清理都不会影响无关的同级设备。
- `live_session_audition_preview/apply/stop` —— 一次受护栏的、可能发声的
  Session 场景启动。预览为只读,要求精确的 Set 名称、权威的停止/未录音
  播放状态、无 armed 或输入监听的轨道、安全的启动量化、可调用的
  launch/stop 操作,以及明确的输出安全证据。应用需要精确的预览确认与
  幂等键,启动一次并验证新鲜的 fired/playing 状态。停止需要返回的停止
  确认,只停止映射器拥有的播放,并验证回到停止基线。

预览记录 30 秒后过期。确认丢失、超时、断连、验证失败或补偿失败都属于
**不确定状态**。绝不要提交新的授权或新的幂等键。在同一桥接与 Live epoch
内,仍在运行的宿主只能依据 Remote Script 执行账本,对原事务、原确认、
原参数与原幂等键进行对账,然后验证新鲜的事后状态。任一 epoch 变化都应
停止变更并从新鲜的权威状态恢复 —— 参见 [RECOVERY.md](RECOVERY.md)。

## 知情同意的 Live 音频捕获

Live 音频不会通过 Remote Script 元数据暴露。仅当 `live_status` 报告
`real-live`、`audio.capture.resampling` 以及全部六个 `audio.capture.*`
操作时,捕获才可用。

1. 保存并目视检查一次性的 Set。确保所有轨道未 armed,录音与播放关闭,
   监听/输出电平安全。
2. 选择一个精确的源 Session 剪辑与一个不同的空音频槽位。目标槽位当前的
   输入路由必须可选择,以便之后恢复;当 Live 的陈旧 `Ext. In` 值不可用
   时,用常规的路由 preview/apply 工作流选择安全的 `No Input` 基线。
3. 以精确的 Set/槽位引用、一到九秒的时长、
   `consent=ephemeral-analysis-and-delete` 与新鲜的输出安全证据调用
   `live_audio_capture_preview`。
4. 审阅所披露的发声/录音影响、看门狗/恢复工具、目标基线与有效期。用
   精确的不可预测确认与新的幂等键应用一次。
5. 成功的结果包含标准分析与证据关联的诊断,但不含 PCM、路径、令牌、
   确认或原始摘要。它必须报告:走带已停止、路由/arm/监听已恢复、Live
   剪辑已精确删除、WAV/ASD 已解除链接,且没有保留原始音频。
6. 取消、宿主故障、超时或确认丢失时,从全新进程调用
   `live_audio_capture_status`。若该精确捕获未清理干净,以
   `confirmation=emergency-stop-and-clean` 与新鲜观察到的精确身份调用
   `live_audio_capture_emergency_stop`。残留状态存在时绝不要开始新的
   捕获。

DSP 标准、限制、隐私、参考对比、诊断语义与恢复细节见
[AUDIO_INTELLIGENCE.md](AUDIO_INTELLIGENCE.md)。

## 配置与安装

先构建,然后创建仅宿主的配置:

```sh
npm run setup -- --output /absolute/path/client-config.json
```

桥接配置:先单独创建一个 owner-only 密钥文件,然后运行:

```sh
npm run setup -- --output /absolute/path/bridge-config.json \
  --bridge-host 127.0.0.1 --bridge-port 9000 \
  --realtime-port 9001 \
  --secret-file /absolute/path/bridge.secret --bridge-timeout 5000
```

版本 2 会写入显式的 `--config PATH` 参数。密钥绝不放进客户端参数、软件
包、Remote Script 引用、日志或诊断中。路径必须显式、安全、非符号链接;
主机必须是回环地址;密钥必须强随机且由所有者控制。`--realtime-port`
可选,必须与已认证的 TCP 端口不同,仅启用
[REALTIME_CONTROL.md](REALTIME_CONTROL.md) 中所述的独立布防通道。

Remote Script 文件诊断默认禁用,不会因 `setup` 或创建临时哨兵而启用。
受支持的显式选项是
`ableton-mcp-lifecycle install --enable-bridge-diagnostics`;它只配置一个
有界的 owner-state 文件,不写入负载或密钥。不带该选项卸载/重装即可禁用。
详见 [OPERATIONS.md](OPERATIONS.md) 与 [DELIVERY.md](DELIVERY.md)。

仅向显式选择的目标安装 Remote Script:

```sh
npm run build
node dist/src/install-remote-script.js --destination /absolute/path/ControlSurface --dry-run
```

安装器默认拒绝符号链接树与覆盖。`--force` 仅用于已知可恢复的目标。连接
Live 之前,请阅读 [LIVE_SAFETY.md](LIVE_SAFETY.md)、
[OPERATIONS.md](OPERATIONS.md) 与 [RECOVERY.md](RECOVERY.md)。

## 资源与提示词

只读资源包括 `ableton://capabilities`、`ableton://safety`、
`ableton://journeys`、`ableton://max-extension` 与安全速度工作流。提示词
用于准备请求;它们不授予变更权限。任何资源或提示词都不授权场景启动、
录音、路由或音频捕获。
