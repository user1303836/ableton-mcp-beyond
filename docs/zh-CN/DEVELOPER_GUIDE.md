# 开发者指南

[English](../en/DEVELOPER_GUIDE.md) · 简体中文 · [日本語](../ja/DEVELOPER_GUIDE.md)

源码、模式与测试是权威。除非某个能力的导出工具、适配器契约、映射器与
测试都支持,否则文档不得宣传该能力。

## 布局

- `apps/mcp-server/src/host.ts`:MCP 生命周期、严格的工具模式、异步分发、
  事务状态与恢复错误。
- `apps/mcp-server/src/live.ts`:Live 类型、注册表派生的标识符/哈希、
  不可用适配器、模拟器,以及测试与进程支持的调用方当前使用的同步加
  Promise 适配器契约。
- `apps/mcp-server/src/registry.ts`:规范注册表加载、有界模式验证与派生
  操作标识符/哈希。
- `apps/mcp-server/src/bridge/remote-adapter.ts`:已认证的异步回环客户端、
  注册表协商、截止时间、关联与清理。
- `apps/mcp-server/src/transactions/`:有界 MIDI 事务与异步发现助手。
- `apps/mcp-server/src/analysis.ts`:有界 PCM 解码与隐私保护分析。
- `apps/mcp-server/src/delivery.ts`:配置、密钥验证、打包、安装与诊断。
- `protocol/ableton-live-v1.operations.json`:规范版本 1 操作注册表。当前
  契约的规范注册表哈希为
  `5c85f64023820899ac92510c35ce1b5ded76387757f7acc41cd96c6384ac67a4`。
- `remote-script/AbletonMcpBridge/__init__.py`:单参数 Control Surface
  入口与故障关闭的引用加载。
- `remote-script/ableton_mcp_remote_script.py`:已认证传输、有界主线程
  分发、绑定 epoch 的引用、依形状宣告操作、层级发现、结构、MIDI、定位点
  与已发布设备参数映射。

## 契约规则

有线协议是 `ableton-loopback/v1`。规范 JSON 排序键并归一化负零;
HMAC-SHA256 认证请求与响应;帧、集合、嵌套、字符串、待处理工作与序列
都有界。协商拒绝畸形、重复、未知、不支持或注册表哈希不匹配的操作。

进程支持的适配器通过基于 Promise 的方法消费,如 `snapshotAsync`、
`getAsync`、`invokeAsync`、`reconnectAsync` 与 `close`;共享的
TypeScript 接口与模拟器保留同步兼容方法。这还不是计划中的单一异步契约。
场景试听与其他进程支持的 Live 工具需要 `McpHost.handleAsync`;在同步的、
仅模拟器的表面被移除之前,请对两条路径都验证兼容性。两个契约都不暴露
通用 `set`;变更只通过规范的、用途特定的操作进行。

Python worker 只执行组帧、认证、排序与排队。面向 Live 的遍历与变更由
定期调度的主线程回调排空。新连接 epoch 使先前的引用与游标失效。不支持
的 Live 形态是不可用的,绝不虚构。设备控制限于权威的已发布数值参数,
要求有效边界、量化、启用状态、可自动化状态、归属关系与变更后回读。
发现行保留父级引用;空剪辑槽位是显式的行,绝不能推断为剪辑。

决定:桥接 `get(ref)` 保持为固定行之上的内部有界序列化器,而不是通用
Live Object Model 属性读取器,也不作为通用 MCP 读取面暴露。MCP 读取
保持用途特定(`live_status`、`live_snapshot`、`live_discover`、能力/
状态行);发现中的请求字段是这些固定行之上的投影。这是刻意的边界,
而非未实现的通用读取器。

## 命令

```sh
cd apps/mcp-server
npm ci
npm run typecheck
npm test
npm run property-test
npm run benchmark
npm run compatibility
npm run package:verify
npm pack --dry-run --json
cd ../..
python3 -m unittest discover -s remote-script -p 'test_*.py'
git diff --check
git diff --cached --check
```

`dist/` 与打包归档是生成的输出,不得暂存。不要把本地专用参考材料用作
夹具或打包输入。保持 stdout 仅协议,在 stderr 上隐去诊断。不要修改、
暂存、打包、复制或暴露 `extensions-sdk-1.0.0-beta.0`。
