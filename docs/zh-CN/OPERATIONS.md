# 运维指南

[English](../en/OPERATIONS.md) · 简体中文 · [日本語](../ja/OPERATIONS.md)

日常使用中的运行、监督与关停。故障后的不确定状态处理见
[RECOVERY.md](RECOVERY.md)。

请在 stdout 与 stderr 分离的监督器下运行宿主。

## 启动与观察

```sh
cd apps/mcp-server
npm ci
npm run build
node dist/src/cli.js --config /absolute/path/bridge-config.json
```

初始化后使用 `server_status`、`capabilities` 与 `live_status`。有效的
`live_status` 会标识 `ableton-live/v1`、已连接的 `remote-script` 适配器、
非空 epoch、预期的注册表哈希以及已协商的操作。`live_snapshot` 与有界发现
提供主动的只读检查。试听(audition)之前,请先发现精确的 Set、场景、目标
轨道/槽位与 Session 播放状态;诊断发现并不授权启动。

诊断接受零个参数或恰好一个 `--config PATH`:

```sh
npm run diagnostics -- --config /absolute/path/bridge-config.json
```

诊断会把本地宿主/软件包/配置就绪度,与已认证可达性、发现可达性、注册表
哈希、epoch、协议和 `liveConnected` 分开报告。文件、进程、开放端口、已
安装软件包、模拟器或 fake-Live 结果都不能证明真实的 Live 连接。

## 限制与关停

宿主限制:JSON-RPC 帧 64 MiB;远程帧 1 MiB;远程待处理工作 64 个请求;
跟踪的请求标识符 4096;工具调用每滚动分钟 120 次。Stdio 允许有界并发
(默认 16,最大 64),在配置并发四倍处施加背压,保持响应顺序,并把分发
后的取消视为不可撤回。PCM 分析限制为 10,000,000 采样 / 600 秒;参考
对比限制为 4,000,000 采样 / 每源 30 秒 / 10 秒延迟。DSP 在最多两个活跃、
四个排队的一次性 worker 中运行,限制为 512 MiB 堆、30 秒墙钟、64 MiB
请求、2 MiB stdout、16 KiB stderr。Live 捕获限制为一个映射器自有的生命
周期、一到九秒的请求时长、十秒看门狗、32 MiB WAV、12 秒、两个声道。

正常结束请关闭 stdin。EOF、信号、初始化失败、取消、输出失败、超时或断连
时,宿主关闭适配器并结清待处理工作;重新初始化以获得新 epoch。场景试听的
断连、超时或确认丢失属于不确定的播放状态,而不是安全的重试条件。

## 实时操作

配置了 `realtimePort` 本身并不授予权限。使用
`live_realtime_arm_preview`/`apply`,把返回的令牌保持在日志之外,检查
`live_realtime_stats`,并始终调用 `live_realtime_disarm`。已接受的 UDP
数据包与已应用的 Live 线程回调是两个独立的计数器。端点、重放、速率、
队列、过期与代际隔离的丢弃都是显式的。数据包格式、限制、OSC/XY/Max
扩展语义与恢复见 [REALTIME_CONTROL.md](REALTIME_CONTROL.md)。

## 域与扩展边界

重命名、Browser 加载与音频剪辑变更使用用途特定的 preview/apply/undo
事务;通用的已认证 `invoke` 不是面向用户的变更授权。Browser 加载需要新鲜
的精确 `browser.inspect` 设备身份。音频编辑按剪辑逐字段协商;warp 标记
回读不授予标记编辑权限。订阅只协商有真实生产者的的事件类型
(`transport`、`object` 与协议 `reset`)。合并未送达的相邻事件会保留其
序列;真实的队列溢出或 epoch 变化会发出 `reset`,而 reset 或序列缺口
要求全新快照。

`ableton://max-extension` 如实报告未捆绑 Max 设备。规范的
`project.new/open/save/save-as/collect/export/bounce` 标识符为未来的
适配器契约保留,但当前适配器不宣告也不执行它们。本地 `project.info` 与
绑定回执的 `.als` 备份仍是仅有的工程操作。

## 录音操作

Session 与 Arrangement 录音开始都要求精确的 armed 目标、明确意图与输出
安全证据。映射器会原子地复检两个先前的录音布尔值以及目标与安全授权。
不确定之后不要再发出第二次开始或新键:在不变的桥接/Live epoch 内,只对
原事务与键进行对账;否则先发现新鲜播放状态,然后使用
`live_session_emergency_stop`,携带精确的活跃目标并把 `expectedRecording`
设为新鲜观察到的 `stopped`、`session`、`arrangement` 或 `both` 模式,以
清除播放与两种录音模式;验证 `recordingStopped=true` 与新鲜的停止状态。

## 音频捕获监督

捕获前,记录精确的 Set、源/目标槽位、目标路由/arm/监听基线、播放/录音
状态、输出安全来源,以及原始文件目录计数。不要仅凭端口/进程存在进行监督;
要求 `real-live` 来源与全部规范捕获操作。

应用期间,MCP 请求可能保持打开,时长为请求时长加有界的收尾/分析时间。取消
不发出 MCP 响应,但宿主会继续独立的停止/清理;请从全新客户端等待
`live_audio_capture_status`。宿主被杀不会移除映射器授权:Live 侧看门狗会
停止录音,新的打包宿主可以用精确观察到的身份运行
`live_audio_capture_emergency_stop`。

通过完成的条件是:映射器状态 `cleaned`、`playbackStopped=true`、走带/
Session/Arrangement 录音均为 false、路由/arm/监听已恢复、目标槽位为空、
`rawFileUnlinked=true`,且无 WAV/ASD 残留。绝不要记录确认、映射器/恢复
令牌、PCM 或媒体路径。参见 [AUDIO_INTELLIGENCE.md](AUDIO_INTELLIGENCE.md)。

## 交付生命周期监督

使用 `ableton-mcp-lifecycle`;直接的 Remote Script 复制器是更低层的开发
原语,不是完整的产品生命周期。始终先审阅不变更的计划;安装/升级/回滚/
卸载前显式停止 Live;保留精确的 tarball SHA、回执、日志与任何隔离路径。
回滚可用时,绝不要在回执之外删除或编辑备份。

变更后,状态必须显示匹配的受管哈希、owner-only 密钥权限、适当停止/卸载
的 Live,以及在手动选择 Control Surface 并经认证的真实 Live 激活之前的
`restartRequired`。`activated` 要求注册表身份与 `real-live` 来源;空闲
端口、进程、伪造映射器或模拟器都不满足。修复会把漂移隔离,绝不凭空
生成缺失的密钥。卸载默认保留被修改/未知的内容与密钥。精确的命令与
Windows/macOS 路径策略见 [DELIVERY.md](DELIVERY.md)。

## 证据边界

Node/Python 测试、模拟器、fake-Live 映射器、已认证回环检查、软件包验证
与基准,只建立仓库可控的契约。它们不证明真实的 Ableton Live 版本、一次性
Set、可见 UI 状态、可发声/实时行为、硬件、无障碍、安装器运行时、签名、
公证或发布就绪。
