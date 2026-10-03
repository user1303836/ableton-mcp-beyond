# テスト

[English](../en/TESTING.md) · [简体中文](../zh-CN/TESTING.md) · 日本語

リポジトリの各部分のテストの実行方法、それに必要なもの、CI が何を実行するかをまとめます。通常のテストには、Live もサインインも必要ありません。

## クイックスタート

チェックアウトから、Node 22/24 で実行します（Node 24 LTS を推奨）：

```sh
npm run setup                                   # すべてをインストールしてビルド
npm test                                        # Kumi：アプリ、ランタイム、Live 拡張機能
(cd apps/mcp-server && npm test)                # ブリッジ
python3 -m unittest discover -s remote-script -p 'test_*.py'   # Remote Script
```

Node 以外のものも必要なチェックがあります：

| 必要なもの | 用途 |
| --- | --- |
| PATH 上の Python 3（`python3`、Windows では `python.exe`。CI は 3.11 を使用） | Remote Script のテスト、`package:verify`、`journey:verify` |
| PATH 上の `ffmpeg` | `audio:oracle` |
| `vendor/` にローカルで用意した Extensions SDK | Live 拡張機能のビルドや型チェック（そのテストには不要） |

Windows では、いくつかのテストがシンボリックリンクを作成するため、開発者モードか管理者アカウントが必要です。それがないと、一部のテストはスキップされ、いくつかは `EPERM` で失敗します。CI の Windows ランナーにはその権限があります。

## Kumi

リポジトリのルートから実行します。

| コマンド | 内容 |
| --- | --- |
| `npm run typecheck` | ランタイムをビルドしてから、アプリとランタイムの型チェックをします |
| `npm test` | ビルドしてから、アプリ、ランタイム、Live 拡張機能のテストを実行します |
| `KUMI_TEST_BRIDGE=1 npm test` | 同じですが、ブリッジとの相互運用テストをスキップせず、必須にします。先にブリッジをビルドしてください（`npm run setup` がビルドします） |

`npm test` はテスト専用のホームを用意します。`HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`XDG_CONFIG_HOME`、`KUMI_HOME` は新しい一時フォルダーの中を指し、`KUMI_REMOTE_SCRIPTS_DIR` と `KUMI_LIVE_EXTENSIONS_DIR` は取り除かれるので、どのテストもあなたの Live のフォルダーや `~/.kumi` には届きません。

## ブリッジ

`npm ci` を実行した後、`apps/mcp-server` から実行します。

| コマンド | 内容 |
| --- | --- |
| `npm run typecheck` | ブリッジの型チェックをします |
| `npm test` | ビルドし、各テストファイルを一つずつ実行し、続いてスクリプトのテストを実行します：リリースドキュメント、機能マニフェスト、ドキュメントのドリフト、CI の保持期間 |
| `npm run property-test` | 生成した音声に対する、音声解析のプロパティテスト：有界、有限、結果に生の PCM を含まない |
| `npm run coverage` | V8 カバレッジ付きのテスト：全体で行の 85% 以上、分岐の 65% 以上、関数の 84% 以上、モジュールごとの下限、そして delivery、lifecycle、host、remote-adapter、project、Session MIDI にはより高い基準 |
| `npm run benchmark` | 最大の音声入力でのレイテンシー（計測用のインストルメンテーションなし）。`npm test` やカバレッジには含まれません |
| `npm run audio:oracle` | 生成した音声で、ラウドネスとトゥルーピークの測定値を FFmpeg の `ebur128` と比較します |
| `npm run compatibility` | `policy:verify`（package.json、CI、ドキュメント内の Node ポリシー）を実行し、続いてこの Node とシステムを確認します |
| `npm run package:verify` | ブリッジをパックし、tarball をインストールして確認します（後述） |
| `npm run journey:verify` | パックしたブリッジをインストールし、それを通じて 5 つのユーザージャーニーを、偽の Live に対して実行します |
| `npm run capability:manifest` | レジストリを変更した後に `docs/evidence/capability-manifest.json` を再生成します。テストがそれを比較します |

`package:verify` は、自身のリストにないファイルをすべて拒否し、`release-manifest.json` 内のすべてのハッシュと、`LICENSE.md` がリポジトリのものと一致することを確認します。続いて、インストールされたサーバーを両方の MCP プロトコル世代で起動し、`setup`、`migrate`、`diagnostics` を実行し、名前にスペースと非 ASCII 文字を含むフォルダーでライフサイクル（install、Live に到達できないアクティベーション、repair、拒否されるロールバック、uninstall）を実行し、インストールされた Remote Script に、偽の Live に対する認証済みのディスカバリーに応答させます。`ABLETON_MCP_ARTIFACT=<tarball>` を指定すると、`package:verify` と `journey:verify` は自分でパックする代わりに、指定した tarball を確認します。

## Remote Script

リポジトリのルートから：

```sh
python3 -m unittest discover -s remote-script -p 'test_*.py'
python3 -m compileall -q remote-script/AbletonMcpBridge
```

テストは Remote Script を偽の Live オブジェクトに対して実行します：認証、シーケンス、メインスレッドのキュー、レジストリとそのハッシュ、ディスカバリー、トランザクション、キャプチャとリアルタイムの安全性、そしてオプションの Willington プロバイダーです。

## Kumi の Live 拡張機能

ルートの `npm test` は `apps/live-extension/test` を実行します。これはコミットされた `dist/extension.js` を偽の Live に対して読み込み、記録された sha256 と照合します。ビルド（`apps/live-extension` での `npm run build`）には `vendor/` 内の Extensions SDK が必要です。それがなければ、コミットされたビルドがそのまま残ります。再ビルドした後は、`dist/extension.js` をその `.sha256` と一緒にコミットしてください。

## Live やモデルを使うチェック

これらはオプトインです。実際に何かを変更したり実際にトークンを消費したりするので、CI では実行しません。

| コマンド（ルートから） | 必要なもの | 内容 |
| --- | --- | --- |
| `npm run accept:live --workspace @kumi/app -- --set "<Set>"` | Set の使い捨てコピーを開いた Live | Kumi ができるあらゆる種類の変更を行い、それぞれを Kumi の取り消しで元に戻し、再生、バウンス、聴き取り、監視を行い、大きな Set の読み取りにかかる時間を計測します。モデルは使いません。 |
| `npm run eval:changes --workspace @kumi/app [-- <case>, <case>]` | サインインとモデル | モデルが Kumi のツールをどう使うかを、本物のブリッジのツールスキーマを持つ合成ブリッジに対して評価します。Live には一切触れません。各ケースは、かかった時間、そのうちツールの時間、モデルの呼び出し回数を示します。`EVAL_EFFORT` でモデルの推論の度合いを設定し、`EVAL_TRACE=1` で呼び出しを一つずつ表示します。 |
| `npm run probe:inference --workspace @kumi/app` | サインイン | 無害なツールを使った認証済みのリクエストを一つ送ります。Live には一切触れません。 |

ブリッジのツールが変わったら、（ブリッジをビルドした状態で）`node apps/kumi/scripts/make-bridge-tools.mjs` を実行し、`eval:changes` が使うスキーマを更新してください。その Operator、Saturator、EQ Eight には、Live から `apps/kumi/scripts/live-devices.json` に読み込んだ、Live 12.4 のすべてのパラメータがあり、パラメータを設定する Kumi 自身のスクリプトを Live と同じように実行します。

ブリッジには、オペレーター専用のキャプチャのチェック `npm run audio:live-verify`（`apps/mcp-server` 内）もあります。これには、ライフサイクルでインストールして本物の Live でアクティベートしたブリッジ、準備済みの使い捨ての Set、そして `PHASE8_CLI`、`PHASE8_RECEIPT`、`PHASE8_EXPECTED_GIT_SHA`、`PHASE8_TARBALL_SHA`、`PHASE8_EXPECTED_REGISTRY_HASH`、`PHASE8_OUTPUT_SAFETY_PROVENANCE` が必要です（任意：`PHASE8_CONFIG`、`PHASE8_SET_NAME`、`PHASE8_LIVE_VERSION`、`PHASE8_SOURCE_TRACK_INDEX`、`PHASE8_DESTINATION_TRACK_INDEX`、`PHASE8_RECORDED_DIRECTORY`）。Live に触れる前にインストールされたファイルをレシートと照合し、その後キャプチャを録音、キャンセル、回復し、変更したものをすべて元に戻します。

## ドキュメント

ドキュメントを編集した後、`apps/mcp-server` から実行します（そこで `npm ci` を実行済みであること）：

```sh
npm run policy:verify
node --test scripts/docs-drift.test.mjs scripts/release-documentation.test.mjs
```

`policy:verify` は、対応する Node のバージョンを記載しているドキュメントと README のバッジが、引き続き 22 と 24 を示しているかを確認します。ドリフトテストは、英語、中国語、日本語のユーザーガイドが同じツールを挙げていること、そして manifest や tarball のような語の隣にファイル数が書かれていないこと（代わりに `release-manifest.json` を挙げます）を確認します。リリースドキュメントのテストは、パックされたブリッジのガイドをステージングし、その中のすべてのリンクを確認します。`npm run package:verify` は、インストールされたパッケージ内の同じガイドを確認します。

## CI

プルリクエストのたびに、また `main` へのプッシュのたびに、三つのワークフローが実行されます：

| ワークフロー | ジョブ | 実行内容 |
| --- | --- | --- |
| **CI** | `Build exact local candidate`（Ubuntu、Node 24） | 空白のチェック。ブリッジを二回パックし（二回目は新しいクローンから）、バイト列が同一であることを求めます。tarball を `exact-local-candidate` アーティファクトとして 90 日間保持します |
| | `Coverage, benchmarks and the audio oracle`（Ubuntu、Node 24、候補と並行） | ブリッジの型チェック、カバレッジ（機能テスト）、リリーススクリプトのテスト、プロパティテスト、ベンチマーク、`audio:oracle`、`compatibility`、`package:verify` |
| | `Node 22, 24 / ubuntu-24.04`、`Node 24 / macos-15`、`Node 24 / windows-2025 / candidate` と `/ tests 1/4` から `4/4` | ブリッジの型チェックとテスト（Windows では各ファイルのコストで均した 4 つのシャードで。`TEST_SHARD=1/4` で一つを選択）、プロパティテスト、`compatibility`。同じ tarball に対する `package:verify`、`scripts/verify-candidate.mjs`、`journey:verify`。セットアップ、移行、診断 |
| | `Python Remote Script contract`（同じ三つのシステム、Python 3.11） | Remote Script のファイルを tarball と照合し、Python のテストを実行し、パッケージをコンパイルします |
| | `Required CI` | 上記がすべてパスした場合にだけパスします |
| **Kumi** | `Kumi / Node 22`、`Kumi / Node 24`（Ubuntu）、`Kumi / macOS / Node 24`、`Kumi / Windows / Node 24` | ルートの型チェック、ブリッジのビルド、`KUMI_TEST_BRIDGE=1` を付けた `npm test`、`git diff --check` |
| **Installer** | `Build Kumi's Mac helper`、`Build the release bundle`、続いて `Install / macOS`、`Linux`、`Windows` | Mac で Kumi が Live のメニューを使うためのヘルパー（ユニバーサル、署名済み）をビルドし、それを含むバンドルをビルドしてローカルで配信します。各システムで：プロデューサーと同じ方法でインストールし（Windows では Windows PowerShell 5.1）、バージョン、`doctor`、ブリッジの読み込みを確認し、修復として再インストールし、使い捨ての Remote Scripts フォルダーに `kumi bridge --yes` を実行し、`kumi update`（macOS と Linux では `--rollback` も）、`kumi uninstall` を実行します。`v*` タグでは、続いて `publish` がバンドルをリリースに添付します。 |

`main` にマージするには、`Required CI` と 4 つの Kumi ジョブがパスする必要があります。Installer は必須ではありません。残りのルールは[リリースと配布](DISTRIBUTION_POLICY.md#マージゲート)にあります。

## パスが意味すること

パスは、コードがテストに書かれたとおりに動作すること、パッケージが macOS、Linux、Windows でインストールでき動作すること、インストーラーが GitHub のランナー上で動作することを示します。Remote Script があなたの Live で読み込まれること、Live の API が偽物と同じ形をしていること、何かがどう聞こえるか、ターミナルやスクリーンリーダーが Kumi と一緒に動作することは示しません。本物の Live については、上記のオプトインのチェックと、[実装状況](IMPLEMENTATION_STATUS.md#エビデンス)にある記録がカバーしています。

## テストを書く

新しいプロトコルメソッドや Live への変更を追加するたびに、それが動作することのテストと、拒否すべきものを拒否することのテストを追加してください：古い参照、リビジョンとエポック、期限切れの確認、再利用された冪等性キー、タイムアウト、送信前と送信後のキャンセル、切断、失われた確認応答、部分的な変更、失敗した補償、その間に Live で行われた変更、そして取り消し。テストが何を主張するかについて、偽の Live、シミュレーター、本物の Live を区別してください（`fake-live`、`simulator`、`real-live` の来歴）。フィクスチャは小さく、個人データを含まないようにし、テストが本物の Live のフォルダーや `~/.kumi` に決して届かないようにしてください。
