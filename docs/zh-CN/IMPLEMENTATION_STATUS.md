# 实现状态

[English](../en/IMPLEMENTATION_STATUS.md) · 简体中文 · [日本語](../ja/IMPLEMENTATION_STATUS.md)

当前分支实现并验证了什么,以及诚实的限制在哪里。源码、模式与测试是
最终权威。

## 已实现并验证

- 严格的换行分隔 JSON-RPC MCP 宿主(`2025-11-25`),具有有界帧/并发、
  有序背压感知输出、取消、重复 ID 拒绝、隐去敏感信息的诊断,以及故障
  关闭的默认适配器。
- 显式的宿主/桥接配置、owner-only 独立密钥、回环强制、迁移、安装、诊断,
  以及带可恢复备份的原子 Remote Script 安装。
- 已认证的 `ableton-loopback/v1` 桥接:连接挑战与桥接 epoch 绑定、规范
  HMAC 帧、重放/截止时间栅栏、有界 Live 主线程分发、绑定 epoch 的引用/
  游标、签名订阅、规范注册表协商,以及只读 preflight → 不可预测确认 →
  一次性变更授权协议。稳定的事务域重放键包含规范参数摘要;有界的桥接
  epoch 已执行结果账本在 TCP 响应丢失时存活,且不混淆步骤或事务。精确
  的同键对账要求不变的桥接/Live epoch;已验证事务会注销其账本条。
- Live 12.4.5b8 的真实 Live 发现与受护栏生命周期证据:走带;Session
  剪辑启动/停止/紧急停止;MIDI 音符与剪辑;Arrangement 剪辑与定位点;
  混音器;Session 自动化;嵌套设备、rack/chain/pad/macro;Browser
  搜索/加载;路由;Session 与 Arrangement 录音;工程路径/清单/备份;
  订阅;以及实时 UDP JSON/OSC/XY 和有界的 `max` 标签扩展数据包(不是
  Max 能力)。
- 应用视图控制(Session/Arranger 切换、Arrangement 缩放/滚动/跟随、
  轨道折叠)、定位点下一个/上一个播放头导航、剪辑静音/颜色/MIDI 循环
  编辑,以及文件支持的 Arrangement 音频导入,均带 preview/confirm/verify
  事务,并在状态可恢复处提供受护栏撤销。这些已在宿主、模拟器、Python
  契约与打包 fake-Live 层面验证;精确候选的真实 Live 证明待完成。
- 按节拍时间的 warp 标记读取与原生添加/移动/删除,带集合栅栏与精确
  回滚;带显式文件权限的 Session 音频导入(允许根、规范化路径、大小/
  类型检查、SHA-256 并在应用时重新验证、事务自有清理);剪辑裁剪、
  循环/区域复制、刮擦与播放位置移动;按 ID/选择读取音符、定向复制与
  时间/音高量化,带精确先前内容撤销;以及计数、存在性栅栏的剪辑全部
  包络清除。破坏内容的操作(裁剪、包络清除)诚实不可撤销。已在宿主、
  模拟器、Python 契约与打包 fake-Live 层面验证;精确候选的真实 Live
  证明待完成。
- `Track.take_lanes` 的 take lane 发现(有界行与快照内稳定引用)、lane
  重命名、现有 lane 内文件音频剪辑创建,以及剪辑行的
  `is_take_lane_clip` 暴露。映射器/注册表还实现 lane 创建与 MIDI lane
  剪辑创建,但当前公共 MCP 工具模式未宣告这些路径。公共 LOM 不提供
  take-lane 删除/试听或 comp 区域编辑。公共路径已在宿主、模拟器、Python
  契约与打包 fake-Live 层面验证;精确候选的真实 Live 证明待完成。
- `Song.tuning_system` 与音阶状态暴露(名称、音域、参考音高、伪八度
  音分与全部 128 个音符偏差,以及根音、音阶名称/模式与音程),带完整
  状态修订栅栏、长度/范围验证、精确回滚与经 `live_undo` 的完整状态
  恢复。律制编辑全局影响播放音高,已明确标注。已在宿主、模拟器、
  Python 契约与打包 fake-Live 层面验证;精确候选的真实 Live 证明待
  完成。
- `Song.groove_pool` 与 `groove_amount` 暴露,含池发现与 groove 名称、
  base、量化/随机/时值/力度量的读写,以及 `Clip.groove` 分配与剪辑行
  的 `Clip.has_groove`。量与 groove 编辑经 `live_undo` 精确恢复;剪辑
  groove 分配走剪辑属性事务。公共 API 没有完整的 groove 导入/提取
  工作流,因此 groove 必须已存在于池中 —— 如实记录,不做变通。已在
  宿主、模拟器、Python 契约与打包 fake-Live 层面验证;精确候选的真实
  Live 证明待完成。
- 场景颜色、空/触发/触发按钮状态、速度与 `tempo_enabled`、拍号分子/
  分母/启用 —— 在场景行上读取,并经一个带栅栏的事务编辑,带精确回滚
  与 `live_undo` 恢复。剪辑槽行现暴露颜色、`controls_other_clips`、
  停止按钮、组槽、播放与启动即录状态。`Scene.fire_as_selected` 作为
  独立的直接触发动作交付:带栅栏、可发声、明确不可撤销,并与受护栏
  场景试听工作流区分记录。已在宿主、模拟器、Python 契约与打包
  fake-Live 层面验证;精确候选的真实 Live 证明待完成。
- 全面的歌曲状态读取:可见轨道、指定设备、歌曲长度/起点、拍号、摆动、
  overdub/arrangement overdub、回到编排水位、可捕获/撤销/重做、独占
  arm/solo、预备拍中、速度跟随、自动化重启用、Session 录音/自动化与
  Ableton Link 启用/起停同步,另有节拍↔SMPTE 与循环时间换算。瞬时走带
  动作(开始、继续、停止、播放选区、刮擦、打点测速、微调、重启用自动
  化、触发 Session 录音、强制 Link 节拍时间)以带栅栏、不可撤销动作
  交付,可发声动作有标注;紧急停止保持独立权限。`CuePoint.jump` 加入
  定位点导航。原始 Song 撤销/重做刻意不作为变更暴露:它会绕开事务
  自有回滚与恢复,因此只上报 `can_undo`/`can_redo` 状态并记录该决定。
  已在宿主、模拟器、Python 契约与打包 fake-Live 层面验证;精确候选的
  真实 Live 证明待完成。
- 扩展混音控制:轨道激活器、交叉推子、交叉分配、声像模式与分离立体声
  左/右声像,带精确恢复;主轨道的语义歌曲速度参数在其混音行上只读
  暴露,速度工作流保持单一来源。Rack 链混音器(音量、声像、发送、链
  激活器)经类型化链面,以及设备级路由(设备 IO 类型/通道,Live 暴露
  处的 `default_external_routing_channel_is_none`)与压缩器侧链选择
  经另一类型化面 —— 轨道路由、链路由与设备侧链路由在设计上保持
  分离。已在宿主、模拟器、Python 契约与打包 fake-Live 层面验证;精确
  候选的真实 Live 证明待完成。
- 深层设备与参数面:参数行现暴露默认值、原名、状态、枚举项与显示值语义;
  设备行暴露参数库、对比能力与活动侧、类显示名/类型、延迟以及(按形态
  协商的)折叠视图状态。参数库编辑精确恢复;自动化重启用与 A/B 对比
  保存以瞬时动作交付;链设备插入为空所有者守卫;跨轨道/链设备移动经
  `Song.move_device`,带精确反向移动撤销。可写 bypass 绝不从只读
  `Device.is_active` 推断 —— 只使用名称无关探针验证的 Device On 参数。
  已在宿主、模拟器、Python 契约与打包 fake-Live 层面验证;精确候选的
  真实 Live 证明待完成。
- 链、机架、宏与鼓垫面:链颜色/索引、自动颜色、音频/MIDI 输入输出
  标志、独奏致 mute 与类型化链混音器在行上,链颜色/静音/独奏编辑精确
  恢复;鼓链输入/输出音符与窒息组;鼓垫音符/独奏编辑带精确恢复,以及
  显式、诚实不可撤销的 `delete_all_chains`;机架返回链、宏映射状态、
  所选变体与可见宏数量在行上;宏添加/移除/随机化、机架链插入、垫
  复制与变体保存/召回/删除作为瞬时动作;机架视图所选链/垫、垫滚动
  位置与链设备可见性,带精确恢复。已在宿主、模拟器、Python 契约与
  打包 fake-Live 层面验证;精确候选的真实 Live 证明待完成。
- 专用设备 API:Drift 调制矩阵源/目标列表、弯音范围与复音数/模式;
  鼓单元语义增益;Eq8 编辑与全局模式、过采样与所选频段;Hybrid Reverb
  IR 类别/文件选择及 attack、decay、size、time 塑形;Meld 所选引擎、
  齐奏、单/复音模式与复音数;Max 设备音频/MIDI IO 描述符在行上;插件
  预置发现/选择与编辑器窗口状态(读/写);Looper record/overdub/play/
  stop/clear/undo/export 作为瞬时动作,以及速度、循环长度、速度与固定
  录音长度带精确撤销;按能力协商的 Simpler `replace_sample`,带与音频
  导入同级的显式文件权限与逆向替换撤销。每个家族仅在设备类与成员在
  所连 Live 构建上存在时才宣告;首个支持的 Live 版本记录在能力矩阵中。
  已在宿主、模拟器、Python 契约与打包 fake-Live 层面验证;精确候选的
  真实 Live 证明待完成。
- 对文档可观察状态的协商有界观察者模型:走带、选择、轨道(arm/mute/
  solo/fold/freeze/routing)、剪辑(播放、音符、warp 标记、循环、启动)、
  设备与参数值/状态、机架链/垫/宏/变体、律动与律制、场景速度/拍号/
  触发,以及电平/性能。订阅受配额限制(8 并发、各 64 主题),按修订摘要
  去重并列变更字段,显式溢出,围栏至协商最小轮询间隔,每个事件携带
  修订与身份 —— 均非变更权限。拉取式轮询模型如实记录为背压设计(无
  无界推送队列),与现有五属性订阅通道并存。已在宿主、模拟器、Python
  契约与打包 fake-Live 层面验证;精确候选的真实 Live 证明待完成。
- 性能与延迟诊断:`Application.average_process_usage` 与
  `peak_process_usage`、逐轨道输入/输出电平表与 `performance_impact`、
  以采样和毫秒计的设备延迟,合并为一次有界按需采样。遥测仅为时间点
  证据 —— 电平表是 Live UI 表头,绝非解码音频分析;采样模型(单次
  有界读取、无流式队列、无保留历史)如实记录而非暗示。已在宿主、
  模拟器、Python 契约与打包 fake-Live 层面验证;精确候选的真实 Live
  证明待完成。
- Song.View 选择(轨道、场景、高亮槽、详情剪辑、设备、参数、链)与
  绘制模式,带精确恢复;剪辑视图网格量化、三连音、包络可见与
  show-loop;设备折叠状态(仅在 Live 支持处暴露);Application.View
  主视图切换/隐藏/聚焦、缩放/滚动、跟随播放、轨道折叠与 Browser
  模式切换;以及应用对话框面 —— 状态读取加一个受护栏的按钮按下,
  因为对话框按钮可能有破坏性,预览的对话框状态一变即拒绝。Device.View
  折叠保持按形态协商:Live 未暴露时,操作报告不可用而非假装。已在
  宿主、模拟器、Python 契约与打包 fake-Live 层面验证;精确候选的真实
  Live 证明待完成。
- 轨道行现暴露编组关系、可见性、选中成员、冻结/折叠状态、隐式 arm、
  回到编排水位、独奏致 mute、全部输入/输出电平表与性能影响,以及
  Track.View 选中设备、设备插入模式与折叠状态。受护栏的返回轨道创建
  (带清理)与显式返回轨道删除(诚实不可撤销)、受护栏的轨道与场景
  复制、带精确兄弟栅栏的现有设备删除(明确不可撤销),以及带精确恢复
  的轨道视图编辑。剪辑槽复制由现有 `clip.duplicate` 槽到槽操作提供,
  运行中剪辑跳转由 `clip.action`(move-playing-position)提供,直接
  全部停止由走带动作提供 —— 均在各自工具处记录。已在宿主、模拟器、
  Python 契约与打包 fake-Live 层面验证;精确候选的真实 Live 证明待
  完成。
- 用途特定的 preview/apply/verify/undo 或清理工作流:精确的对象与层级
  身份、状态/内容修订、创建时指纹、epoch、过期、幂等、新鲜事后状态、
  有界补偿与显式不确定状态。原子 Session 剪辑移动在 Live 主线程上运行
  复制/删除/补偿。能力目录从域能力与精确协商操作集两方面对每个 Live
  工具分类;不支持或部分支持的 Live 形态保持为已协商的限制。
- 实时授权受回环端点、不可预测令牌、TTL、源端口、通道、精确参数引用、
  数据包/速率/队列边界、序列/重放检查、代际隔离、已验证写入、XY 补偿、
  遥测、disarm 以及独立 TCP 紧急停止约束。
- `pcm-analysis/v2`:隐私保护的波形、频谱、时频、瞬态、声道、相位、动态、
  削波与确定性聚合分析。
- ITU-R BS.1770-5 / EBU R128、Tech 3341、Tech 3342 节目响度、瞬时/短期
  量度、响度范围、语义声道权重,以及经验证的 44.1/48 kHz 真峰值。生成的
  独立 FFmpeg 对照证据被跟踪;不存储第三方音频。
- 有界 48 kHz 参考对比:带限重采样、由粗到精对齐、歧义拒绝、标准电平
  匹配与聚合差值。不可信的自动对齐保留各自的独立分析,但扣留重叠、比较
  差值与增益建议。
- 一次性密钥剥离分析 worker:两个活跃/四个排队任务限制、墙钟/输出/内存/
  请求边界、取消即杀、结果中无原始 PCM。
- 仅真实 Live 的知情同意 Session Resampling 捕获:精确源与空目标、十秒
  映射器看门狗、立即恢复启动量化、可独立恢复的停止、内部 WAV 验证、标准
  分析、信号链关联的非因果诊断、事务自有剪辑删除、WAV/ASD 解除链接与
  零残留回读。参见 [AUDIO_INTELLIGENCE.md](AUDIO_INTELLIGENCE.md) 与
  Phase 8 证据文件。
- 五个能力感知创作旅程:可编辑节拍/歌曲创作、进阶鼓组、自有/原生声音
  设计、标准参考对比,以及混音/录音/演出诊断。计划暴露有序文本进度、
  影响标签、精确确认边界、验证、恢复、权利感知的高层特征翻译、无障碍
  范围、逐阶段能力/来源协商与诚实回退。参见
  [USER_JOURNEYS.md](USER_JOURNEYS.md)。
- 打包产物生产旅程、Python 映射器测试、属性测试、隔离资源基准、兼容性/
  软件包验证与 Windows 权限加固。
- MIT 许可、本地/未发布的 release-v2 暂存:独立且精确的 77 文件允许列表、
  完整负载哈希、打包许可证字节相等,以及干净 SHA/工具链/锁/工作流来源。
  `private: true` 仅防止意外发布,不改变 MIT 权利。发布工作流要求全新克隆
  字节级可复现,并在 Ubuntu 24.04、macOS 15 与 Windows Server 2025 上的
  Node 22/24/25 之间共享同一精确候选。
- 回执驱动的安装、诚实的手动激活、严格的更新版本升级、精确回滚、回执
  绑定的修复/隔离、保留清理、所有权安全的卸载/清除与状态。生命周期验证
  实际 tarball 字节/清单、所有者权限、链接/联接点祖先、端口、锁、代际、
  软件包/配置/Remote Script 完整性与可恢复故障状态。显式的仅安装诊断
  选项配置一个描述符隔离的 owner 文件;固定脱敏记录在回调线程外排队,
  上限 256 KiB,并在漂移/写入失败时禁用。旧版/v1 到 v2 迁移显式且保留密钥。

- 能力感知的工具发现与部署策略配置档(`read-only`、`edit-no-audio`、
  `performance`、`full`)及 allow/deny 覆盖:`tools/list` 从单一声明式
  目录只宣告当前可执行且被策略允许的工具;连接/断开/epoch/操作集/策略
  变化时发出 `notifications/tools/list_changed`,并通过专用内部状态通道
  在适配器刷新/重连/断线时即时宣告;策略在派发与撤销派发时按名称强制。
  `performance` 配置档保留受护栏撤销/恢复,事务绝不搁浅。已协商限制
  (工程 save/open)从可调用发现移入能力资源。经宿主、模拟器与 fake-Live
  层级验证。
- 确定性带种子 MIDI 变换(`live_midi_transform_preview/apply`):transpose、
  scale-constrain、quantize、swing、velocity 曲线、带种子 humanize/variation、
  legato、staccato、rotate、repeat、ratchet、chord voicing 与 arpeggiate,
  带精确 diff 预览、修订栅栏、生成型 duplicate-first 范围与 MPE 保留探针。
  音符变更按注册表上限分块执行,每块对照期望中间音符集设栅栏;精确键
  重试在中途失败后按内容身份恢复已记录计划。原位撤销要求身份绑定的
  已验证变换后状态。经宿主、模拟器与属性测试层级验证;不新增真实 Live
  声明。
- 安全的 Browser 检查(`live_browser_inspect`)与加固的单文件 Session
  音频导入:在既有的所有者白名单、哈希校验、事务清理之上,新增容器魔数
  与声明格式一致性校验;MIDI 文件被明确拒绝。
- 只读探测:`live_arrangement_automation_read`(分页 Arrangement 包络
  发现;写入保持保留)、`live_take_lane_read` 与 `live_comp_read`(有界
  lane/comp 清单,显式报告不支持的关系)、`live_warp_marker_read`(有界
  标记诊断:修订、单调性检查与只读变更可行性)。映射器状态携带尽力而为
  的环境探针(Live 版本/版本类型、OS、API 表面)用于工件绑定证据。

## 证据边界

[`../evidence/`](../evidence/) 下受跟踪的证据区分确定性 fake-Live、
打包桥接与真实 Live 观察。Phase 8 真实 Live 证据由已安装的 `npm pack`
产物针对 macOS Live 12.4.5b8 产生,包含取消与宿主重启/看门狗恢复。它不是
Windows Live 证明,也不证明签名/公证或发布。

本地受保护的 `extensions-sdk-1.0.0-beta.0` 保持排除:不得打开、复制、
暂存、打包或引用为实现证据。

## 诚实的限制

- 任意删除设备与 Arrangement 剪辑被拒绝,因为先前状态无法重建。只有
  通过受护栏撤销的、精确事务创建身份 + 层级 + 创建指纹的清理可用。
- Live 的保存/打开/新建/导出/收集/bounce、Arrangement 自动化、take lane
  删除/试听、comp 区域编辑与 Browser 音频预览,在观察到的 API 没有权威
  操作时保持不可用。Warp 标记编辑和有界的 take lane 发现/重命名/文件
  音频导入仅在精确操作已协商时公开。仅映射器实现的 lane 创建与 MIDI lane
  剪辑路径不是公共 MCP 能力。未支持的规范契约经过测试,但在适配器能执行
  并验证之前保持不宣告。
- 不声明 Max for Live `.amxd`、插件 UI 控制、流式 PCM 分接、任意路径/URL
  分析、沉浸式/对象响度布局、自动母带判定或取证级安全擦除。
- 真峰值目前在 44.1 与 48 kHz 验证;其他采样率报告不可用。
- Live 捕获需要已保存的 Set、WAV 录音、可选择可恢复的目标路由、显式
  同意/输出安全与真实 Live 来源。
- 当前受跟踪的真实 Live 证明在 macOS 上,且仍是候选特定的。托管宿主/
  软件包证据仅在完整精确 SHA 矩阵为绿时有效;历史运行不转移到更新的
  提交。性能仍是独立于 V8 覆盖率的未插桩门禁。
- stdio 旅程界面是文本优先的,没有服务器自有视觉焦点;但第三方 MCP
  客户端、Ableton Live 与插件窗口中的 VoiceOver/Narrator 行为取决于
  客户端/版本,不作声明。
- 原生签名/公证、Windows 桌面/真实 Live 证据、外部 VoiceOver/Narrator/
  客户端证据与公开发布均不适用于当前渠道。该渠道明确保持本地、未签名、
  未公证、未发布;`private: true` 只防止意外发布,不改变 MIT 权利。这些
  外部单元格不从宿主 CI 或服务器自有文本无障碍契约推断。

## 操作规程

客户端契约见 [USER_GUIDE.md](USER_GUIDE.md)、
[USER_JOURNEYS.md](USER_JOURNEYS.md)、
[AUDIO_INTELLIGENCE.md](AUDIO_INTELLIGENCE.md) 与
[REALTIME_CONTROL.md](REALTIME_CONTROL.md);监督见
[OPERATIONS.md](OPERATIONS.md);不确定状态见 [RECOVERY.md](RECOVERY.md);
发布门禁见 [TESTING.md](TESTING.md)。
