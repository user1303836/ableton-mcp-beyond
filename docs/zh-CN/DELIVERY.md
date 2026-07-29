# 跨平台交付与生命周期

[English](../en/DELIVERY.md) · 简体中文 · [日本語](../ja/DELIVERY.md)

## 发布产物与渠道

发布产物是来自 `npm pack` 的精确 SHA npm tarball,按本地路径与 SHA-256
安装。它未签名、未公证,也未发布到 npm。仓库源码采用 MIT 许可;打包的
`package.json` 仍带有仓库公开之前的 `private`/`UNLICENSED` 元数据,
生命周期验证器会强制检查该元数据,并已跟踪待发布管线更新。

`package:verify` 拒绝精确允许列表之外的任何路径,并对照每一个编译后的
运行时、Remote Script、注册表、文档与许可证字节验证
`release-manifest.json`。tarball 只能包含:编译后的运行时 JavaScript 与
声明、带注册表与清单的 Remote Script、发布清单与软件包元数据、MIT
许可证文件,以及允许列表中的用户/安全/运维文档。测试、验证脚本、源码
映射、依赖、密钥、配置、状态、备份、日志、捕获的媒体、证据与受保护的
本地材料都被排除。

清单记录软件包版本、精确源码提交与脏标志、Node 范围、宿主/桥接协议、
规范注册表哈希、分发渠道、签名/公证/发布状态、文件角色与 SHA-256 值。
发布候选必须来自干净的提交。SHA-256 证明字节完整性,而不是发布者身份。

## 支持矩阵

Node 22、24、25 是显式支持的主版本。Linux、macOS 与 Windows 的宿主/
软件包契约在 CI 运行。Live 认证是独立的,绝不从宿主测试推断;见
[SUPPORT_MATRIX.md](SUPPORT_MATRIX.md)。

## 精确的平台设置

### macOS 15(bash/zsh)

使用用户级 Remote Scripts 目录;不要写入 Live 应用包内部。完整保留空格:

```sh
ARTIFACT="$(cd "$(dirname '/absolute/candidate.tgz')" && pwd)/$(basename '/absolute/candidate.tgz')"
ARTIFACT_SHA="$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')"
INSTALL_ROOT="$HOME/Library/Application Support/AbletonMcp/package"
STATE="$HOME/Library/Application Support/AbletonMcp/state"
REMOTE_SCRIPTS="$HOME/Music/Ableton/User Library/Remote Scripts"
mkdir -p "$INSTALL_ROOT" "$REMOTE_SCRIPTS"
npm install --prefix "$INSTALL_ROOT" --ignore-scripts --no-audit --no-fund "$ARTIFACT"
PACKAGE_ROOT="$INSTALL_ROOT/node_modules/@ableton-mcp/mcp-server"
LIFECYCLE="$INSTALL_ROOT/node_modules/.bin/ableton-mcp-lifecycle"
```

从 Live 的正常 UI 停止它并确认已退出;生命周期绝不杀死它。运行下面的
安装命令。重启 Live,打开 **Live → Settings → Link, Tempo & MIDI**,
在一个 Control Surface 行中选择 `AbletonMcpBridge`,然后运行
`activate`。卸载时,在 Live 停止状态下运行 lifecycle uninstall,重启
Live 以卸载脚本,更新 MCP 客户端配置,保留状态/证据后才删除
`$INSTALL_ROOT`。

### Windows Server 2025 宿主契约 / Windows Live 过程(PowerShell)

托管宿主契约使用 Windows Server 2025。Windows 11 + Ableton Live 未认证;
以下是收集该缺失单元格的精确操作步骤,而不是通过声明:

```powershell
$Artifact = (Resolve-Path 'C:\absolute\candidate.tgz').Path
$ArtifactSha = (Get-FileHash -Algorithm SHA256 $Artifact).Hash.ToLowerInvariant()
$InstallRoot = Join-Path $env:LOCALAPPDATA 'AbletonMcp\package'
$State = Join-Path $env:LOCALAPPDATA 'AbletonMcp\state'
$RemoteScripts = Join-Path ([Environment]::GetFolderPath('MyMusic')) 'Ableton\User Library\Remote Scripts'
New-Item -ItemType Directory -Force $InstallRoot,$RemoteScripts | Out-Null
npm install --prefix $InstallRoot --ignore-scripts --no-audit --no-fund $Artifact
$PackageRoot = Join-Path $InstallRoot 'node_modules\@ableton-mcp\mcp-server'
$Lifecycle = Join-Path $InstallRoot 'node_modules\.bin\ableton-mcp-lifecycle.cmd'
& $Lifecycle install --remote-scripts-dir $RemoteScripts --state-dir $State `
  --package-root $PackageRoot --artifact $Artifact --artifact-sha256 $ArtifactSha
& $Lifecycle install --remote-scripts-dir $RemoteScripts --state-dir $State `
  --package-root $PackageRoot --artifact $Artifact --artifact-sha256 $ArtifactSha `
  --apply --confirm-live-stopped
```

第一次省略 `--apply` 并检查 JSON 计划。在第二条命令前,在 Live 的 UI
中 visibly 停止它并在任务管理器中确认;不要自动化进程终止。重启 Live,
在 **Options → Preferences → Link, Tempo & MIDI** 下选择
`AbletonMcpBridge`,然后运行:

```powershell
& $Lifecycle activate --remote-scripts-dir $RemoteScripts --state-dir $State --package-root $PackageRoot
```

升级时,把新 tarball 安装到单独的 `$NewInstallRoot`,用 `Get-FileHash`
计算其哈希,停止 Live,并使用下文 `upgrade` 的相同语法(换成新的软件包/
tarball 路径)。卸载时,停止 Live,先运行计划,再运行
`uninstall --apply --confirm-live-stopped`;重启 Live,更新客户端,保留
回执/隔离证据,然后删除 npm 前缀。绝不要对未经回执证明的路径使用安装器
或 `Remove-Item -Recurse`。

## 回执驱动的生命周期 CLI

所有示例都使用已安装产物中的 `ableton-mcp-lifecycle`。始终为所选 Live
安装传递精确的 Live **Remote Scripts 父目录**。路径可以包含空格与
Unicode。该工具绝不猜测应用包路径、绝不选择 Control Surface、绝不杀死
Live,也绝不跟随符号链接/联接点祖先。

选择所有者控制的状态与精确候选值:

其余示例使用上面 macOS 设置中的 POSIX shell 变量。在 Windows 上使用相应
的 PowerShell 变量并以 `& $Lifecycle` 调用;选项名称与安全门完全相同。

每个变更命令都先支持不变更的计划(省略 `--apply`)。安装、升级、回滚
与卸载还要求操作者停止 Live 并传递 `--confirm-live-stopped`;该工具
绝不把进程不存在当作证明,也绝不杀死进程。

### 安装

```sh
"$LIFECYCLE" install --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT" \
  --artifact "$ARTIFACT" --artifact-sha256 "$ARTIFACT_SHA"

"$LIFECYCLE" install --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT" \
  --artifact "$ARTIFACT" --artifact-sha256 "$ARTIFACT_SHA" \
  --apply --confirm-live-stopped
```

预检对精确的本地 tarball 字节做哈希,把 tarball 内嵌的发布清单与完整
的严格清单/负载哈希绑定到解包的软件包根,验证发布清单、空的自有目标、
祖先/链接安全、不同的回环端口与端口可用性,然后才创建状态。应用创建
owner-only 密钥与配置,原子地安装 Remote Script/注册表/清单/引用,然后
写入 owner-only 回执与日志。密钥、配置或桥接暂存之后的任何注入或真实
失败,都会移除新授权并恢复先前状态。成功是
`installed-restart-required`,而不是激活。

### 激活

1. 重启 Live。
2. 在 Live 偏好设置中选择 `AbletonMcpBridge` 作为 Control Surface。
3. 运行:

```sh
"$LIFECYCLE" activate --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT"
```

激活是只读的。只有在已认证状态、规范注册表身份、有界发现与
`real-live` 来源之后,才记录 `activated`。伪造、模拟器、不可用、陈旧
或错误注册表的响应保持 `activation-required`,并给出重启/选择修复
指引。

### 升级

把新 tarball 安装到单独的软件包路径,停止 Live,审阅计划,然后应用:

```sh
"$LIFECYCLE" upgrade --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root '/absolute/new/package/root' \
  --artifact '/absolute/path/to/new-candidate.tgz' \
  --artifact-sha256 '<new-tarball-sha>'

"$LIFECYCLE" upgrade --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root '/absolute/new/package/root' \
  --artifact '/absolute/path/to/new-candidate.tgz' \
  --artifact-sha256 '<new-tarball-sha>' \
  --apply --confirm-live-stopped
```

升级拒绝漂移与相同候选,保留所有者密钥,暂存新配置/桥接,保留先前的
配置与精确的 Remote Script 代际,验证哈希,并记录回滚身份。失败会恢复
先前的桥接/配置,所有者回执不变。之后重启并激活。

### 修复

```sh
"$LIFECYCLE" repair --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT"
"$LIFECYCLE" repair --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT" --apply
```

修复比对回执自有的哈希、未知文件、配置摘要与密钥权限。干净的修复是
幂等的。应用把漂移的树/配置移入 owner-only 隔离区,只恢复清单自有的
负载。缺失的密钥绝不静默重新生成,因为那会制造新的桥接授权。修复有
变化后重启并激活。

### 回滚

```sh
"$LIFECYCLE" rollback --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT" \
  --apply --confirm-live-stopped
```

回滚要求回执绑定的保留代际,验证其文件,原子地交换桥接/配置,把失败
代际隔离以支持反向回滚,并记录又一次重启/激活要求。没有精确的先前
代际时拒绝。

### 卸载

```sh
"$LIFECYCLE" uninstall --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT" \
  --apply --confirm-live-stopped
```

移除精确的回执自有桥接文件与未变更的受管配置。被修改或未知的桥接内容
移入隔离区而不是删除。密钥默认保留;只有对回执证明由本生命周期创建的
密钥,才添加 `--purge-secret`。清除是普通解除链接,不是取证级安全擦除
声明。最终回执记录 `uninstalled`;只有在客户端配置不再指向 npm 软件包
后才单独删除它。重启 Live 以卸载 Control Surface。

### 配置迁移

迁移 CLI 默认保留 legacy/v1 输出。要生成精确的版本 2 桥接配置,提供
每一个带授权的桥接字段与一个已存在的 owner-only 密钥;入口必须已经是
绝对路径:

```sh
ableton-mcp-migrate --input '/absolute/legacy-or-v1.json' \
  --output '/absolute/bridge-v2.json' \
  --bridge-host 127.0.0.1 --bridge-port 9765 \
  --realtime-port 9766 --secret-file '/absolute/bridge.secret'
```

它绝不在迁移期间创建密钥,绝不接受非回环主机,并拒绝畸形端口、链接/
不安全密钥以及替换(除非显式 `--force`)。

### 状态、日志与恢复

```sh
"$LIFECYCLE" status --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT"
```

状态是只读的,分别报告回执状态、软件包/配置/Remote Script 完整性、
文件漂移、权限、回滚可用性、保留的清理或保留路径,以及历史激活回执。
历史激活绝不是当前连通性证据;当安装完整性漂移时,会降级为等效的
restart-required 状态。安装器在 Python 缓存目录路径上拥有一个名为
`__pycache__` 的空常规文件。这个回执绑定的阻塞器阻止 Live 生成或加载
未验证的字节码,同时保持源码模块可读。用目录、缓存负载、链接或任何
其他条目替换它都是可处理的漂移。即使对于未列出该阻塞器的旧版回执,
这个不变量也会被强制执行;状态/激活故障关闭,`repair --apply` 会迁移
该代际。`lifecycle-journal.json` 记录上一次事务结果(不含密钥)。中断
后不要盲目重试:检查回执、日志、隔离区、Live 进程与状态;按指示使用
修复或回滚。

## 已测试的故障矩阵

单元测试与已安装 tarball 测试覆盖:空格/Unicode、不变更计划、显式停止
确认、端口占用、所有者权限、叶子与祖先符号链接、每个提交边界后的安装
失败、漂移/未知文件、回执绑定的 Python 字节码缓存阻塞、隔离、幂等修复、
升级回滚、显式回滚、已升级代际注销、可重试的卸载清理、卸载保留/清除、
畸形选项、restart-required 状态,以及诚实的不可用激活。托管 Windows
运行增加原生 DACL 与占用文件/进程行为;macOS 运行增加 POSIX 模式/链接
行为。通过的生命周期测试仍然不是已加载的 Windows Live Control Surface
观察。

## 分层诊断

诊断报告五个独立的层:软件包、已配置桥接、已认证桥接、真实 Live 运行
与发布认证。旧的 `ready` 摘要只对已认证的真实 Live 运行为真。发布认证
在精确候选矩阵与外部门禁完成前保持 false。探测失败返回有界错误码,
而不是变成正面证据。
