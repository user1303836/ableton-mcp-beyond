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
- Live 的保存/打开/新建/导出/收集/ bounce、Arrangement 自动化、warp
  标记编辑、take/comp 编辑与 Browser 音频预览,在观察到的 API 没有权威
  操作时保持不可用。严格的保留规范契约经过测试,但在适配器能执行并验证
  之前保持不宣告。
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
