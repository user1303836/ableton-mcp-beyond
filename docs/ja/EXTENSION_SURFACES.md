# 拡張サーフェス: 評価とディスポジション

[English](../en/EXTENSION_SURFACES.md) · [简体中文](../zh-CN/EXTENSION_SURFACES.md) · 日本語

通常の Remote Script メンバーではない Ableton のサーフェスと、安定した
公開 LOM が公開しない Live UI 機能。各項目には明示的なディスポジション
があります: 別の場所で実装済み、記録された設計で実現可能、記録された
理由で延期、または辞退。これらはブリッジの欠陥ではなく、異なる権限
要件を持つケイパビリティ層です。

## モデル非依存の実行・検証 toolkit

MCP は維持するアダプターであり、特定モデルへの依存ではありません。既存の protocol 境界、型付き discovery、transaction と検証が基盤です。独立した汎用 executor SDK や簡潔な task API を出荷したという意味ではありません。

- **観測:** 有界の構造化状態、交渉済み capability、deployment policy、現在の ref / identity / revision を提供します。task 単位の簡潔な discovery は #55 の後続作業で、raw tool 数の拡大ではありません。
- **選択:** 推論は任意の client / harness に置きます。LLM、人間、構造化 selector が操作と対象を提案しても、決定論的に互換性と新鮮な権限を再検証します。Jev は型付き選択の候補で、**スクリーンショット解釈モデルではありません**。型、確率、confidence、MCP client metadata は正しさや同意を証明しません。Ableton 固有の速度・較正・成功率は未測定です。
- **実行:** どの interface でも認証、policy、正確な identity / revision、preview、明示的承認、expiry、idempotency を保持します。承認は信頼された client / operator 境界から必要で、サーバーの boolean だけでは独立した人間の同意証明になりません。batch は保護された補償付き逐次実行であり atomic commit ではありません。
- **検証・回復:** postcondition と所有権を独立に確認します。応答喪失は正確な実行台帳で照合し、値の一致だけでは不十分です。cancel / restart 後の自動再試行ではなく、不確定性と所有対象の回復を保持します。音声測定は技術的事実で、音楽的な良さの証明ではありません。

Jev の背景: [TypeSafe 紹介](https://typesafe.ai/blog/introducing-system-one-models-and-jev)、[型付き判断](https://docs.typesafe.ai/)、[confidence](https://docs.typesafe.ai/confidence)。vendor の性能主張は本プロジェクトの証拠ではありません。hosted inference は任意・明示的データ共有で、audio thread / sample-accurate 制御ではありません。

## 保護された GUI pilot（設計のみ、未実装）

正確な MIDI、routing、parameter は決定論的 API を優先します。最初の実験は、明示的に選択した範囲を**新しい承認済み WAV パス**へ export し、実ファイルを検証する 1 つの不足機能に限定します。無制限 click / type / shell tool や、広範な plug-in、comp、freeze / flatten、Save As 自動化を追加しません。

API と同じ承認・policy・実行境界で、Live app / window と Set identity を束縛します。協調する writer を直列化し、人間や他 controller の干渉を検出します。desktop の排他的所有は主張しません。実測した accessibility を優先し、focus / layout / dialog 変更後は再観測、不明 dialog では停止します。緊急停止を保持し、不確定なファイル書き込みは自動再試行しません。ファイル identity / format / duration と関連 LOM 状態で検証し、DONE やファイルの存在だけを成功としません。画面・ファイル・track の文字列は非信頼データで、外部送信を最小化します。

**独立した無制限 desktop agent は MCP の保護を迂回できます。** backend の安全保証をその構成へ流用したり、confidence を権限にしてはいけません。保持型 real-time bounce (#52) は別の routing / recording / file 所有ワークフローです。現在の分析 capture は一時音声を削除し、保持 bounce / offline export ではありません。

共通の producer task で MCP-only / GUI-only / hybrid を比較し、planner、budget、開始 Set、成功条件を揃えます。追加の capability coverage は別に報告します。繰り返し実行で、検証済み完了、意図しない変更、p50 / p95 時間、実モデル費用、承認・救済、stale state、応答喪失、focus / dialog 中断、回復を測定します。selector 比較は同じ executor / action space を使用し、人間の音楽的評価は別にします。モデル / GUI の認証済み評価はありません。

## 公開 Ableton Extensions の調査（延期）

[公開発表](https://www.ableton.com/en/blog/introducing-extensions-sdk/) と [公開ドキュメント](https://ableton.github.io/extensions-sdk/) は限定的 API-gap 調査の根拠で、backend 置換の根拠ではありません。2026-09-21 時点の Suite-beta / 単発 context-menu workflow は、永続 MCP transport、Standard / Intro / Lite 対応、全 LOM 同等性、export / comp API を証明しません。実装前に公開版・edition 制約を再確認します。
Remote Script を保持し、保護されたローカル `extensions-sdk-1.0.0-beta.0` を開く・コピーする・引用することは禁止のままです。今回の maintenance は SDK 統合や GUI 実装を含みません。

順序: 出荷済み batch 基盤の活用、task discovery (#55) と guided onboarding (#66)、1 つの保護された export pilot、保持 bounce / audio feedback (#52) の評価。simulator、packaged fake-Live、host CI は、正確な候補の実 Live、第三者 client、GUI、モデル、聴取検証と区別します。[DELIVERY.md](DELIVERY.md) / [TESTING.md](TESTING.md) を参照してください。

## Max for Live

出荷済み Remote Script の範囲は [CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md) に記録します。現在 / beta の全 Live API を網羅したという主張ではありません。残る Max 専用サーフェスとそのディスポジション:

| サーフェス | ディスポジション |
|---|---|
| コンパニオン `.amxd` 内の `live.path`、`live.object`、`live.observer` | 実現可能、延期。設計: 認証済みリアルタイムチャネル上で既存の有界 `max` ラベルパケット契約(トークン/TTL/世代フェンス)を話すバージョン管理コンパニオンデバイス。第 2 の権限平面は追加しない。Remote Script で本当に得られないサーフェスが必要な場合のみ出荷 — 現時点では不要 |
| `live.remote~`(シグナルレートのパラメータ制御) | 延期。現在の 64 パケット/秒 UDP チャネルは意図的に同等ではない。シグナルレート制御は今日の製品要件ではない。採用する場合: 専用コンパニオンデバイスで、明示的なオペレーター権限とレイテンシ測定を行い、既存チャネルと偽装しない |
| `live.modulate~`(加算モジュレーション) | 同じ設計で延期。加算モジュレーションは基本パラメータ値を置き換えない |
| `live.map`(オペレーター駆動マッピング) | 延期。マッピングはオペレーターの UI ワークフロー。候補はディスカバリ行から生成し、設計が出荷される際はパラメータトランザクション経由で適用 |
| `live.banks` / MaxDevice バンク API | 公開されている範囲で実装済み: Max デバイスのオーディオ/MIDI IO 記述子とパラメータバンクはデバイス行で公開(P1.11/P1.13) |
| `live.routing`(Max デバイスルーティング UI) | 上記コンパニオン設計で実現可能。トラック/チェーン/デバイスルーティングが Remote Script 経由で型付けされているため現在不必要 |
| `live.push`(Push パッドレイアウト/カラー) | 延期。下記 Push セクション参照 |
| `live.miditool.in` / `live.miditool.out`(MIDI Generator/Transformation ツール) | 延期。ネイティブ MIDI ツール開発は Remote Script ではなくコンパニオン設計に属する。今日は主張しない |
| `live.thisdevice`、`live.param~`、DSP とデバイスライフサイクル | MCP Remote Script とは明確に区別され、恒久的にその範囲外 |

誠実な `ableton://max-extension` リソースは、バージョン管理された
パケットレベルの拡張ポイントのままです。ランタイムは OSC/realtime を
アドバタイズし、`max` ケイパビリティは主張しません: バンドルされた
`.amxd`、ハンドシェイク、任意パケット権限は主張されません。

## Ableton Link と Link Audio

| サーフェス | ディスポジション |
|---|---|
| LOM Link コントロール | 実装済み: `is_ableton_link_enabled`、`is_ableton_link_start_stop_sync_enabled`、および明示的なタイミングと可聴権限フェンス付きの `force_link_beat_time`(P1.6) |
| 外部 Link SDK ピア(ビート、テンポ、フェーズ、量子、スタート/ストップ、ピア発見) | 延期、設計記録済み。外部 Link ピアは独自のネットワーク権限を持つ別プロセス: ループバックブリッジがサイレントになるのではなく、独自の発見、レイテンシ、プライバシーレビューを伴う明示的なオペレーター選択でなければならない。別の実現可能性/設計 issue として追跡 |
| Link Audio 送受信 | 延期。同じ外部ピア設計に加えてオーディオプライバシーとルーティング分析が必要。Link Audio ピアへのトラックルーティングは、他のルーティング変更と同様に型付けされオペレーター承認されなければならない |

## Push とハードウェアコントロールサーフェス

| サーフェス | ディスポジション |
|---|---|
| 公式 Push 2 ハードウェアインターフェース | 延期。Live の ControlSurface LOM とは別のハードウェアサーフェス。汎用 MIDI ノート送信からサポートを主張しない |
| ControlSurface MIDI/SysEx グラブ、フィードバック、パラメータバンク、カスタムモード | 延期。ブリッジは Control Surface だが、意図的に文書化された LOM のみを使用。ハードウェアフィードバックのために生 MIDI ストリームを掴むことは Live 自身のコントロールサーフェス層を複製し、今日は範囲外 |

## Connection Kit 式統合(OSC/JSON/web/シリアル/Arduino)

現時点では製品範囲外として辞退。現在の境界は、ループバックのみ、
主にインバウンドの短命なリアルタイム承認プレーン。一般的な
アウトバウンド/インバウンド OSC、web API、シリアル、センサー統合は、
それぞれが独自のレビューを必要とする権限平面であり、サイレントに
追加されない。明示的な製品要件がある場合にのみ再検討する。

## 安定した公開 LOM が公開しない Live UI 機能

それぞれに明示的なディスポジション。Ableton が安定した公開 API を
提供しない場合、予約済みプロトコル操作はフェイルクローズして実際の
制限を報告します。ブリッジの欠陥ではありません。

| 機能 | ディスポジション |
|---|---|
| Arrangement オートメーションエンベロープ/ポイント作成 | 現在サポート外。`arrangement.automation.*` は予約済み・フェイルクローズのまま。Session クリップエンベロープは実装済み |
| 完全なコンプ領域選択とコンプ編集 | 公開 LOM でサポート外。既存テイクレーンのディスカバリ/名前変更とファイルオーディオインポートは公開されるが、マッパー専用のレーン作成/MIDI レーンクリップ経路は公開 MCP スキーマで通知されない |
| テイクレーン削除/オーディション/コンプセマンティクス | 公開 LOM でサポート外。これらについて公開 MCP ケイパビリティは主張しない |
| フリーズとフラット化 | 公開 API なし。UI オートメーションなし |
| オフラインバウンス、ステム、オーディオ/ビデオ書き出し、レンダーステータス | 公開 Remote Script API なし。`project.bounce/export/collect` は予約済み・フェイルクローズのまま |
| プロジェクト新規/開く/保存/別名保存/閉じる、Collect All and Save | 公開 API なし。これらの制限は capability リソースで報告され、呼び出し可能なプレースホルダーツールは存在しない |
| ステム分離 | 公開 API なし |
| 完全な Arrangement 分割/統合/カット/コピー/タイムペースト | 公開 API なし |
| Follow Action 作成 | Live API で公開されていない |
| クロスフェード/フェードカーブ編集 | 公開 API なし |
| 完全な MPE ノートごと表現ドキュメント編集 | 権威ある API なし。主張しない(probability/velocity/deviation/release-velocity/mute がネゴシエートされたノートフィールドのまま) |
| RoarDevice、ShifterDevice、SpectralResonatorDevice、WavetableDevice のセマンティックサーフェス | 延期、主張しない。汎用 DeviceParameter 制御は引き続き利用可能。正確に取得した Live 形状が揃った場合にのみ専用ファミリーを提供 |
| Sample サーフェス(クリップ行を超えるスライス/warp/サンプルメタデータ) | 延期、主張しない |
| Simpler の残りのサーフェス(エンベロープ、フィルター、LFO、再生モード) | 延期、主張しない。ケイパビリティゲート付きの `Simpler.replace_sample` のみが出荷された Simpler セマンティック |
| Browser タグ、類似検索、Pack インストール/更新、Cloud/Splice 管理 | 公開 API なし。`live_browser_search` は明示的に有界な名前マッチであり、`live_browser_roots` は存在を偽装せずバインディング階層を報告 |
| 環境設定、オーディオドライバー/バッファ設定、MIDI ポート設定 | 公開 API なし。アプリケーションレベルの設定はオペレーター所有のまま |
| 公開パラメータ、プリセット、エディター可視性を超えた任意のプラグイン不透明状態や GUI コントロール | 公開 API なし。プラグインパラメータ、プリセット、`is_editor_open` が型付き境界 |
| ビデオトラックインポート/エクスポート制御 | 公開 API なし |
| Set ロード間で安定したオブジェクト識別子 | ブリッジはエポックでライブセッションにアイデンティティをバインド。クロスロード永続性は主張しない |
| LOM 経由の任意の生トラックオーディオ | 公開 API なし。必要になれば承認済み Max デバイスまたは Link Audio が文書化された代替。同意バインドの Session Resampling キャプチャが今日唯一のキャプチャ経路のまま |
