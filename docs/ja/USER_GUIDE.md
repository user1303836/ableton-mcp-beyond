# ユーザーガイド

[English](../en/USER_GUIDE.md) · [简体中文](../zh-CN/USER_GUIDE.md) · 日本語

MCP クライアントから Ableton MCP Beyond をインストール・設定・操作する方法。

サーバーはフェイルクローズドです:`--config` なしでは
`UnavailableLiveAdapter` を使用し、Live を一切読み取りも変更もしません。
ループバック、シークレット、プロトコル、操作レジストリハッシュ、ステータスの
ネゴシエーションがすべて成功して初めてブリッジが受け入れられます。

## インストールと起動

サポートされるランタイム: Node.js 22 / 24 / 25。ソースチェックアウトから:

```sh
cd apps/mcp-server
npm ci
npm run build
node dist/src/cli.js                              # フェイルクローズドのホスト
node dist/src/cli.js --config /absolute/path/bridge-config.json
```

受け付ける CLI オプションは `--config PATH` 1 つのみです。シークレット、
エンドポイント、アダプター、ケイパビリティを MCP 引数やクライアント
メタデータから選択することはできません。プロトコル `2025-11-25` で
JSON-RPC を初期化し、続けて `notifications/initialized` を送信してください。

tarball によるインストールは、[DELIVERY.md](DELIVERY.md) のレシート駆動
`ableton-mcp-lifecycle` フローで、インストール、アクティベーション、
アップグレード、修復、ロールバック、アンインストールを行います。成果物は
正確なパスと SHA-256 でインストールされます。

## 読み取り専用ツール

- `server_status` と `capabilities` はホスト状態とネゴシエート済みカタログを報告します。
- `live_status` はプロトコル、アダプター、エポック、レジストリハッシュ、操作、接続状態を報告します。
- `live_snapshot` は `session.read` がネゴシエートされている場合に有界な Set スナップショットを返します。偽の不完全な Live 形状でのフォールバック値は、Live 状態の証拠ではなく利用不可の証拠として扱ってください。
- `live_discover` はネゴシエート済みのすべての種別を検証し、子種別には親を要求します。アダプターがマッパーディスカバリを公開する場合、`set`、`track`、`return-track`、`main-track`、`scene`、`clip-slot`、`session-clip`、`arrangement-clip`、`note`、`locator`、`device`、`parameter`、`selection`、`routing-choice`、`session-playback` を受け付け、有界な親、最大 8 つのスカラーフィルター、要求フィールド、走査バジェット、ページング、エポック/リビジョン bound のカーソルをサポートします。互換フォールバックは `track`、`scene`、`clip`、`note` に限定されます。
- `audio_analyze` は呼び出し側提供の float32 PCM を解析し、有界な集約、波形、スペクトル、トランジェント、ダイナミクス、クリッピング、ITU-R BS.1770-5/EBU ラウドネス、LRA、検証済み 44.1/48 kHz トゥルーピークの要約を返します。分離されたキャンセル可能なワーカーで実行され、Live のオーディオをキャプチャせず、生サンプルを返しません。
- `audio_compare_reference` は 2 つの有界 PCM ソースを、帯域制限リサンプリング、粗から精への(または明示的な手動/無効)アライメント、規格ベースのレベルマッチ助言、集約デルタで比較します。自動アライメントが弱い場合、個別のソース解析は保持されますが、オーバーラップと比較デルタは保留されます。アライン済み PCM は返しません。
- `audio_diagnose_live_context` は呼び出し側 PCM の測定値を 1 つの新鮮な正確な Live トラックスナップショットに関連付けます。この関係は呼び出し側の宣言であり未検証です。観測されたデバイスはコンテキストであり、原因とは断言されません。
- `live_audio_capture_status` は実ブリッジがキャプチャプロバイダーをネゴシエートした場合に読み取り専用です。マッパー権限と生ファイルパスは秘匿されます。
- `plan_user_journey` は、ビート/ソング作成、高度なドラム、サウンドデザイン、リファレンス比較、ミックス/録音/パフォーマンス診断のための、非変更・ケイパビリティ対応のプランを返します。[USER_JOURNEYS.md](USER_JOURNEYS.md) を参照してください。

## 変更ワークフロー

すべての Live 変更には、接続済みのネゴシエート済みアダプター、新鮮な
ディスカバリ、読み取り専用プレビュー、正確な確認、有界な冪等キー、
エポック/リビジョンチェック、権威ある事後検証が必要です。実装済みの
ワークフロー:

- `live_device_parameter_preview/apply` —— 権威あるデバイス上の、発見済みの有効な数値パラメータ。境界、有限値、量子化、親子関係、リビジョンがチェックされます。`live_undo` でガード付きアンドゥ。
- `live_session_structure_preview/apply` —— 有界な名前付き MIDI/オーディオトラックとシーンの作成。挿入インデックスは通常トラックのみを指し、変更前に現在のコレクションと照合されます。既存のオブジェクト、クリップ、デバイス、ルーティング、トランスポート、録音は変更されません。
- `live_midi_clip_preview/apply` —— 空の Session スロットへの有界な MIDI クリップ(正規化ノートを含む)。適用時にクリップを作成し、検証済みの全ノートセットを 1 回の正規 `note.add-batch` 変更で送信し、権威あるノート内容を検証します。
- `live_arrangement_section_preview/apply` —— 衝突しない有界な範囲の 2 つの名前付きロケーター。
- `live_tempo_preview/apply` —— 有界なテンポ変更。
- `live_undo` —— エポックと検証済み事後状態が一致する適用済みトランザクションのアンドゥ、または不変エポックでの応答喪失アンドゥの正確なキー照合。
- `live_recovery_finalize` —— 明示的な権威ある手動回復の証拠があった後にのみ、回復保護されたレコードを退役させます。Live を変更せず、アクティブな可聴作業を拒否し、レコードを破棄する前に Remote Script のリプレイ権限を退役させます。
- 個別の操作がネゴシエートされている場合の、用途別クリップ起動/停止、トランスポート、ノート更新/削除、クリップ複製/移動/リネーム、トラック/シーン/デバイス/ロケーターリネーム、Arrangement クリップ作成/移動、オーディオクリップ、ミキサー、Session オートメーション、Browser/デバイス挿入、ルーティング、録音、プロジェクトバックアップ、サブスクリプション、リアルタイムの各ワークフロー。Capture MIDI はすべての Session スロットが空の場合のみネゴシエートされます。デバイスや Arrangement クリップの恣意削除は、以前の状態を再構成できないため拒否されます。`live_undo` による、ID とフィンガープリントに紐づくトランザクション所有のクリーンアップのみが利用可能です。
- オーディオクリップのプレビューは、その正確なクリップが通知するフィールド(`availableAudioFields`)のみを受け付けます: ゲイン、ピッチ、ループ、ワープ有効/モード、フェード(サポートされる場合)。ワープマーカーは有界な読み戻しのみです。マーカー編集、テイクレーン、コンピングは利用できません。
- デバイスディスカバリは正規の親参照で rack/chain を再帰的に走査します。Browser のロードは新鮮で正確な `browser.inspect` 結果を必要とし、デバイス以外の項目を拒否し、空のデバイスオーナーを対象とするため、ロード失敗時のクリーンアップが無関係な兄弟に影響しません。
- `live_session_audition_preview/apply/stop` —— ガード付きの、可聴の可能性のある Session シーン 1 回の起動。プレビューは読み取り専用で、正確な Set 名、権威ある停止/非録音の再生状態、armed または入力モニターのトラックがないこと、安全な起動量子化、呼び出し可能な launch/stop 操作、明示的な出力安全性の証拠を必要とします。適用には正確なプレビュー確認と冪等キーが必要で、1 回起動して新鮮な fired/playing 状態を検証します。停止には返された停止確認が必要で、マッパー所有の再生のみを停止し、停止したベースラインを検証します。

プレビューレコードは 30 秒で期限切れになります。応答喪失、タイムアウト、
切断、検証失敗、補償失敗は**不確定な状態**です。新しい権限や新しい冪等
キーを決して送信しないでください。同じブリッジと Live エポック内で、
実行中のホストは Remote Script の実行台帳に対して、元のトランザクション、
確認、引数、冪等キーのみを照合し、その後で新鮮な事後状態を検証できます。
どちらかのエポックが変わった場合は、変更を停止して新鮮な権威ある状態から
回復してください —— [RECOVERY.md](RECOVERY.md) を参照。

## 同意ベースの Live オーディオキャプチャ

Live のオーディオは Remote Script のメタデータでは公開されません。キャプチャは
`live_status` が `real-live`、`audio.capture.resampling`、および 6 つすべての
`audio.capture.*` 操作を報告する場合にのみ利用可能です。

1. 使い捨ての Set を保存して目視で確認します。すべてのトラックが unarmed で、録音と再生がオフで、モニタリング/出力レベルが安全であることを確認します。
2. 1 つの正確なソース Session クリップと、別の空のオーディオスロットを選択します。デスティネーションの現在の入力ルートは、復元できるよう選択可能でなければなりません。Live の古い `Ext. In` 値が利用できない場合は、通常のルーティング preview/apply ワークフローで安全な `No Input` ベースラインを選択してください。
3. 正確な Set/スロット参照、1〜9 秒の長さ、`consent=ephemeral-analysis-and-delete`、新鮮な出力安全性の証拠で `live_audio_capture_preview` を呼び出します。
4. 開示された可聴/録音への影響、ウォッチドッグ/回復ツール、デスティネーションのベースライン、有効期限を確認します。正確な予測不可能な確認と新しい冪等キーで 1 回だけ適用します。
5. 成功した結果には、規格解析と証拠にリンクされた診断が含まれますが、PCM、パス、トークン、確認、生ダイジェストは含まれません。停止したトランスポート、復元されたルート/arm/モニタリング、正確な Live クリップの削除、WAV/ASD のアンリンク、保持された生オーディオがないことが報告されなければなりません。
6. キャンセル、ホスト障害、タイムアウト、応答喪失の場合は、新しいプロセスから `live_audio_capture_status` を呼び出します。その正確なキャプチャがクリーンでない場合は、`confirmation=emergency-stop-and-clean` と新鮮に観測した正確な ID で `live_audio_capture_emergency_stop` を呼び出します。残留状態がある間は、別のキャプチャを開始しないでください。

DSP 規格、制限、プライバシー、リファレンス比較、診断セマンティクス、
回復の詳細は [AUDIO_INTELLIGENCE.md](AUDIO_INTELLIGENCE.md) を参照してください。

## 設定とインストール

まずビルドし、ホストのみの設定を作成します:

```sh
npm run setup -- --output /absolute/path/client-config.json
```

ブリッジ設定の場合は、別途オーナー専用のシークレットファイルを作成してから実行します:

```sh
npm run setup -- --output /absolute/path/bridge-config.json \
  --bridge-host 127.0.0.1 --bridge-port 9000 \
  --realtime-port 9001 \
  --secret-file /absolute/path/bridge.secret --bridge-timeout 5000
```

バージョン 2 は明示的な `--config PATH` 引数を書き込みます。シークレットは
クライアント引数、パッケージ、Remote Script 参照、ログ、診断に決して含まれ
ません。パスは明示的で安全な非シンボリックリンクである必要があります。
ホストはループバックである必要があります。シークレットは強力でオーナーが
管理するものである必要があります。`--realtime-port` はオプションで、認証済み
TCP ポートと異なる必要があり、[REALTIME_CONTROL.md](REALTIME_CONTROL.md) で
説明されている個別にアームされるチャンネルのみを有効にします。

Remote Script は明示的に選択した宛先にのみインストールしてください:

```sh
npm run build
node dist/src/install-remote-script.js --destination /absolute/path/ControlSurface --dry-run
```

インストーラーはデフォルトでシンボリックリンクツリーと上書きを拒否します。
`--force` は既知の回復可能な宛先専用です。Live に接続する前に
[LIVE_SAFETY.md](LIVE_SAFETY.md)、[OPERATIONS.md](OPERATIONS.md)、
[RECOVERY.md](RECOVERY.md) を読んでください。

## リソースとプロンプト

読み取り専用リソースには、`ableton://capabilities`、`ableton://safety`、
`ableton://journeys`、`ableton://max-extension`、および安全なテンポワーク
フローが含まれます。プロンプトはリクエストを準備するもので、変更権限を
付与しません。どのリソースやプロンプトも、シーン起動、録音、ルーティング、
オーディオキャプチャを許可しません。
