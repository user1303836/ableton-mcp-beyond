# 開発者ガイド

[English](../en/DEVELOPER_GUIDE.md) · [简体中文](../zh-CN/DEVELOPER_GUIDE.md) · 日本語

リポジトリの各部分がどうつながっているか、それぞれの部分でどう作業するか、どうリリースするかを説明します。テストのコマンドと CI が実行する内容はすべて[テスト](TESTING.md)にあります。

## ネイティブ版の開発

現在のアプリとブリッジはルートの Cargo ワークスペースにあります。
`crates/kumi` が CLI と画面、`crates/kumi-runtime` がエージェントと Live 連携、
`crates/kumi-common` が共通処理、`crates/ableton-mcp-server` がブリッジです。
Rust、Cargo、Python 3.11 以降を用意して実行します。

```sh
cargo build --release --locked --workspace --bins
cargo run --release -p kumi --
sh scripts/test-isolated.sh   # PowerShell: ./scripts/test-isolated.ps1
cargo run --locked --release -p ableton-mcp-server --bin ableton-mcp-benchmark
```

テストは一時的なホームを使います。ベンチマークは隣接する解析ワーカーを使い、
JSON の測定結果を出力し、基準を超えると失敗します。重いビルドと並行せず、
最適化したリリースビルドで実行してください。メモリー欄は Rust の割り当て量です。

Mac のリリースをローカルに準備する例（コミット済みの変更がない状態で）:

```sh
python3 scripts/build-hands.py
MACOSX_DEPLOYMENT_TARGET=13.0 python3 scripts/build-native-release.py --target aarch64-apple-darwin --out release/native/aarch64-apple-darwin
python3 -m unittest discover -s scripts/tests -p test_native_release.py
```

ヘルパーは従来の `packages/runtime/hands/` に配置します。配布物にはサーバーと
解析ワーカーの両方が必要です。各対象向けの集約、旧版からの更新検証、バージョンの
更新箇所は[英語版の現行リリース手順](../en/DEVELOPER_GUIDE.md#releasing)を参照してください。
通常のインストールには Node は不要です。参照用の TypeScript テストには Node.js 22 または 24 を使います。

以下は保持している **TypeScript 参照版の構成と旧リリース手順**です。

## 構成

| フォルダー | 内容 |
| --- | --- |
| `apps/kumi` | `kumi` コマンドとターミナルアプリ（`src/tui/`）。`scripts/` には、モデルや実際の Live に対して任意で実行するチェックがあります |
| `packages/runtime` | Kumi のエージェントコア：`kernel/`（エージェントループ）、`providers/` と `auth/`（モデルとサインイン）、`core/`（セッション、メモリー、テクニック、レシピ、ゴール、マッチング）、`integrations/ableton/`（Kumi の Live 用ツール）、`audio/`、`video/`、`web/`、`devices/`（Max for Live デバイス）、`mcp/`（ブリッジのクライアント） |
| `apps/mcp-server` | ブリッジ `@ableton-mcp/mcp-server`：stdio 上の MCP サーバーで、独自のロックファイル、テスト、CI を持ちます。ライフサイクル、セットアップ、移行、診断のコマンドもここにあります |
| `remote-script` | Live の中で動く、ブリッジの Remote Script（`ableton_mcp_remote_script.py`、`AbletonMcpBridge/` エントリーポイント、Python のテスト） |
| `apps/live-extension` | Live 12.4 以降向けの Kumi の Live 拡張機能。Live の Extensions SDK の上に作られています |
| `protocol` | `ableton-live-v1.operations.json`。ブリッジと Remote Script が共有する操作のレジストリ |
| `scripts` | `build-release.mjs`（インストーラー用のバンドル）と `test-isolated.mjs` |
| `install.sh`、`install.ps1` | インストーラー |

ルートは `apps/kumi` と `packages/runtime` からなる npm ワークスペースです。ブリッジは意図的に分けてあります。単独でビルド、テスト、パックでき、Kumi なしでも動きます。

## 各部分のやりとり

```text
kumi (apps/kumi, packages/runtime)
  │  MCP over stdio: Kumi starts the bridge as a child process
  ▼
bridge (apps/mcp-server)
  │  ableton-loopback/v1: authenticated TCP on 127.0.0.1
  ├──► Remote Script inside Live (remote-script/)
  │  local channel to the Extension Host
  └──► Kumi's Live extension (apps/live-extension), Live 12.4+
```

- Kumi は、`full` デプロイメントポリシーと、使うツールだけをちょうど並べた許可リスト（`ABLETON_MCP_TOOL_ALLOW`）を指定してブリッジを起動します。モデルはいくつかのブリッジの読み取りを直接呼び出し（`packages/runtime/src/mcp/allowed-tools.ts` の `MODEL_TOOLS`）、残りは Kumi 自身のツールが呼び出します。
- ブリッジのルーター（`apps/mcp-server/src/bridge/router.ts`）は、各操作を Remote Script に送るか、その操作を拡張機能しか持っていない場合は拡張機能に送ります。Live の Developer Mode のせいで拡張機能が起動されない場合、ブリッジは Live の Extension Host を自分で起動できます。
- `kumi bridge` はブリッジのライフサイクルコマンドを通じてブリッジを Live にインストールし、その後は `Remote Scripts/AbletonMcpBridge/bridge-reference.json` を通じてブリッジを見つけます。

## セットアップ

Node.js 22 または 24、Python 3、git を用意して：

```sh
npm ci
npm run build
npm ci --prefix apps/mcp-server
npm run build --prefix apps/mcp-server
npm test
npm test --prefix apps/mcp-server
```

チェックアウトは、インストール済みの Kumi と `~/.kumi`（設定、サインイン、会話、ブリッジの状態）を共有します。`--allow-dirty` を付けると、コミットしていない変更のあるチェックアウトから `kumi bridge` がブリッジをインストールできます。Windows で開発者モードも管理者権限のシェルもない場合、シンボリックリンクを作るテストはスキップされるか失敗します。CI のランナーではシンボリックリンクを作れます。

## Kumi の開発

**変更ファミリー**（独自の HISTORY の行と取り消しを持つ、変更の種類）は、`BASE_CHANGES`（`packages/runtime/src/integrations/ableton/changes.ts`）または `MORE_CHANGES`（`more-changes.ts`）のエントリーで、`CHANGES` がこれらをまとめます。エントリーには、Kumi のツール名、ブリッジのプレビューと適用、ファミリー（HISTORY と NOW が描く、決まった絵柄のうちの一つ）、モデル向けの説明、そしてプレビューをわかりやすい言葉にする `summarize` が入ります。古いブリッジが拒否する場合は `since`（それが動作する最初のブリッジのリリース。`bridge-version.ts` にあります）を、Live に元に戻す手段がない場合は `permanent` を付けます。テストはすべてのファミリーについて、ツールが一意であること、素のプレビューからタイトルが作れること、説明がモデルに確認を求めないこと、ブリッジのツールがホスト専用であることを確認します。提供する前に、実際の Live で取り消しも含めて実行してください（`accept:live`）。

**アクション**（Set への変更ではなく、取り消すものがないもの。再生など）は、`actions.ts` の `ACTIONS` に入れます。

ブリッジのツールが変わったら、変更の評価が使う合成ブリッジを作り直します：`node apps/kumi/scripts/make-bridge-tools.mjs`（ビルド済みのブリッジが必要です）。

ターミナルアプリの設計と基盤については、[コマンド、キー、画面](KUMI_TUI.md#設計メモ)にあります。

## ブリッジの開発

| パス | 内容 |
| --- | --- |
| `src/host.ts` | MCP のディスパッチ、厳密なツールスキーマ、トランザクション、取り消しと回復 |
| `src/tool-catalog.ts` | 唯一のツールカタログ：スキーマ、アノテーション、各ツールに必要な機能、デプロイメントポリシークラス |
| `src/live.ts`、`src/registry.ts` | Live の型とアダプター。レジストリとそのハッシュの読み込みと検証 |
| `src/bridge/` | 認証付きループバッククライアント（`remote-adapter.ts`）、ルーター、拡張機能のチャネル、ランチャー、フォルダー |
| `src/transactions/` | バッチ、デバイスの状態、Session MIDI、ディスカバリのヘルパー |
| `src/mcp-protocol.ts`、`src/stdio.ts` | 両方のプロトコルバージョンの MCP ワイヤー処理 |
| `src/analysis*.ts`、`src/audio-*.ts`、`src/reference-analysis.ts` | 隔離されたワーカーでのオーディオ解析 |
| `src/delivery.ts`、`src/lifecycle*.ts`、`src/setup.ts`、`src/migrate.ts`、`src/diagnostics.ts` | 設定、シークレット、インストール、アップグレード、ロールバック、診断 |
| `src/als.ts`、`src/project*.ts`、`src/library-search.ts` | 保存された Set、Set のスナップショットと差分、Live のライブラリデータベース |
| `src/follow-actions.ts` | オプションの [Willington](WILLINGTON_INTEGRATION.md) の Follow Actions |

**契約ルール。**

- ワイヤープロトコルは `ableton-loopback/v1` です。正規 JSON（キーはソート、負のゼロは正規化）、リクエストとレスポンスの HMAC-SHA256、上限のあるフレームとコレクション、シーケンス番号、そして Remote Script が起動するたびに変わるエポックを使います。詳細は `remote-script/README.md` にあります。
- `protocol/` のレジストリが唯一の操作一覧です。ホストと Remote Script はそれぞれこれをハッシュし、両者が一致しなければ Live は接続しません。ホストのテストが Remote Script のハッシュ処理を実行して、両者が等しいことを保ちます。操作名やハッシュをほかのソースファイルに決してコピーしないでください。レジストリを変更したら、`apps/mcp-server` で `npm run capability:manifest` を実行します。
- 変更は、プレビュー、適用、取り消しを持つ用途別の操作を通じて行います。唯一の例外は `python.run`（`live_run_python`）で、Live のメインスレッドで Python を実行し、元に戻す手段は Live の取り消しだけです。これには独自のポリシークラス `python` があり、`full` プロファイルでのみ許可されます。
- ブリッジ内部の `get(ref)` は固定の行に対する上限付きのシリアライザーであり、Live のオブジェクトモデルの汎用リーダーではありません。MCP の読み取りは用途別のままにします。
- Remote Script は Live に関わる作業をすべて Live のメインスレッドで行います。Live の表示ティックの中で、時間の上限内に、ソケットを自分で処理します。ほかのスレッドは、診断ファイルの書き込みとリアルタイム UDP の受信だけです。新しいエポックは、それ以前のすべての参照とカーソルを無効にします。Remote Script が認識できない Live の形状は利用不可として報告し、決して偽装しません。
- stdout には MCP プロトコルだけを流します。診断は stderr に出し、リクエストのデータは含めません。
- プロセスバックのアダプターは非同期（`snapshotAsync`、`invokeAsync`、…）ですが、共有インターフェースとシミュレーターにはまだ同期メソッドがあります。プロセスバックのツールには `McpHost.handleAsync` を使います。同期のサーフェスがなくなるまで、互換性の作業は両方に対してテストしてください。
- テストは、実行中の Live、デバイス、特定のマシン、ローカルにしかない資料を決して必要としません。新しい操作にはすべて、不正な入力と回復を含めてテストを付けます。

**MCP のバージョン。** ブリッジは `2025-11-25`（initialize の後にリクエスト）と `2026-07-28`（リクエストごとの `params._meta` にプロトコルバージョンとクライアントの機能、さらに `server/discover`）の両方に対応します。一つのプロセスはどちらか一方を使います。未知のバージョンには `-32022`、不正なメタデータには `-32602` を返します。新しいバージョンの結果は `resultType: "complete"` を持ち、JSON を `structuredContent` でも返します。新しいバージョンにはプッシュがありません。`live_subscribe` は古いバージョンでのみ動き、新しいクライアントはポーリングします。クライアントのメタデータが Live へのアクセスを与えることは決してありません。[仕様](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)を参照してください。

## Live 拡張機能の開発

`apps/live-extension` は Live の Extensions SDK に対してビルドします。この SDK のライセンスは再配布を禁じているため、リポジトリには含まれていません。リポジトリのルートの `vendor/ableton-extensions-sdk-1.0.0-beta.1/` にコピーを置いてください（ビルドはその中の `package 3/dist/index.cjs` を読みます）。`apps/live-extension` はルートのワークスペースには含まれません。そこで `npm ci` を実行してから `npm run build` を実行すると、`dist/extension.js` とその `.sha256` が書き出されるので、両方をコミットします。SDK がない場合、ビルドは止まり、コミット済みのバンドルがそのまま残ります。テストはバンドルをそのチェックサムと照合します。Live が拡張機能をどう実行するかの測定結果は[エビデンス](../evidence/live-extension.md)にあります。

## リリース

**コミット**の件名は、プロデューサーにとって何が変わったかを平易な英語で書きます（"Kumi: talk to it while it works"）。ブリッジまたは Remote Script の変更では、`apps/mcp-server/package.json`（とそのロックファイル）のバージョンを上げ、件名を新しいバージョンで始め（"Bridge 1.0.71: …"）、`apps/kumi/scripts/eval-changes.mjs` の偽のブリッジのバージョンを上げ、`CHANGELOG.md` の `## Unreleased` の下に `### Bridge x.y.z` ブロックを追加します。ブリッジのツールが変わったら `apps/kumi/scripts/bridge-tools.json` を作り直し、拡張機能が変わったらそのバンドルを再ビルドしてコミットします。作業はブランチで行い、プルリクエストで `main` に入れます。

**Kumi のリリース：**

1. ブランチ上で、"Kumi X.Y.Z: the changelog, READMEs and versions" という件名のコミットを一つ作り、次のものを更新します。ルートの `package.json` とロックファイル、`apps/kumi/package.json`（そのバージョンと `@kumi/runtime` への依存）、`packages/runtime/package.json`、`packages/runtime/src/version.ts` のバージョン（テストがこの 4 つが等しいことを確認します）。3 つの README の Status（現状）の行。3 つの `KUMI_CHANGES.md` の「Bridge versions」（ブリッジのバージョン）の下にある、同梱するブリッジの行。そして `CHANGELOG.md` の `## Unreleased` を `## X.Y.Z — date` にし、どのブリッジを同梱するかを書いた行を加えます。
2. プルリクエストを "Kumi X.Y.Z (#PR)" という件名のマージコミットでマージします。
3. マージコミットに `vX.Y.Z` のタグを付けてプッシュします。Installer ワークフローがバンドルをビルドし、macOS、Linux、Windows でのインストールをテストし、`kumi.tar.gz`、`kumi-release.json`、`SHA256SUMS` を下書きのリリース "Kumi X.Y.Z" に添付します。
4. リリースノートを書いてリリースを公開します。そうして初めて、インストーラー、`kumi update`、更新確認がそのリリースを認識します。

`kumi-release.json` には、バンドルのビルドに使った Node 24 の正確なリリースが記録され、インストーラーはその Node を nodejs.org から Kumi と並べてダウンロードします。新しい Node のメジャーバージョンでリリースすると、`kumi update` はユーザーにインストーラーの再実行を求めます。

**ブリッジ**には独自のリリースはありません。ブリッジは各 Kumi リリースに同梱され、`main` での CI の実行ごとに、パック済みの候補が 90 日間保存されます。リリースに何が含まれ、どう確認されるかは[配布](DISTRIBUTION_POLICY.md)にあります。

## ドキュメント

`docs/en` のすべてのドキュメントには、日本語版と中国語版が `docs/ja` と `docs/zh-CN` にあり、README には `README.ja.md` と `README.zh-CN.md` があります。ある言語への変更は、同じプルリクエストで 3 言語すべてに入れます。ブリッジのドキュメント（その README と、`apps/mcp-server/scripts/release-documentation.mjs` に並んでいる `docs/en` の 14 ページ）はブリッジと一緒にパックされるので、名前は固定で、リンクは解決できなければなりません。`apps/mcp-server` のチェック（[テスト](TESTING.md#ドキュメント)を参照）は、ドキュメントに書かれた Node のバージョン、3 つのユーザーガイドが挙げるツール名、ファイル数が正しいことを確認します。

## 先行事例

ブリッジは、ほかの Ableton MCP サーバーを出発点にしています：[bschoepke/ableton-live-mcp](https://github.com/bschoepke/ableton-live-mcp)、[uisato/ableton-mcp-extended](https://github.com/uisato/ableton-mcp-extended)、[Simon-Kansara/ableton-live-mcp-server](https://github.com/Simon-Kansara/ableton-live-mcp-server)、[jasper-zheng/ableton-sdk-mcp](https://github.com/jasper-zheng/ableton-sdk-mcp)、[ahujasid/ableton-mcp](https://github.com/ahujasid/ableton-mcp)。
