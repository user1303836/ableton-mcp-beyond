# 音频智能与知情同意的 Live 捕获

[English](../en/AUDIO_INTELLIGENCE.md) · 简体中文 · [日本語](../ja/AUDIO_INTELLIGENCE.md)

音频工具链:调用方提供的 PCM 分析、参考对比、Live 上下文诊断,以及 ——
仅在真实已认证桥接下 —— 知情同意的 Session Resampling 捕获。

## 能力边界

音频智能有三个截然不同的来源,绝不能混淆:

1. `audio_analyze` 接受调用方提供的交错 little-endian float32 PCM。它绝不
   把该 PCM 归因于 Live。
2. `audio_compare_reference` 接受两个调用方提供的 PCM 源。它进行重采样、
   对齐、电平比较,只返回聚合。
3. `live_audio_capture_preview/apply` 仅当已认证的 `real-live` Remote
   Script 协商了全部 `audio.capture.*` 操作与 `audio.capture.resampling`
   时可用。它把 Live 的 Resampling 输入录制到一个精确的空音频 Session
   槽位,分析生成的有界 WAV,然后移除事务自有的 Live 剪辑与原始媒体。

Remote Script 不暴露 PCM。第三个工作流是用途特定的 Live 录音生命周期,
不是虚构的映射器分接(tap),也不是 Max for Live 声明。

## 标准分析

`pcm-analysis/v3` 保留 `standardsAudio`,同时保留旧的
`loudness.rms-derived-proxy` 字段,仅作为明确弃用的兼容值。它把归一化源采样
到达满刻度边界的 `clipping`,与带限参考对比重建所产生的 0 dBFS 以上数值
`reconstructedOvers` 区分开来。重建过冲不能证明源发生削波。交付或母带决策
必须使用 `standardsAudio`,而不是兼容代理值。

标准结果标识:

- ITU-R BS.1770-5 节目响度;
- EBU R128 运行语义;
- EBU Tech 3341 瞬时(400 ms)与短期(3 s)量度;
- EBU Tech 3342 响度范围,含 −70 LUFS 绝对门限、−20 LU 相对门限,以及
  文档化的 R-7 百分位;
- 400 ms 积分块、100 ms 步进、−70 LUFS 绝对门控与 −10 LU 相对门控;
- 语义声道标签与权重。单声道与立体声可推断;更大的布局需要显式的
  `M`、`L`、`R`、`C`、`Ls`、`Rs`、`LFE` 标签。LFE 被排除,环绕声道
  使用常规的 1.41 权重;
- 采样峰值与真峰值分开报告。

在 48 kHz 下,真峰值使用 BS.1770-5 附录 2 公布的 48 阶四相 FIR 系数。在
44.1 kHz 下,先以有界 64 抽头 Blackman-sinc 转换到 48 kHz,再进入该附录 2
内插器。其他采样率返回真峰值不可用,而不是默默地用采样峰值替代。节目响度
通过按采样率推导的 K 加权滤波器支持 8 到 384 kHz 的整数采样率;48 kHz
使用精确公布的系数。

静音、时长不足、未知多声道布局以及超出真峰值工作边界的输入,返回显式的
不可用/null 值,绝不返回 NaN、无穷或编造的测量值。瞬时与短期序列是有损
的,上限 128 点;门控仍使用全部有界窗口。

独立验证使用生成的、可再分发的 PCM 与 FFmpeg 的 `ebur128` 实现。不提交
任何第三方测试音频。运行:

```sh
cd apps/mcp-server
npm run audio:oracle
```

受跟踪的对照报告是
[../evidence/phase-8-audio-oracle.json](../evidence/phase-8-audio-oracle.json)。
声明的比较容差为 48 kHz 下 0.1 LU/dB,经验证的 44.1 kHz 转换为
0.15 dBTP。主要规范仍然是权威;FFmpeg 是独立实现检查,而不是规范定义。

## 隔离分析与取消

生产 MCP 分析不在宿主事件循环上同步运行。`AnalysisRunner` 启动一次性
Node 子进程,限制为:

- 最多两个活跃任务、四个排队任务;
- 512 MiB V8 堆上限;
- 30 秒墙钟截止时间;
- 2 MiB stdout 与 16 KiB stderr 限制;
- 64 MiB worker 请求限制;
- 不继承应用密钥;
- MCP 取消或超时时立即终止子进程。

只有 JSON 聚合结果传回。worker 不接受 URL 或文件系统路径。公开工具只接受
归一化 PCM;Live 捕获文件路径属于已验证捕获生命周期的内部。

## 参考对比

`audio_compare_reference` 支持 32–96 kHz 单声道/立体声源(其固定 32 抽头
内核的验证范围),两个源合计最多四百万输入采样,每源最多 30 秒,对齐
延迟最多 10 秒。它会:

1. 用确定性的 32 抽头 Blackman 窗 sinc 重采样器把每个源转换到 48 kHz;
2. 执行 100 Hz 粗包络搜索,随后 1 kHz、±10 ms 精细搜索,避免无界的二次
   精细相关;
3. 拒绝微弱、静音或相互竞争的自动匹配;手动与禁用对齐模式是显式的;
4. 只在可信对齐时分析相等的重叠;自动对齐不可用时,保留各自的独立分析,
   但重叠设为零,所有比较差值/电平匹配建议设为不可用;
5. 当两个源都合格时,报告 BS.1770 积分电平差与有界的 ±24 dB 建议匹配值;
6. 报告响度、真/采样峰值、RMS、波峰因数、动态范围、频谱与瞬态密度差值,
   不返回对齐后的 PCM。

`reference-analysis/v2` 在 `resampling.*.sourceClipping` 中报告源域边界计数。
对于实际转换到 48 kHz 的源,嵌套分析把 0 dBFS 以上的重建值单独报告为
`reconstructedOvers`,绝不把它误称为源 `clipping`。有损振幅直方图会按有界
重建范围缩放,因此不会再把所有大于 1 的值压进最后一个区间。

重采样不是时间拉伸或速度匹配。建议的电平匹配不改变任何音频。

## 信号链关联诊断

`audio_diagnose_live_context` 把调用方 PCM 测量与一个新鲜的轨道快照关联,
但把该关系标记为调用方声明且未经核实。映射器自有的捕获分析把关系标记为
`verified-by-capture-lifecycle`。诊断包括精确的 Set、轨道、混音器/路由
引用、有序设备引用,以及有界的已发布参数值。

结论区分测量与假设。设备存在绝不被称为因果。缺失的延迟、侧链拓扑、隐藏
参数、增益衰减以及精确的设备内分接位置都被明确命名。混音器预览建议(如有)
是一个可逆的归一化控制实验,需要显式确认与同范围重新捕获;它不是承诺的
dB 校正。`causality.claimed` 始终为 false。

## Live Resampling 生命周期

### 预览

`live_audio_capture_preview` 要求:

- `real-live` 来源与全部六个规范捕获操作;
- 精确的一次性 Set 名称;
- 一个精确的源 Session 剪辑槽位与一个不同的精确空音频槽位;
- 可恢复且当前可用的目标输入路由;
- 走带停止、Session 与 Arrangement 录音关闭、无活跃目标、所有轨道未
  armed、无输入监听轨道;
- 一到九秒的请求时长;
- `consent=ephemeral-analysis-and-delete`;
- 新鲜的非模拟器输出安全证据。

如果 Live 陈旧的 `Ext. In` 路由不再可选择,操作者可能需要在预览前选择
一个可用的安全路由,例如 `No Input`。这是显式的常规路由事务,而不是隐藏
的捕获副作用。

### 应用与看门狗

应用需要不可预测的预览确认与幂等键。在 Live 主线程上,
`audio.capture.start` 复检源/目标轨道/槽位对象身份与完整栅栏,临时给目标
轨道一个未暴露的随机所有权标签,在该精确目标上设置 Resampling、监听关闭
与 arm,临时把启动量化设为立即,并恰好触发目标与源槽位。异步出现的剪辑
只有在 Live 标记为录音中且其名称携带该私有标签时才被认领;随后恢复目标
名称与启动量化。它绝不自动重试开始。

映射器看门狗的硬性上限是十秒。宿主停止、取消、看门狗到期、紧急停止与桥接
关闭,都会停止精确的源与目标槽位/轨道,停止走带与录音,恢复位置、名称、
路由、arm 与监听,并在播放或自有剪辑仍在录音时重新断言停止。桥接/Live
拆除无法自行解除媒体链接:它有意把自有的剪辑/路径保留为可见的宿主或人工
清理残留,而不是删除唯一的恢复身份。外部编辑被报告为残留状态,而不是被
静默覆盖。

### 获取与拆除

只接受已保存工程目录或常规 `User Library/Samples/Recorded` 边界内新鲜的
常规、非符号链接、单链接 WAV。文件必须不超过 32 MiB、12 秒、两个声道,
并使用受支持的 PCM16/24/32 或 float32 封装。读取期间,身份、大小、mtime
与 SHA-256 受到隔离。公开响应包含格式/采样率/声道/时长摘要,但不含原始
路径、摘要、PCM、令牌或确认。

隔离分析之后,宿主以 no-follow 描述符语义打开 WAV/ASD,复检设备/inode/
链接数/摘要身份,把已验证的 inode 移入随机的 owner-only 同文件系统隔离区,
截断并解除链接。只有在原始清理成功后,`audio.capture.cleanup` 才删除精确
的事务自有 Live 剪辑。随后对分析/清理期间创建的 `.asd` 执行有界的剪辑后
稳定缺失扫描,并验证媒体路径与隔离残留都不存在。这个顺序在宿主故障时保留
Live 的路径/剪辑恢复身份。"已删除"指经验证的解除链接;不是对 SSD 或
写时复制存储的取证级擦除承诺。最终回读必须显示停止/未录音的播放、已恢复
的目标状态、空槽位、映射器状态 `cleaned`,且无残留原始文件。

## 独立恢复

`live_audio_capture_status` 隐去映射器令牌与媒体路径。
`live_audio_capture_emergency_stop` 要求
`confirmation=emergency-stop-and-clean` 以及新鲜观察到的精确捕获/源/目标
身份。它在宿主重启后仍有效,通过已认证桥接获得映射器持有的恢复授权,停止
捕获,安全地重新验证/隔离/解除原始文件链接,然后才删除自有剪辑。如果路径、
身份、文件格式或清理无法证明,它返回不确定的残留状态,而不删除任意文件。

签入的操作者运行器是
`apps/mcp-server/scripts/verify-phase8-live.mjs`(`npm run audio:live-verify`);
其所需回执、干净 Git SHA、精确产物与注册表摘要、已安装字节验证以及新鲜
输出安全输入,记录在 [TESTING.md](TESTING.md) 中。真实 Live 打包证据 ——
包括正常捕获、受控再捕获、已证明的 MCP 响应抑制、宿主死亡后的映射器
看门狗、独立恢复以及零原始/隔离残留 —— 跟踪在
[../evidence/phase-8-audio-live.json](../evidence/phase-8-audio-live.json)。

## 明确限制

- 不声明 `.amxd` 设备、流式 Max for Live 分接、插件 UI 表头、任意路径、
  URL 抓取、时间拉伸、母带等级或自动合规判定。
- 真峰值目前只在 44.1 与 48 kHz 验证。
- 支持常规语义声道标签;沉浸式/对象布局不可用。
- Live 捕获仅限 WAV,且需要已保存的 Set 与可恢复的路由。
- 原始解除链接不能承诺取证级媒体擦除。所有者账户是本地信任边界:已经
  以同一用户运行的恶意进程可以读取 owner-only 桥接密钥,这超出威胁模型;
  no-follow、链接数、inode、摘要与私有隔离检查防御的是该边界内的意外/
  陈旧/路径替换危害。
- 真实 Live 证据是 macOS Live 12.4.5b8 证据,不是 Windows Live 证明。
