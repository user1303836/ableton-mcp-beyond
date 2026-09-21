# 開発者ガイド

[English](../en/DEVELOPER_GUIDE.md) · [简体中文](../zh-CN/DEVELOPER_GUIDE.md) · 日本語

ソース、スキーマ、テストが権威です。エクスポートされたツール、アダプター
契約、マッパー、テストがサポートしない限り、ドキュメントはケイパビリティを
宣伝してはいけません。

## レイアウト

- `apps/mcp-server/src/host.ts`: MCP ライフサイクル、厳密なツールスキーマ、
  非同期ディスパッチ、トランザクション状態、回復エラー。
- `apps/mcp-server/src/tool-catalog.ts`: 単一の宣言的ツールカタログ —— スキーマ、
  アノテーション、正確なケーパビリティ/オペレーション/来歴の前提条件、
  デプロイメントポリシークラス —— ケーパビリティ対応の `tools/list`、
  capability リソース、list-changed 通知、サーバー側ディスパッチゲートを駆動。
- `apps/mcp-server/src/midi-transforms.ts`: 変換プレビュー/適用ツールが共有する
  純粋な決定論的シード付き MIDI 変換プリミティブ。
- `apps/mcp-server/src/live.ts`: Live タイプ、レジストリ派生識別子/ハッシュ、
  利用不可アダプター、シミュレーター、テストとプロセスバックの呼び出し側で
  現在使用されている同期および Promise ベースのアダプター契約。
- `apps/mcp-server/src/registry.ts`: 正規レジストリのロード、有界スキーマ
  検証、派生操作識別子/ハッシュ。
- `apps/mcp-server/src/bridge/remote-adapter.ts`: 認証済み非同期ループバック
  クライアント、レジストリネゴシエーション、デッドライン、相関、クリーン
  アップ。
- `apps/mcp-server/src/transactions/`: 有界 MIDI トランザクションと非同期
  ディスカバリヘルパー。
- `apps/mcp-server/src/analysis.ts`: 有界 PCM デコードとプライバシー保護
  解析。
- `apps/mcp-server/src/delivery.ts`: 設定、シークレット検証、パッケージ、
  インストール、診断。
- `protocol/ableton-live-v1.operations.json`: 正規バージョン 1 操作レジストリ。
  正規ハッシュはこのファイルから生成し、`docs/evidence/capability-manifest.json` に記録します。説明文を別のハッシュ権威にしません。
- `remote-script/AbletonMcpBridge/__init__.py`: 1 引数の Control Surface
  エントリーポイントとフェイルクローズドの参照ロード。
- `remote-script/ableton_mcp_remote_script.py`: 認証済みトランスポート、
  有界メインスレッドディスパッチ、エポックスコープ参照、形状依存の操作
  アドバタイズ、階層ディスカバリ、構造、MIDI、ロケーター、公開デバイス
  パラメータマッピング。

## MCP stdio 互換性

`mcp-protocol.ts` は wire 境界のみを担当し、Live の権限は作りません。
旧 `2025-11-25` は initialize/initialized を維持します。新 `2026-07-28` は各要求の `params._meta` にバージョン・クライアント能力が必須で、`server/discover` は任意です。
未対応バージョンは `-32022`、不正文法は `-32602`。成功結果に `resultType: "complete"` とサーバー情報、JSON ツール結果に `structuredContent` を追加します。
キャッシュは private / `ttlMs: 0`。探索後の旧初期化は可能ですが、その他の方式混在は拒否します。
新方式で MCP push / MRTR / Tasks / HTTP を広告せず、snapshot / observe-poll を使用します。RPC ID は完了後のみ再利用でき、取引 ID・冪等キー・承認を置き換えません。
キャンセルは応答排出まで所有権を保持し、取消後の応答や例外応答を抑止します。アプリケーションの回復状態は別に保持します。
ハンドルはプロセス内限定・有期限です。再起動は不確定な編集を再実行する許可ではありません。詳細・仕様リンクは [英語版](../en/DEVELOPER_GUIDE.md) と `mcp-protocol.test.ts` を参照してください。

## 契約ルール

ワイヤープロトコルは `ableton-loopback/v1` です。正規 JSON はキーをソート
し、負のゼロを正規化します。HMAC-SHA256 はリクエストとレスポンスを認証
します。フレーム、コレクション、ネスト、文字列、保留作業、シーケンスは
有界です。ネゴシエーションは、不正、重複、不明、未サポート、レジストリ
ハッシュ不一致の操作を拒否します。

プロセスバックのアダプターは、`snapshotAsync`、`getAsync`、`invokeAsync`、
`reconnectAsync`、`close` などの Promise ベースのメソッドを通じて消費
されます。共有 TypeScript インターフェースとシミュレーターは同期互換
メソッドを保持します。これはまだ計画されている単一の非同期契約ではあり
ません。`McpHost.handleAsync` はシーンオーディションおよびその他の
プロセスバック Live ツールに必要です。同期のシミュレーターのみの
サーフェスが削除されるまで、両方のパスで互換性作業を検証してください。
どちらの契約も汎用 `set` を公開しません。変更は正規の用途別操作を通じて
のみ利用可能です。

Python ワーカーはフレーミング、認証、シーケンシング、キューイングのみを
実行します。Live 向けの走査と変更は、スケジュールされたメインスレッド
コールバックによってドレインされます。新しい接続エポックは以前の参照と
カーソルを無効にします。サポートされていない Live 形状は利用不可であり、
捏造されません。デバイスコントロールは、有効な境界、量子化、有効状態、
オートメーション可能状態、親子関係、変更後読み戻しを持つ権威ある公開
数値パラメータに限定されます。ディスカバリ行は親参照を保持します。空の
クリップスロットは明示的な行であり、クリップとして推測してはいけません。

決定: ブリッジ `get(ref)` は固定行上の内部有界シリアライザーのままとし、
汎用 Live Object Model プロパティリーダーとしても、汎用 MCP 読み取り
サーフェスとしても公開しません。MCP の読み取りは用途別
(`live_status`、`live_snapshot`、`live_discover`、ケイパビリティ/
ステータス行)に限定し、ディスカバリの要求フィールドはそれらの固定行
上の投影です。これは未実装の汎用リーダーではなく、意図的な境界です。

## コマンド

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

`dist/` とパッケージアーカイブは生成された出力であり、ステージしては
いけません。ローカルのみの参考資料をフィクスチャやパッケージ入力として
使用しないでください。stdout をプロトコルのみに保ち、stderr で診断を
秘匿してください。`extensions-sdk-1.0.0-beta.0` を変更、ステージ、
パッケージ、コピー、公開しないでください。
