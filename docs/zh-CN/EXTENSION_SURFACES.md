# 扩展面:评估与处置

[English](../en/EXTENSION_SURFACES.md) · 简体中文 · [日本語](../ja/EXTENSION_SURFACES.md)

不属于普通 Remote Script 成员的 Ableton 面,以及稳定公共 LOM 未暴露的
Live UI 功能。每一项都有显式处置:已在别处实现、已记录设计的可行、
已记录原因的推迟,或拒绝。这些都不是桥接缺陷;它们是具有不同权限
要求的能力层级。

## Max for Live

桥接的 Remote Script 面现已覆盖宿主所需的全部文档化 Live Object Model
领域。剩余的仅 Max 面及其处置:

| 面 | 处置 |
|---|---|
| 伴随 `.amxd` 中的 `live.path`、`live.object`、`live.observer` | 可行,推迟。设计:一个版本化伴随设备,经认证实时通道上以现有的有界 `max` 标签数据包契约通信(令牌/TTL/代际栅栏),不引入第二权限平面。仅当真正需要 Remote Script 无法提供的面时才交付 —— 目前不需要 |
| `live.remote~`(信号速率参数控制) | 推迟。当前 64 包/秒的 UDP 通道刻意不等价;信号速率控制目前不是产品需求。若采用:专用伴随设备,带显式操作者权限与延迟测量,绝不冒称现有通道 |
| `live.modulate~`(加性调制) | 以相同设计推迟;加性调制绝不替换基础参数值 |
| `live.map`(操作者驱动映射) | 推迟。映射是操作者 UI 工作流;候选由发现行生成,设计落地时经参数事务应用 |
| `live.banks` / MaxDevice 库 API | 在公共处已实现:Max 设备音频/MIDI IO 描述符与参数库在设备行上暴露(P1.11/P1.13) |
| `live.routing`(Max 设备路由 UI) | 经上述伴随设计可行;目前不需要,因为轨道/链/设备路由已通过 Remote Script 类型化 |
| `live.push`(Push 垫布局/颜色) | 推迟。见下方 Push 部分 |
| `live.miditool.in` / `live.miditool.out`(MIDI 生成/变换工具) | 推迟。原生 MIDI 工具开发属于伴随设计,而非 Remote Script;目前不作声明 |
| `live.thisdevice`、`live.param~`、DSP 与设备生命周期 | 明确与 MCP Remote Script 区分,永久超出其范围 |

诚实的 `ableton://max-extension` 资源仍是版本化的数据包级扩展点。
运行时宣告 OSC/realtime,绝非 `max` 能力:不声称捆绑 `.amxd`、握手或
任意数据包权限。

## Ableton Link 与 Link Audio

| 面 | 处置 |
|---|---|
| LOM Link 控制 | 已实现:`is_ableton_link_enabled`、`is_ableton_link_start_stop_sync_enabled` 与带显式计时和可发声权限栅栏的 `force_link_beat_time`(P1.6) |
| 外部 Link SDK 对等体(节拍、速度、相位、量子、起停、对等发现) | 推迟,已记录设计。外部 Link 对等体是独立进程,拥有自己的网络权限:它必须是显式的操作者选择,带自己的发现、延迟与隐私审查,而不是回环桥接静默变成的东西。作为独立的可行性/设计 issue 跟踪 |
| Link Audio 收发 | 推迟。需要同样的外部对等体设计,外加音频隐私与路由分析;到 Link Audio 对等体的轨道路由必须像任何其他路由更改一样类型化并获操作者授权 |

## Push 与硬件控制面

| 面 | 处置 |
|---|---|
| 官方 Push 2 硬件接口 | 推迟。它是独立于 Live ControlSurface LOM 的硬件面;不从通用 MIDI 音符传输声称支持 |
| ControlSurface MIDI/SysEx 抓取、反馈、参数库、自定义模式 | 推迟。桥接是一个 Control Surface,但刻意只使用文档化 LOM;为硬件反馈抓取原始 MIDI 流会复制 Live 自己的控制面层,目前超出范围 |

## Connection Kit 式集成(OSC/JSON/web/串口/Arduino)

目前拒绝,超出产品范围。当前边界是仅回环、主要入向、短生命周期的
实时授权平面。通用出/入向 OSC、web API、串口与传感器集成各自都是
需要独立审查的权限平面;不会静默加入。仅在出现明确产品需求时重新
评估。

## 稳定公共 LOM 未暴露的 Live UI 功能

每一项都有显式处置。这些都不是桥接缺陷;在 Ableton 未提供稳定公共
API 的地方,保留的协议操作故障关闭并报告实际限制。

| 功能 | 处置 |
|---|---|
| Arrangement 自动化包络/点编写 | 目前不支持。`arrangement.automation.*` 保持保留并故障关闭;Session 剪辑包络已实现 |
| 完整 comp 区域选择与 comp 编辑 | 公共 LOM 不支持;现有 take lane 发现/重命名与文件音频导入已公开,但仅映射器实现的 lane 创建/MIDI lane 剪辑路径未由公共 MCP 模式宣告 |
| take-lane 删除/试听/comp 语义 | 公共 LOM 不支持;不声称这些是公共 MCP 能力 |
| 冻结与压平 | 无公共 API;不做 UI 自动化 |
| 离线 bounce、分轨、导出音频/视频、渲染状态 | 无公共 Remote Script API;`project.bounce/export/collect` 保持保留并故障关闭 |
| 工程新建/打开/保存/另存/关闭与 Collect All and Save | 无公共 API;`live_project_save`/`live_project_open` 保持为显式限制报告器 |
| 分轨分离 | 无公共 API |
| 完整 Arrangement 分割/合并/剪切/复制/时间粘贴 | 无公共 API |
| Follow Action 编写 | Live API 未暴露 |
| 交叉淡化/淡化曲线编辑 | 无公共 API |
| 完整 MPE 逐音符表情文档编辑 | 无权威 API;绝不声称(probability/velocity/deviation/release-velocity/mute 保持为协商音符字段) |
| RoarDevice、ShifterDevice、SpectralResonatorDevice、WavetableDevice 语义表面 | 延期,不声称。通用 DeviceParameter 控制仍可用;只有在取得真实 Live 形态后才提供专用族 |
| Sample 表面(片段行之外的切片/warp/采样元数据) | 延期,不声称 |
| Simpler 的其余表面(包络、滤波器、LFO、回放模式) | 延期,不声称;按能力门控的 `Simpler.replace_sample` 是唯一交付的 Simpler 语义 |
| Browser 标签、相似度搜索、Pack 安装/更新、Cloud/Splice 管理 | 无公共 API;`live_browser_search` 明确是有界名称匹配,`live_browser_roots` 报告绑定层级,而非假装这些存在 |
| 偏好设置、音频驱动/缓冲配置、MIDI 端口偏好 | 无公共 API;应用级配置保持操作者所有 |
| 超出已暴露参数、预置与编辑器可见性的任意插件不透明状态或 GUI 控制 | 无公共 API;插件参数、预置与 `is_editor_open` 是类型化边界 |
| 视频轨道导入/导出控制 | 无公共 API |
| 跨 Set 加载的稳定对象标识符 | 桥接经 epoch 将身份绑定到活动会话;不声称跨加载持久性 |
| 经 LOM 的任意原始轨道音频 | 无公共 API;若确有需要,授权的 Max 设备或 Link Audio 是记录在案的替代;知情同意绑定的 Session Resampling 捕获目前仍是唯一捕获路径 |
