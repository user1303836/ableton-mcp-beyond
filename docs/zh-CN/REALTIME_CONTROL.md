# 实时控制平面

[English](../en/REALTIME_CONTROL.md) · 简体中文 · [日本語](../ja/REALTIME_CONTROL.md)

一个可选的、独立布防的 UDP 端点,用于短时高速参数控制 —— 除非显式配置,
否则处于禁用状态;即使启用也受到严格隔离。

当版本 2 桥接配置包含独立的 `realtimePort` 时,生产 Remote Script 可以暴露
一个回环 UDP 端点:

```json
{
  "bridge": {
    "host": "127.0.0.1",
    "port": 9765,
    "realtimePort": 9766,
    "secretFile": "/absolute/owner-only/bridge.secret",
    "timeoutMs": 5000
  }
}
```

用 `ableton-mcp-setup --realtime-port 9766` 生成此结构。TCP 与 UDP 监听器
都只绑定到配置的数字回环地址。端口冲突会使启动失败,而不是静默禁用该
平面。

## 授权生命周期

1. 调用 `live_realtime_arm_preview`,携带一个或多个显式通道
   (`udp-json`、`osc`、`xy`、`max`)、0–32 个权威已发布参数引用的精确
   允许列表、1–30 秒 TTL、可选的发送方端口,以及权威的输出安全证据。空
   引用列表只允许紧急停止数据包。
2. 用 `confirmation=apply` 与幂等键应用未过期的事务一次。宿主在规范的
   arm 请求中携带最终预览的精确参数、所有者、轨道与有序同级身份描述符;
   Live 在创建令牌前原子地比对每个描述符。同一遍历引用上的替换会被拒绝。
   除非适配器来源为 `real-live`,否则布防也会被拒绝。
3. 结果包含回环端点、不可预测的持票人令牌、过期时间、所选通道与精确参数
   引用、512 字节数据包限制、64 包/秒令牌桶速率与突发 16。不要记录或持久
   化该令牌。
4. 发送正安全整数序列号。序列状态是每次 arm 一个重放域。重新 arm 会使先前
   令牌与排队代际失效。
5. 调用 `live_realtime_stats` 区分:已接受、待处理、已应用、回调失败、
   分发前丢弃、端点/令牌/重放/速率/队列丢弃、未授权目标丢弃、序列缺口,
   以及到达间隔/传输抖动。
6. 用 `confirmation=disarm` 调用 `live_realtime_disarm`。Disarm、重新 arm、
   过期、桥接拆除与主线程截止时间,都会对排队工作进行隔离。

`accepted` 表示被接纳进 Live 的有界主线程队列,而不是已送达。只有
`applied` 才确认调度的回调完成并同步验证了其已发布参数值。UDP 本身没有
确认。

## UDP JSON

每个数据报是一个不超过 512 字节的 UTF-8 JSON 对象。未知字段会被拒绝。

已发布参数:

```json
{"token":"<arm token>","seq":1,"channel":"udp-json","op":"parameter.set","ref":"<parameter ref>","value":0.5,"sentAtMs":1700000000000}
```

原子 XY 对,任一已验证写入失败时进行尽力回滚:

```json
{"token":"<arm token>","seq":2,"channel":"xy","op":"xy.set","xRef":"<parameter ref>","x":0.4,"yRef":"<parameter ref>","y":0.6,"sentAtMs":1700000000000}
```

操作者自写的客户端(包括 Max patch)可以用 `channel:"max"` 序列化同样的
严格对象。这只是一个已认证的扩展数据包标签:运行状态不宣告 `max` 能力,
不发生 Max 握手,也不捆绑 `.amxd` 设备。patch 可以用 `udpsend` 把它发到
返回的回环端点;成品 Max 设备的分发与验证仍是单独版本化的扩展。

紧急停止:

```json
{"token":"<arm token>","seq":3,"channel":"udp-json","op":"emergency-stop","sentAtMs":1700000000000}
```

回调获取精确的新鲜活跃目标,并在 Live 线程上调用受护栏的停止。已认证 TCP
的 `live_session_emergency_stop` 在没有实时令牌可用时仍是独立的恢复路径。

## OSC

OSC bundle 与不支持的类型会被拒绝。支持的消息:

- `/ableton-mcp/parameter` —— 参数 `string token`、`int32|int64 seq`、
  `string ref`、`float|double value`,可选 `double sentAtMs`。
- `/ableton-mcp/xy` —— 参数 `string token`、`int32|int64 seq`、
  `string xRef`、`float|double x`、`string yRef`、`float|double y`,
  可选 `double sentAtMs`。
- `/ableton-mcp/emergency-stop` —— 参数 `string token`、`int32|int64 seq`,
  可选 `double sentAtMs`。

OSC 数据包要求 arm 中包含 `osc` 通道。JSON XY 数据包要求 `xy`;Max 标签的
JSON 数据包要求 `max`。紧急停止允许通过任何所选通道,但仍要求当前令牌、
端点、序列与 TTL。

## Live 线程与值安全

Socket 线程只解码、认证、计数与排队。参数解析、边界、启用状态、量化、
写入、XY 回滚、值验证、播放观察与紧急停止,全部在 Live 的定期 Control
Surface 线程上执行。每次写入前,Live 重新计算 arm 时保留的同一参数/
所有者/轨道/同级描述符;拓扑漂移会撤销该代际并拒绝排队写入。超出权威
边界的值会被拒绝,绝不静默钳制。队列限制为 128 个回调,实时回调有 1 秒
的分发前截止时间。

实时平面只写入已发布的数值 Live 参数。它不加载设备、不选择 Browser 条目、
不改变路由、不 arm 录音、不写文件,也不暴露通用的 Live 对象操作。

## 恢复

- 出现任何 `applyFailures`、`revokedBeforeApply`、`droppedBeforeDispatch`
  或持续的 `pending` 值时,disarm 并在重试前进行新鲜发现。
- 发送方端口不匹配、错误令牌/通道、重放、无效数据包、过载或队列已满,
  都会被丢弃并计数;绝不自动重试。
- 如果 MCP 宿主重启而 Live 与桥接保持运行,当前令牌只在原始过期时间前
  可用。重连不延长它。
- 如果 Live 或桥接重启,socket 关闭,所有令牌消失。
- 实时测试后,始终在一次性 Set 中恢复被触碰的参数并确认停止/未录音状态。

macOS 真实 Live 证据记录在
[../evidence/phase-7c-realtime-live.json](../evidence/phase-7c-realtime-live.json)。
它不能替代 Windows Live 证据,也不证明捆绑了 Max for Live 设备。
