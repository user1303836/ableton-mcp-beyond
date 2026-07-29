# クロスプラットフォームデリバリーとライフサイクル

[English](../en/DELIVERY.md) · [简体中文](../zh-CN/DELIVERY.md) · 日本語

## リリース成果物とチャネル

リリース成果物は `npm pack` による正確な SHA の npm tarball で、ローカル
パスと SHA-256 でインストールされます。未署名・未公証で、npm に公開されて
いません。リポジトリのソースは MIT ライセンスです。パッケージされた
`package.json` には、リポジトリが公開される前の `private`/`UNLICENSED`
メタデータが残っており、ライフサイクル検証がそれを強制します。リリース
パイプラインの更新が追跡されています。

`package:verify` は正確な許可リスト外のすべてのパスを拒否し、コンパイル
されたすべてのランタイム、Remote Script、レジストリ、ドキュメント、
ライセンスバイトに対して `release-manifest.json` を検証します。tarball
には、コンパイルされたランタイム JavaScript と宣言、レジストリとマニフェスト
付きの Remote Script、リリースマニフェストとパッケージメタデータ、MIT
ライセンスファイル、許可リストされたユーザー/安全/運用ドキュメントのみが
含まれます。テスト、検証スクリプト、ソースマップ、依存関係、シークレット、
設定、状態、バックアップ、ログ、キャプチャされたメディア、エビデンス、
保護されたローカルマテリアルは除外されます。

マニフェストは、パッケージバージョン、正確なソースコミットとダーティ
フラグ、Node 範囲、ホスト/ブリッジプロトコル、正規レジストリハッシュ、
配布チャネル、署名/公証/公開状態、ファイルロール、SHA-256 値を記録します。
リリース候補はクリーンなコミットから作成する必要があります。SHA-256 は
バイト整合性を証明するものであり、公開者の同一性ではありません。

## サポートマトリクス

Node 22、24、25 は明示的にサポートされるメジャーです。Linux、macOS、
Windows のホスト/パッケージ契約は CI で実行されます。Live 認証は別個であり、
ホストテストから推測されることはありません。
[SUPPORT_MATRIX.md](SUPPORT_MATRIX.md) を参照してください。

## 正確なプラットフォームセットアップ

### macOS 15(bash/zsh)

ユーザーの Remote Scripts ディレクトリを使用してください。Live アプリ
ケーションバンドル内に書き込まないでください。スペースを正確に保持して
ください:

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

Live を通常の UI から停止し、終了したことを確認してください。ライフサイクルが
強制終了することはありません。以下のインストールコマンドを実行してください。
Live を再起動し、**Live → Settings → Link, Tempo & MIDI** を開き、Control
Surface 行で `AbletonMcpBridge` を選択してから、`activate` を実行してください。
アンインストールするには、Live を停止した状態で lifecycle uninstall を実行し、
Live を再起動してスクリプトをアンロードし、MCP クライアント設定を更新してから、
ステータス/エビデンスを保持した後でのみ `$INSTALL_ROOT` を削除してください。

### Windows Server 2025 ホスト契約 / Windows Live 手順(PowerShell)

ホストされたホスト契約は Windows Server 2025 を使用します。Windows 11 +
Ableton Live は未認証です。以下は欠落しているセルを収集するための正確な
オペレーター手順であり、パスの主張ではありません:

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

最初は `--apply` を省略して JSON プランを確認してください。2 番目のコマンドの
前に、Live をその UI で目視で停止し、タスクマネージャーで確認してください。
プロセス終了を自動化しないでください。Live を再起動し、**Options →
Preferences → Link, Tempo & MIDI** で `AbletonMcpBridge` を選択してから、
以下を実行してください:

```powershell
& $Lifecycle activate --remote-scripts-dir $RemoteScripts --state-dir $State --package-root $PackageRoot
```

アップグレードするには、新しい tarball を別の `$NewInstallRoot` にインストールし、
`Get-FileHash` でハッシュを計算し、Live を停止して、以下に示す `upgrade` と
同じ構文で新しいパッケージ/tarball パスを使用してください。アンインストール
するには、Live を停止し、プランを実行してから `uninstall --apply
--confirm-live-stopped` を実行してください。Live を再起動し、クライアントを
更新し、レシート/隔離エビデンスを保持してから、npm プレフィックスを削除して
ください。レシートで証明されていないパスに対してインストーラーや
`Remove-Item -Recurse` を使用しないでください。

## レシート駆動ライフサイクル CLI

すべての例は、インストールされた成果物の `ableton-mcp-lifecycle` を使用します。
選択した Live インストールの正確な Live **Remote Scripts 親ディレクトリ**を
常に渡してください。パスにはスペースと Unicode を含めることができます。この
ツールは、アプリケーションバンドルパスを推測したり、Control Surface を選択
したり、Live を強制終了したり、シンボリックリンク/ジャンクションの祖先を
たどったりしません。

オーナーが管理する状態と正確な候補値を選択してください:

残りの例では、上記の macOS セットアップの POSIX シェル変数を使用します。
Windows では対応する PowerShell 変数を使用し、`& $Lifecycle` で呼び出して
ください。オプション名と安全ゲートは同一です。

すべての変更コマンドは、まず非変更プランをサポートします(`--apply` を省略)。
インストール、アップグレード、ロールバック、アンインストールはさらに、
オペレーターが Live を停止して `--confirm-live-stopped` を渡すことを要求します。
このツールはプロセスの不在を証明として扱わず、プロセスを強制終了しません。

### インストール

```sh
"$LIFECYCLE" install --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT" \
  --artifact "$ARTIFACT" --artifact-sha256 "$ARTIFACT_SHA"

"$LIFECYCLE" install --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT" \
  --artifact "$ARTIFACT" --artifact-sha256 "$ARTIFACT_SHA" \
  --apply --confirm-live-stopped
```

プリフライトは正確なローカル tarball バイトをハッシュし、tarball に埋め込まれた
リリースマニフェストと完全な厳密なインベントリ/ペイロードハッシュを抽出された
パッケージルートにバインドし、リリースマニフェスト、空の所有デスティネーション、
祖先/リンクの安全性、個別のループバックポート、ポートの可用性を検証してから
状態を作成します。適用はオーナー専用シークレットと設定を作成し、Remote
Script/レジストリ/マニフェスト/参照をアトミックにインストールしてから、
オーナー専用レシートとジャーナルを書き込みます。シークレット、設定、ブリッジの
ステージング後の注入または実際の障害は、新しい権限を削除し、以前の状態を復元
します。成功は `installed-restart-required` であり、アクティベーションでは
ありません。

### アクティベーション

1. Live を再起動します。
2. Live の環境設定で Control Surface として `AbletonMcpBridge` を選択します。
3. 実行:

```sh
"$LIFECYCLE" activate --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT"
```

アクティベーションは読み取り専用です。認証済みステータス、正規レジストリ ID、
有界ディスカバリ、`real-live` 出所の後にのみ `activated` を記録します。
偽物、シミュレーター、利用不可、古い、または誤ったレジストリの応答は、
再起動/選択の修正とともに `activation-required` のままです。

### アップグレード

新しい tarball を別のパッケージパスにインストールし、Live を停止し、プランを
確認してから適用してください:

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

アップグレードはドリフトと同一候補を拒否し、オーナーシークレットを保持し、
新しい設定/ブリッジをステージし、以前の設定と正確な Remote Script 世代を
保持し、ハッシュを検証し、ロールバック ID を記録します。失敗は以前の
ブリッジ/設定を復元し、オーナーレシートを変更しません。その後再起動して
アクティベートしてください。

### 修復

```sh
"$LIFECYCLE" repair --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT"
"$LIFECYCLE" repair --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT" --apply
```

修復は、レシート所有のハッシュ、不明なファイル、設定ダイジェスト、シークレット
権限を比較します。クリーンな修復は冪等です。適用はドリフトしたツリー/設定を
オーナー専用隔離に移動し、マニフェスト所有のペイロードのみを復元します。
欠落したシークレットがサイレントに再生成されることはありません。それは新しい
ブリッジ権限を捏造することになるからです。変更された修復の後は再起動して
アクティベートしてください。

### ロールバック

```sh
"$LIFECYCLE" rollback --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT" \
  --apply --confirm-live-stopped
```

ロールバックはレシート紐付けの保持世代を必要とし、そのファイルを検証し、
ブリッジ/設定をアトミックに交換し、失敗した世代を逆ロールバック用に隔離し、
さらなる再起動/アクティベーション要件を記録します。正確な前世代が存在しない
場合は拒否します。

### アンインストール

```sh
"$LIFECYCLE" uninstall --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT" \
  --apply --confirm-live-stopped
```

正確なレシート所有のブリッジファイルと変更されていない管理対象設定が削除
されます。変更または不明なブリッジコンテンツは削除ではなく隔離に移動されます。
シークレットはデフォルトで保持されます。レシートがこのライフサイクルで作成
されたことを証明するシークレットにのみ `--purge-secret` を追加してください。
パージは通常のアンリンクであり、フォレンジック安全消去の主張ではありません。
最終レシートは `uninstalled` を記録します。クライアント設定が指さなくなって
からでのみ、npm パッケージを個別に削除してください。Live を再起動して
Control Surface をアンロードしてください。

### 設定マイグレーション

マイグレーション CLI はデフォルトでレガシー/v1 出力を保持します。正確な
バージョン 2 ブリッジ設定を生成するには、すべての権限保持ブリッジフィールドと
既存のオーナー専用シークレットを提供してください。エントリーポイントはすでに
絶対パスである必要があります:

```sh
ableton-mcp-migrate --input '/absolute/legacy-or-v1.json' \
  --output '/absolute/bridge-v2.json' \
  --bridge-host 127.0.0.1 --bridge-port 9765 \
  --realtime-port 9766 --secret-file '/absolute/bridge.secret'
```

マイグレーション中にシークレットを作成することはなく、非ループバックホストを
受け付けず、不正なポート、リンク/安全でないシークレット、`--force` が明示的
でない置換を拒否します。

### ステータス、ジャーナル、回復

```sh
"$LIFECYCLE" status --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT"
```

ステータスは読み取り専用で、レシート状態、パッケージ/設定/Remote Script
整合性、ファイルドリフト、権限、ロールバック可用性、保持されたクリーンアップ
または保持パス、過去のアクティベーションレシートを分離します。過去の
アクティベーションは現在の接続性のエビデンスではなく、インストール整合性が
ドリフトすると実効的な restart-required ステータスにダウングレードされます。
インストーラーは Python のキャッシュディレクトリパスに `__pycache__` という
空の通常ファイルを所有します。このレシート紐付けブロッカーは、Live が未検証の
バイトコードを生成またはロードするのを防ぎ、ソースモジュールは読み取り可能な
ままにします。ディレクトリ、キャッシュペイロード、リンク、その他のエントリに
置き換えることは実行可能なドリフトです。この不変条件は、ブロッカーをリスト
していなかったレガシーレシートにも強制されます。ステータス/アクティベーションは
フェイルクローズし、`repair --apply` がその世代を移行します。
`lifecycle-journal.json` はシークレットなしで最後のトランザクション結果を記録
します。中断時は盲目に再試行しないでください。レシート、ジャーナル、隔離、
Live プロセス、ステータスを検査し、指示された修復またはロールバックを使用して
ください。

## テスト済み障害マトリクス

ユニットおよびインストール済み tarball テストは、スペース/Unicode、非変更
プラン、明示的な停止確認、占有ポート、オーナー権限、リーフおよび祖先
シンボリックリンク、各コミット境界後のインストール失敗、ドリフト/不明な
ファイル、レシート紐付け Python バイトコードキャッシュブロッキング、隔離、
冪等修復、アップグレードロールバック、明示的ロールバック、アップグレード
世代の退役、再試行可能なアンインストールクリーンアップ、アンインストール
保持/パージ、不正なオプション、restart-required 状態、正直な利用不可
アクティベーションをカバーします。ホストされた Windows 実行はネイティブ
DACL と保持ファイル/プロセス動作を追加します。macOS 実行は POSIX モード/
リンク動作を追加します。パスしたライフサイクルテストは、ロードされた
Windows Live Control Surface の観測ではありません。

## レイヤード診断

診断は 5 つの個別のレイヤーを報告します: パッケージ、設定済みブリッジ、
認証済みブリッジ、実 Live 運用、リリース認証。レガシーの `ready` サマリーは、
認証済み実 Live 運用に対してのみ true です。リリース認証は、正確な候補
マトリクスと外部ゲートが完了するまで false のままです。プローブ失敗は、
肯定的なエビデンスになるのではなく、有界なエラーコードを返します。
