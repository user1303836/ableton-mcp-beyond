# 能力与证据矩阵

[English](../en/CAPABILITY_MATRIX.md) · 简体中文 · [日本語](../ja/CAPABILITY_MATRIX.md)

关于代理能在 Ableton Live 中做什么、以及每项声明证据范围的最高事实来源。
"已实现"绝不等于"已在所有外部环境中证明"。

## 代理能做什么?

面向制作人的人话答案。每个变更都经过只读预览、你的显式确认、精确应用和
验证回读;大多数内容编辑都可以用 `live_undo` 撤销。

| 我想… | 工具 | 须知 |
|---|---|---|
| 创建 MIDI 或音频轨道和场景 | `live_session_structure_preview/apply` | 插入位置只针对常规轨道;return/main 轨道绝不会被当作插入位置 |
| 返回轨道与复制 | `live_track_structure_preview/apply` | 创建返回轨道、复制轨道或场景,带结构栅栏与受护栏清理;返回轨道删除是显式且诚实不可撤销的 |
| 读取轨道健康与状态 | `live_snapshot`、`live_discover` | 每行轨道暴露编组关系、可见性、选中成员、冻结/折叠状态、隐式 arm、回到编排水位、独奏致 mute、全部输入/输出电平表与性能影响 |
| 性能与延迟诊断 | `live_performance_read` | 一次有界、按需的采样:平均/峰值进程占用、逐轨道电平表与性能影响、以采样和毫秒计的设备延迟。时间点证据;电平表是 Live UI 表头,绝非解码音频分析 |
| 删除现有设备 | `live_device_delete_preview/apply` | 带精确身份与兄弟栅栏显式删除现有设备;诚实不可撤销 |
| 轨道视图与乐器聚焦 | `live_track_view_preview/apply` | 折叠状态与设备插入模式,带精确撤销,另有 Live 设备视图中的乐器选择(瞬时,不可撤销) |
| 驱动 Live 的选择与视图 | `live_selection_preview/apply`、`live_clip_view_preview/apply`、`live_device_view_preview/apply`、`live_view_preview/apply` | Song.View 选择(轨道、场景、高亮槽、详情剪辑、设备、参数、链)、绘制模式、剪辑网格量化/三连音/包络可见与 show-loop、设备折叠(按形态协商)、主视图切换/隐藏/聚焦、缩放/滚动、跟随播放、轨道折叠与 Browser 模式切换 —— 状态可恢复处均带精确恢复 |
| 应用对话框 | `live_application_dialog_preview/apply` | 读取当前对话框状态,仅在预览的状态仍精确成立时按下一个对话框按钮 —— 对话框按钮可能有破坏性,状态一变即拒绝 |
| 创建 MIDI 剪辑并写入音符 | `live_midi_clip_preview/apply`、`live_note_update_preview/apply`、`live_note_delete_preview/apply` | 完整表情字段:velocity、channel、probability、velocity deviation、release velocity、mute;稳定音符 ID;每个剪辑一次原子批量 |
| 调整设备和插件参数 | `live_device_parameter_preview/apply` | 作用于具有权威边界的已发布数值参数;写入后验证;含受护栏撤销 |
| 加载乐器、效果和预置 | `live_browser_search`、`live_browser_load_preview/apply` | 把确切的 Browser 项目加载到选定轨道;插件必须在 Live 自己的 Browser 中可见 |
| 插入、启用、移动或移除设备 | `live_device_preview/apply`、`live_device_delete_preview/apply` | 移除仅限于事务自身创建的设备(精确清理);显式删除现有设备带栅栏且诚实不可撤销 |
| 深层设备与参数控制 | `live_device_advanced_preview/apply`、`live_device_parameter_preview/apply` | 每行参数暴露元数据(默认值、原名、状态、枚举项、显示值);参数库带精确撤销;自动化重启用与 A/B 对比保存(瞬时);链设备插入(空链守卫);经 `Song.move_device` 的跨轨道/链设备移动,带精确反向移动撤销。Bypass 绝不从只读 `Device.is_active` 推断可写 —— 只使用探针验证的 Device On 参数 |
| 混音:音量、声像、静音、独奏、cue、发送 | `live_mixer_preview/apply` | 先捕获先前值,混音改动可以精确撤销 |
| 扩展混音与交叉淡化 | `live_mixer_extended_preview/apply` | 轨道激活器、交叉推子、交叉分配、声像模式与分离立体声左/右声像,带精确撤销。主轨道的语义速度参数在其混音行上只读暴露;速度更改仍走速度工作流 |
| Rack 链混音器 | `live_chain_mixer_preview/apply` | 链音量、声像、发送与链激活器,带精确撤销 |
| 链、鼓垫与机架 | `live_chain_preview/apply`、`live_drum_pad_preview/apply`、`live_rack_preview/apply`、`live_rack_view_preview/apply` | 链颜色/自动颜色/静音/独奏,行上暴露鼓链音符与窒息组;鼓垫音符/独奏带精确撤销,另有显式全部链删除(不可撤销);机架返回链、宏状态、可见宏数量与所选变体在行上;宏添加/移除/随机化、链插入、垫复制与变体保存/召回/删除作为瞬时动作;机架视图所选链/垫、垫滚动与链设备可见性,带精确撤销 |
| 设备路由与侧链 | `live_device_io_preview/apply`、`live_routing_preview/apply` | 轨道路由(类型化,拒绝反馈)留在 `live_routing_*`;设备级 IO 类型/通道与压缩器侧链源在 `live_device_io_*` —— 分离的类型化面,各按形态协商,有状态处可撤销 |
| 触发和停止 Session 剪辑 | `live_clip_launch_preview/apply/stop` | 一次一个已确认触发;只停止映射器拥有的播放 |
| 安全地试听场景 | `live_session_audition_preview/apply/stop`、`live_session_emergency_stop` | 需要输出安全确认以及已停止、未 armed、未监听的基线;独立紧急停止始终可用 |
| 开始/停止播放、设置位置、循环、节拍器、穿入穿出 | `live_transport_preview/apply` | 修订栅栏;可撤销;预备拍为只读上报 |
| 更改速度 | `live_tempo_preview/apply` | 有界 BPM,带后置条件验证 |
| 使用定位点并跳转播放头 | `live_arrangement_section_preview/apply`、`live_locator_jump_preview/apply` | 创建/删除/重命名定位点;跳转到下一个或上一个定位点,或经 `CuePoint.jump` 跳转到某一确切定位点,带播放头栅栏 |
| 在时间线上编排剪辑 | `live_arrangement_clip_preview/apply`、`live_clip_duplicate_preview/apply`、`live_clip_move_preview/apply` | 创建、复制和移动剪辑;事务创建剪辑的清理是精确的;拒绝任意 Arrangement 删除 |
| 把音频文件导入 Arrangement | `live_arrangement_clip_preview/apply` 加 `kind: "audio"` | 把文件支持的音频剪辑放到选定轨道的确切位置,并验证创建身份 |
| 把音频文件导入 Session 槽位 | `live_audio_import_preview/apply` | 显式文件权限:允许根、规范化路径、大小/类型检查、SHA-256 并在应用时重新验证(防 TOCTOU),以及对已导入剪辑的受护栏清理 |
| 使用 take lane | 发现、`live_object_rename`(kind `takeLane`)、`live_arrangement_clip_preview/apply`(`takeLaneRef`)、`live_audio_import_preview/apply`(`takeLaneRef`) | 读取 lane 及其剪辑、创建 lane、重命名 lane,并在 lane 内创建 MIDI 或文件音频剪辑。公共 LOM 不提供 take-lane 删除,因此 lane 与 lane 剪辑的创建诚实不可撤销;comp 区域编辑无公共 API,保持不可用 |
| 编辑 warp 标记 | `live_warp_marker_preview/apply` | 按节拍时间添加、移动或删除标记(采样时间映射由 Live 负责);标记集合栅栏、精确回滚与受护栏撤销 |
| 裁剪、复制与刮擦剪辑 | `live_clip_action_preview/apply` | 按循环裁剪、复制循环或区域、刮擦以及移动播放位置;内容操作被诚实标记为不可撤销 |
| 量化与复制音符 | `live_note_edit_preview/apply` | 时间或音高量化,以及按稳定音符 ID 定向复制,带精确先前内容撤销 |
| 编辑律制与音阶 | `live_tuning_preview/apply` | 律制名称、音域、参考音高与全部 128 个音符偏差,以及根音、音阶名称/模式与音程。验证覆盖长度/范围约束并带精确回滚;更改全局影响播放音高,并经 `live_undo` 精确恢复 |
| 使用律动池 | `live_groove_preview/apply`、`live_clip_properties_preview/apply`(`grooveRef`) | 全局律动感量与逐 groove 的名称/base/量化/随机/时值/力度编辑,带精确撤销;经剪辑属性分配或清除剪辑 groove(剪辑行暴露 `hasGroove`)。公共 API 没有完整的 groove 导入/提取工作流 —— groove 必须已存在于池中 |
| 编辑并触发场景 | `live_scene_preview/apply`、`live_scene_fire_preview/apply` | 场景颜色、速度(+启用)与拍号分子/分母/启用,带精确撤销;场景行暴露空/触发/触发按钮状态,剪辑槽行暴露颜色、停止按钮、组槽、播放与启动即录状态。直接触发(fire-as-selected)是独立、带栅栏、可发声且不可撤销的动作 —— 受护栏场景试听仍是聆听检查的安全路径 |
| 读取深层歌曲与 Link 状态 | `live_song_state` | 可见轨道、指定设备、歌曲长度/起点、拍号、摆动、overdub/arrangement overdub、回到编排水位、可捕获/撤销/重做、独占 arm/solo、预备拍中、速度跟随、自动化重启用、Session 录音/自动化,以及 Ableton Link 启用/起停同步 —— 另有节拍↔SMPTE 与循环时间换算 |
| 驱动走带 | `live_transport_preview/apply`、`live_transport_action_preview/apply` | 修订栅栏的位置/循环/节拍器/穿入穿出编辑(可撤销),另有瞬时动作:开始、继续、停止、播放选区、刮擦、打点测速、上/下微调、重启用自动化、触发 Session 录音、强制 Link 节拍时间(带栅栏,可发声动作标记为不可撤销;紧急停止保持独立) |
| 按 ID 或选择读取音符 | `live_note_read` | 只读定向音符读取,包括 Live 暴露时的当前选择 |
| 清除剪辑全部包络 | `live_automation_preview/apply` 加 `clear-envelopes` | 对剪辑上全部包络(设备、rack 与混音器参数)的计数、存在性栅栏清除;诚实不可撤销 |
| 静音、着色和循环剪辑 | `live_clip_properties_preview/apply` | 任意剪辑的静音和颜色;MIDI 剪辑的循环边界(音频循环在 `live_audio_clip_*` 中) |
| 编辑音频剪辑声音:增益、音高、warp、淡变 | `live_audio_clip_preview/apply` | 只写入确切剪辑宣告的字段;含 warp 模式和淡变 |
| 编写剪辑自动化 | `live_automation_preview/apply` | 创建包络、插入点、删除范围,带包络修订栅栏 |
| 路由、arm 和监听轨道 | `live_routing_preview/apply` | 拒绝反馈路由;arm 和监听带栅栏且可恢复 |
| 录音到 Session 或 Arrangement | `live_recording_preview/apply` | 有界开始/停止,带 armed 目标和输出安全复核,以及验证停止 |
| 捕获轨道输出用于分析 | `live_audio_capture_preview/apply/status/emergency_stop` | 知情同意绑定的 Session Resampling,带看门狗、清理和零残留验证(仅真实 Live) |
| 重命名轨道、场景、剪辑、设备、定位点 | `live_object_rename_preview/apply` | 每次重命名都有精确身份栅栏 |
| 撤销更改 | `live_undo` | 在先前状态仍匹配时精确恢复;被其他改动破坏时拒绝 |
| 分析音频(响度、真峰值、频谱) | `audio_analyze`、`audio_compare_reference`、`audio_diagnose_live_context` | ITU-R BS.1770/EBU R128 标准,隐私保护,结果不含原始 PCM |
| 切换视图并控制 Arrangement 视图 | `live_view_preview/apply` | Session/Arranger 切换、缩放/滚动、跟随播放、轨道折叠;仅 UI,不触碰音乐状态 |
| 搜索 Browser 并检查项目 | `live_browser_search` | 只读 |
| 读取 Set:轨道、剪辑、设备、路由、播放 | `live_snapshot`、`live_discover`、`live_status` | 只读;过时引用被拒绝,绝不猜测 |

## 证据范围

- **unit/property/simulator** —— 仅确定性仓库契约;
- **packaged fake-Live** —— 已安装 tarball、认证的跨进程桥接、刻意的假
  Live 来源;
- **real-Live** —— 在指定一次性 Live 环境中经认证 Remote Script 观察;
- **host matrix** —— Node/包/生命周期行为,绝非 Windows Live。

安全等级:**R** 只读;**G** 修订/epoch 绑定的预览-确认-验证变更;**A**
带输出/录音闸门和独立停止的可发声或录音;**RT** 短生命周期实时权限;
**FS** 所有者/允许列表绑定的文件系统变更;**P** 知情同意/隐私敏感音频;
**D** 交付与安装权限。

## 基础与控制域

| 域 | 公共 API / 规范操作 | 实现与安全 | 主要测试 | 平台/生产证据 | 文档与协商限制 |
|---|---|---|---|---|---|
| MCP 传输与宿主 | initialize、tools/resources/prompts、stdio JSON-RPC | `host.ts`、`stdio.ts`、`framing.ts`;R/G;有界帧、工作、速率、取消、排序 | `host.test.ts`、`stdio.test.ts`、`framing.test.ts`、属性/基准 | 已配置 Node 22/24/25 宿主矩阵;打包 fake-Live 旅程;需要精确 SHA 结果 | `DEVELOPER_GUIDE.md`、`OPERATIONS.md`;无通用变更工具 |
| 规范 Live 契约 | `ableton-live/v1`、操作注册表、清单/哈希 | `registry.ts`、`live.ts`、Python 映射器;R/G/A/RT;严格模式与单一规范摘要 | `registry.test.ts`、Python 契约测试、包/候选验证器 | 历史 macOS 真实 Live 协商使用旧注册表摘要;需要当前摘要精确候选证明 | `DEVELOPER_GUIDE.md`、`LIVE_SAFETY.md`;不支持的形态保持不可用 |
| 认证桥接 | status/snapshot/discover/get 及用途专用操作 | `remote-adapter.ts`、Python 监听器;回环质询、HMAC、epoch/序列/截止时间栅栏 | `registry.test.ts`、`live.test.ts`、打包旅程 | 打包 fake-Live 与 macOS 真实 Live | `OPERATIONS.md`、`RECOVERY.md`;无远程网络模式 |
| 引用、发现、选择 | set、track/return/main、scene、slot、clip、note、locator、device、parameter、routing、playback、selection | 注册表 + 映射器遍历;R;父级作用域引用/游标/修订;选择复用规范可解引用的 track/scene/slot 引用 | 注册表、宿主、Python 测试 | `phase-3-readonly-live-discovery.json` 及后续真实 Live 阶段证据 | `USER_GUIDE.md`;过时引用/epoch 被拒绝 |
| 走带、循环、节拍器、穿入穿出 | `transport.set`、transport preview/apply/undo | 宿主事务 + 映射器;播放可变时为 G/A | 宿主/Python/打包旅程 | `phase-5a-transport-clip-live.txt`(macOS 真实 Live) | `LIVE_SAFETY.md`;需要新鲜播放/录音状态;`Song.count_in_duration` 在公共 LOM 中为 get/observe,只上报不写入 |
| 播放头 cue 导航 | `locator.jump` 下一个/上一个 | 宿主 preview/apply,带播放头与定位点栅栏;G | 宿主与 Python 测试 | 打包 fake-Live 与模拟器;当前候选真实 Live 证明待完成 | `USER_GUIDE.md`;绝对定位仍在 `transport.set`;导航本身不提供撤销 |
| Session 试听与紧急停止 | `session.audition-launch/stop`、`session.emergency-stop`、播放发现 | 专用宿主/映射器事务;A;不可预测令牌、精确目标、重放、拥有的停止 | 宿主、Python、打包旅程 | `phase-4-guarded-audition.json` 及外部保留的精确候选只读状态 | `LIVE_SAFETY.md`、`RECOVERY.md`;外部播放绝不声称拥有 |
| Session 结构 | track/scene 创建/删除/重命名及 clip/device/locator 重命名;槽位与 Session 剪辑发现 | preview/apply/undo 管理器 + 映射器;G;插入索引在变更前对照常规轨道和场景有界检查 | 宿主/Python/打包旅程 | 真实 Live 阶段 5 证据;打包 fake-Live | `USER_GUIDE.md`;创建绝不把 return/main 轨道当作常规轨道插入位置,group/return/main 编辑只在存在规范操作时暴露 |
| Session MIDI 剪辑与音符 | `clip.create/delete`、单音符 `note.add`、原子 `note.add-batch`、`note.update/delete`、Session MIDI preview/apply/undo | `session-midi.ts`、宿主、映射器;G;稳定音符身份、每次剪辑创建一个有界原生批量及补偿 | `session-midi.test.ts`、宿主/Python/打包旅程 | 历史真实 Live 阶段覆盖当时的基本生命周期;当前契约与表情生命周期为打包 fake-Live,精确候选真实 Live 证明待完成 | `USER_GUIDE.md`;pitch、velocity、channel、duration、probability、deviation、release velocity、mute 均为协商 |
| 高级 MIDI / MPE | 暴露处的 probability、velocity deviation、release velocity、mute | 音符模式与映射器;G | 注册表/宿主/Python 旅程测试 | 表情字段仅在打包 fake-Live 中证明;成功的当前候选真实 Live 证明待完成;逐音符 MPE 压力/滑音/调音不可用 | `USER_GUIDE.md`;扩展点是规范音符模式加协商映射器操作,绝不捏造字段 |
| Session 捕获 | `session.capture-midi`、`scene.capture` | 宿主 preview/apply/幂等/受护栏撤销事务加映射器预检、不可变对象身份删除栅栏及新鲜修订/回读;G/A | 宿主/Python/打包旅程 | 真实 Live 阶段 5 证据 | `LIVE_SAFETY.md`;捕获结果必须可重新发现;MIDI 捕获仅在所有 Session 槽位为空时宣告,使原生失败清理无法改变既有剪辑内容 |
| Arrangement 导航与剪辑 | arrangement 发现;剪辑创建/复制/移动;事务拥有清理;locator 添加/删除/重命名 | 宿主事务管理器 + 映射器;G | 宿主/Python/打包旅程 | `phase-5cd-clip-arrangement-live.txt` 及当前测试 | `USER_GUIDE.md`;拒绝任意 Arrangement 删除;精确创建身份+指纹清理仅适用于创建/复制;移动栅栏源/目标内容并使用精确反向移动恢复,绝不铸造删除权限,并消费事务创建源的任何先前清理令牌 |
| Arrangement 音频导入 | `arrangement.audio-clip.create`(文件路径到精确位置) | 宿主 preview/apply,带轨道/集合栅栏 + 映射器创建身份;G;通过 `live_undo` 的事务拥有清理 | 宿主与 Python 测试 | 打包 fake-Live 与模拟器;当前候选真实 Live 证明待完成 | `USER_GUIDE.md`;路径必须在该机器上可被 Live 读取;按文件路径、位置和创建身份验证放置 |
| 剪辑属性 | `clip.set` 静音、颜色索引、MIDI 循环启用/边界 | 宿主 preview/apply + 映射器,带权限/状态修订、有序循环写入和精确回滚;G | 宿主与 Python 测试 | 打包 fake-Live 与模拟器;当前候选真实 Live 证明待完成 | `USER_GUIDE.md`;音频剪辑循环留在 `audio.clip.set`;剪辑未暴露的字段被拒绝,绝不捏造 |
| 音频剪辑属性 | `audio.clip.set` 中按字段协商的增益、音高、循环、warp 启用/模式与淡变;有界 warp 标记回读 | 宿主/注册表/映射器;G;每个请求字段必须出现在确切剪辑的 `availableAudioFields` 中 | 宿主、注册表与 Python fake-Live 测试 | 真实 Live 阶段 5cd 证明对 MIDI 目标的安全拒绝,而非成功的音频编辑 | `USER_GUIDE.md`;成功的当前候选真实 Live 音频编辑与 warp 标记编辑/take-lane/comp API 仍未证明或不可用;标记回读绝不暗示编辑权限;保留的规范 `audio.warp-marker.*`、`audio.take-lane.read`、`audio.comp.read` 契约在可执行前保持不宣告 |
| 自动化 | 剪辑包络与点的创建/读取/插入/删除/恢复 | 宿主 + 映射器;G,父级/修订绑定 | 宿主/Python/打包旅程 | `phase-5e-mixer-automation-live.txt` | `USER_GUIDE.md`;Arrangement 自动化/调制在观察到的 API 中不可用;严格的 `arrangement.automation.*` 契约经注册表测试,在可执行前保持不宣告 |
| 混音器、发送、返回、分组、cue | 混音器发现/设置,带精确行修订 | 宿主 + 映射器;G/A | 宿主/Python/打包旅程 | `phase-5e-mixer-automation-live.txt` | `LIVE_SAFETY.md`;只更改发现的可写字段;削波不被推断忽略 |
| 路由、监听、arm | 路由选择发现、`routing.set` | 宿主 + 映射器;G/A;反馈拒绝、精确路由、arm/监听栅栏 | 宿主/Python/打包旅程 | `phase-6cd-routing-recording-live.txt` | `LIVE_SAFETY.md`;需要操作者准备的捕获路由 |
| Session/Arrangement 录音 | `recording.session`、`recording.arrangement` preview/apply/stop | 宿主 + 映射器;A;精确先前录音状态、armed 目标与输出安全权限在映射器中原子复核;验证停止 | 宿主/Python/打包旅程 | `phase-6cd-routing-recording-live.txt` | `LIVE_SAFETY.md`、`RECOVERY.md`;无无界录音命令 |
| 设备层级 | 设备、rack、链、鼓垫、宏、参数 | 递归扁平化的父级作用域嵌套设备/参数发现及设备/参数事务;G/A | 宿主/注册表/Python/打包旅程 | `phase-6ab-devices-browser-live.txt` | `USER_GUIDE.md`;宏变体与侧链字段仅在 Live 暴露时报告 |
| 设备生命周期与参数 | 插入/启用/移动、事务拥有清理、有界已发布参数设置/撤销 | 宿主 + 映射器;G;变更绑定精确设备、所有者、轨道、兄弟顺序、状态及适用时的创建指纹 | 宿主/Python/打包旅程 | `phase-6ab-devices-browser-live.txt` 及当前测试 | 任意设备删除与插件 UI 控制不受支持;清理限于精确的事务创建设备,插入/加载保守地限于空设备所有者,使清理不会影响无关兄弟 |
| 预置与第三方插件 | 精确 Browser 项目检查与仅设备加载;发现后的已发布参数 | browser/device 事务;G;非设备结果在变更前被拒绝,所有权/可用性是操作者事实 | 旅程/宿主/Python 测试 | 打包 fake-Live;macOS 真实 Live 中的原生 Browser 加载 | 精确第三方预置工作流与 UI 自动化未认证;扩展点是已发现 Browser 身份 + 已发布参数 |
| Browser | 搜索/过滤/检查及精确的仅设备加载 | 宿主 + 映射器;R/G;检查栅栏在加载前复核 | 宿主/Python/打包旅程 | `phase-6ab-devices-browser-live.txt` | Browser 音频预览/停止在不存在权威预览/停止 API 处不可用;严格的 `browser.preview.start/stop` 契约作为未宣告扩展点测试 |
| 应用视图 | `view.set` 主视图切换;`view.control` 缩放/滚动/跟随/轨道折叠 | 宿主 preview/apply + 映射器,带回读确认;G;仅 UI,无音乐状态 | 宿主与 Python 测试 | 模拟器与 Python 契约;当前候选真实 Live 证明待完成 | `USER_GUIDE.md`;瞬态 UI 状态不可撤销,且绝不作为音乐变更的前置 |
| 项目与文件 | 项目信息、清单、缺失媒体元数据、验证的同位备份 | `project.ts`;R/FS;调用方允许根、`.als` 内容标记、有界文件、不读媒体、原子哈希验证复制 | `project.test.ts`、宿主/Python 阶段测试 | `phase-7a-project-ops-live.txt` | 规范 `project.new/open/save/save-as/collect/export/bounce` 扩展 ID 存在,但在适配器能执行并验证前保持不宣告且不可调用 |
| 订阅/事件 | 对已产生的 `transport`、`object`、`reset` 事件的认证订阅/退订;有界事件队列 | 适配器/映射器;R;签名 epoch 绑定事件携带 epoch;未送达的相邻合并保持连续性,真实溢出发出 reset 事件 | 回环/Python/打包旅程 | `phase-7b-subscriptions-live.txt` | 不支持的 state/meter/Max/OSC 事件过滤器被拒绝而非静默接受;epoch 变化、reset 或序列缺口要求重新快照;事件不是变更权限 |
| UDP/OSC/XY/Max 包兼容实时 | realtime arm/disarm/stats;有界 JSON、OSC、XY 与 `max` 标签包入口 | 映射器实时平面;RT/A;令牌/TTL/来源/通道/速率/队列/代栅栏,外加每个 Live 线程包上复核的精确参数、所有者、轨道、路径与兄弟身份;诚实的 `ableton://max-extension` 资源 | 宿主/Python/打包旅程 | `phase-7c-realtime-live.json` | 运行时宣告 OSC/realtime,而非 `max` 能力。包标签仅为扩展格式;不声称捆绑 Max 设备、握手、`.amxd` 或任意包权限 |
| 紧急恢复 | Session 紧急停止、捕获紧急停止/状态、realtime disarm | 用途专用独立权限;A/RT/P;Session 紧急停止原子清除剪辑播放、走带与两种录音模式 | 宿主/Python/打包/重启测试 | 真实 Live 阶段 4、7c、8 | `RECOVERY.md`;不确定变更绝不自动重放 |

## 音频智能与隐私

| 域 | API / 实现 | 安全 | 测试与对照 | 生产证据 | 限制 / 文档 |
|---|---|---|---|---|---|
| PCM 分析 | `audio_analyze`;`analysis.ts` 与一次性 worker 运行器 | P;有界输入/时间/内存/输出、取消、剥离密钥的 worker、结果无原始 PCM | 分析、worker、属性、基准测试 | 打包本地分析 | `AUDIO_INTELLIGENCE.md`;所供 PCM 关系为调用方声明 |
| 波形/频谱/时频/瞬态/相位/动态 | `pcm-analysis/v2` 聚合摘要 | P/R | 确定性夹具与边界 | 打包旅程 | 有损聚合证据,不是源重建或母带裁决 |
| 响度/LRA/真峰值 | `audio-standards.ts`、BS.1770-5 / EBU R128/Tech 3341/3342 | P/R | `phase-8-audio-oracle.json` 中的独立 FFmpeg 对照 | 打包分析 | 真峰值仅在 44.1/48 kHz 验证;沉浸声/对象布局不可用 |
| 参考对比 | `audio_compare_reference`;有界重采样、对齐、电平匹配 | P/R | `reference-analysis.test.ts`、属性/基准 | 打包参考旅程 | 32–96 kHz 输入;歧义故障关闭,扣留重叠、跨源差值与增益建议,同时保留独立源分析;不推断法律/来源关系 |
| 信号链诊断 | `diagnoseAudioWithLiveContext` | R/P;精确引用、非因果语言 | 诊断/宿主测试 | 打包旅程与阶段 8 | 测量不证明某设备造成了差异 |
| Live 音频捕获 | 受护栏 Session Resampling 开始/状态/停止/清理/紧急停止 | A/P;知情同意、源/目标身份、看门狗、媒体身份/解除链接、状态恢复 | 捕获宿主/文件/Python/打包恢复测试 | macOS Live 12.4.5b8 上的 `phase-8-audio-live.json` | 不声称原生 PCM 分接;需要已保存 Set、WAV、安全路由与真实 Live 来源 |

## 北极星用户旅程

所有旅程计划都是用途专用工具之上的只读组合层;不授予变更权限。

| 旅程 | 工具/资源/提示与实现 | 重要路径 | 打包证据 | 真实 Live / 平台状态 | 权利、无障碍、回退 |
|---|---|---|---|---|---|
| 创建节拍或歌曲 | `plan_user_journey`、`ableton://journeys`、`create_beat_or_song`;`journeys.ts` | MIDI/结构/Arrangement/试听预览与精确确认 | `phase-9-journeys-packaged.json` | 受护栏原语有 macOS 真实 Live 阶段证据;完整组合旅程为打包 fake-Live | 仅高层特征;不可用的 Arrangement 阶段重新计划/回退 |
| 编排高级鼓组 | `sequence_advanced_drums` | Session MIDI 创建、表情修订、试听、回读 | 阶段 9 打包证据 | MIDI/试听原语在 macOS 上观察到 | 不虚构鼓组映射;仅操作者拥有/发现的映射 |
| 设计自有/原生音色 | `design_owned_sound` | Browser 加载、已发现参数塑造、试听/恢复 | 阶段 9 打包证据 | Browser/设备原语在 macOS 上观察到 | 不捏造所有权、插件可用性、预置或艺术家身份 |
| 对比参考混音 | `compare_reference_mix` | 本地标准/参考分析、可选受护栏捕获/混音器假设与恢复 | 阶段 9 打包证据 | 捕获原语在 macOS 上观察到;本地分析跨平台 | 无精确复制/法律许可声明;不保留原始音频 |
| 诊断演出/录音设置 | `diagnose_performance_setup` | 路由/混音器预览、有界录音、可选实时、最终恢复 | 阶段 9 打包证据 | 组件原语在 macOS 上观察到 | 无权威 API 时延迟保持未知;realtime/捕获需要真实 Live |
| 旅程内的 Session/Arrangement 编辑 | 创建/歌曲与鼓组计划中的阶段 | 现有用途专用剪辑/定位点/自动化工具 | 阶段 9 打包证据 | 阶段 5–6 的组件真实 Live 证据 | 不支持的 Arrangement 自动化与 comp 工作流保持不可用 |

## 交付、兼容性与无障碍

| 域 | 实现 / 安全 | 测试与证据 | 支持状态 | 限制 / 文档 |
|---|---|---|---|---|
| 发布产物 | 严格 77 路径 MIT npm tarball、发布清单、载荷角色/哈希、许可证字节相等 | `package:verify`、候选与 Python 绑定器、全新克隆字节比对 | 仅精确 SHA 本地未发布 tarball | `DELIVERY.md`;npm `private: true`、未签名、未公证、未发布 |
| 安装/激活 | `ableton-mcp-lifecycle` 回执/日志/锁;D/FS | 生命周期单元 + 已安装候选矩阵;激活需要真实 Live 与完整回执绑定包 | macOS 15 与 Windows Server 2025 宿主契约,以精确 SHA CI 为条件 | Windows Live/Windows 11 激活未认证;`DELIVERY.md` |
| 升级/修复/回滚/卸载 | 精确更新产物、隔离/保留清理、精确前代、仅所有者清除 | 生命周期单元、候选 OS 矩阵(含 Windows ACL/联接点/占用文件用例) | 在托管精确 SHA 结果前仅为宿主契约 | 无原生安装器;操作者必须停止/重启 Live |
| Node/OS 兼容性 | Node 22/24/25;Ubuntu 24.04、macOS 15、Windows Server 2025 工作流 | 完整 Node 测试加精确已安装候选;Python 3.11 映射器 | 有条件;见当前检查结果 | Linux 无 Live 声明;Windows 11 不从 Server 继承 |
| 键盘操作 | 服务器 stdio 与生命周期 CLI 仅需键盘/stdin;有序文本状态 | 打包旅程与候选 CLI 测试 | 服务器拥有的文本边界 | 第三方客户端、终端与 Live 拥有自己的焦点行为 |
| 屏幕阅读器 | 无服务器拥有的可视 UI;语义文本与非颜色状态 | 仅契约检查,非 VoiceOver/Narrator 交互证据 | **未认证** | VoiceOver、Narrator、Live、插件与 MCP 客户端行为需要单独的交互式平台证据;`USER_JOURNEYS.md`、`SUPPORT_MATRIX.md` |
| 签名/发布 | 显式不可用诊断与策略 | 包/候选策略断言 | 不适用于当前本地未发布渠道 | MIT 权利独立;需要授权身份与单独的发布决定 |

## 证据新鲜度规则

被跟踪的阶段证据证明指定历史阶段与环境。它不会被静默提升到后来的
产物。最终就绪还要求推送头的 CI 产物元数据、精确候选宿主结果,以及
命名同一 Git SHA 与产物 SHA-256 的外部保留真实 Live 观察。Windows
Server 宿主证据绝不填补 Windows Live/Windows 11 单元格。

## 可执行与保留注册表契约

规范注册表包含的操作 ID 多于映射器当前宣告的数量。只有已协商、可执行的
操作出现在 `live_status` / `capabilities` 的 `operations.executable` 中;
其余(`operations.reserved`)是严格契约,在适配器能够执行并验证之前
故障关闭。保留 ID 绝不是可用能力的证据。

| 保留操作 ID | 处置 |
|---|---|
| `audio.warp-marker.read/add/move/delete` | 已实现(warp 标记家族已随本分支交付);模式按节拍时间寻址标记 —— 不虚构整数 ID |
| `audio.take-lane.read`、`audio.comp.read` | take lane 发现/创建/重命名与 lane 剪辑创建已实现;comp 区域编辑保持受限(无公共 API),因此 `audio.comp.read` 保持保留 |
| `arrangement.automation.*` | Arrangement 自动化编写无稳定公共 API;保持保留并故障关闭 |
| `browser.preview.start/stop` | Browser 预览使用非官方 Python 绑定;处置随 Browser 家族工作决定 |
| `project.new/open/save/save-as/collect/export/bounce` | 无公共 Remote Script API;`live_project_save` / `live_project_open` 保持为显式限制报告器 |
| `session.discover` | 保留别名;发现由 `discover`/`snapshot`/`get` 提供 |
