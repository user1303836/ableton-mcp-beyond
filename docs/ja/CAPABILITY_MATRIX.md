# ケイパビリティとエビデンスマトリクス

[English](../en/CAPABILITY_MATRIX.md) · [简体中文](../zh-CN/CAPABILITY_MATRIX.md) · 日本語

エージェントが Ableton Live でできることと、各主張のエビデンス範囲に関する
バージョン管理された最高の情報源。「実装済み」は「すべての外部環境で
証明済み」を意味しません。

## エージェントに何ができるか?

プロデューサー向けの平易な回答。すべての変更は読み取り専用プレビュー、
明示的な確認、正確な適用、検証済み読み戻しを経由します。ほとんどの
コンテンツ編集は `live_undo` で取り消せます。

| やりたいこと | ツール | 知っておくべきこと |
|---|---|---|
| MIDI またはオーディオトラックとシーンを作成 | `live_session_structure_preview/apply` | 挿入位置はレギュラートラックのみ。return/main トラックが挿入スロットとして扱われることはありません |
| リターントラックと複製 | `live_track_structure_preview/apply` | リターントラックの作成、トラック/シーンの複製。構造フェンスとガード付きクリーンアップ付き。リターントラックの削除は明示的で正直にアンドゥ不可 |
| トラックの健全性と状態を読む | `live_snapshot`、`live_discover` | グループ関係、可視性、選択メンバーシップ、フリーズ/フォールド状態、暗黙アーム、バックトゥアレンジャー、ソロ経由ミュート、全入出力メーター、パフォーマンス影響を全トラック行で公開 |
| パフォーマンスとレイテンシ診断 | `live_performance_read` | 有界なオンデマンドサンプル 1 回分: 平均/ピークプロセス使用率、トラックごとのメーターとパフォーマンス影響、サンプルとミリ秒でのデバイスレイテンシ。ポイントインタイムのエビデンス。メーターは Live UI メーターであり、デコード済みオーディオ解析ではない |
| 既存デバイスを削除 | `live_device_delete_preview/apply` | 正確なアイデンティティと兄弟フェンスで既存デバイスを明示的に削除。正直にアンドゥ不可 |
| トラックビューと楽器フォーカス | `live_track_view_preview/apply` | 折りたたみ状態とデバイス挿入モード(正確なアンドゥ付き)、Live のデバイスビューでの楽器選択(瞬時、アンドゥ不可) |
| Live の選択とビューを駆動 | `live_selection_preview/apply`、`live_clip_view_preview/apply`、`live_device_view_preview/apply`、`live_view_preview/apply` | Song.View 選択(トラック、シーン、ハイライトスロット、ディテールクリップ、デバイス、パラメータ、チェーン)、ドローモード、クリップグリッド量子化/トリプレット/エンベロープ可視と show-loop、デバイス折りたたみ(形状ゲート)、メインビュー切替/非表示/フォーカス、ズーム/スクロール、フォローソング、トラック折りたたみ、Browser モード切替 — 状態が回復可能な箇所はすべて正確に復元 |
| アプリケーションダイアログ | `live_application_dialog_preview/apply` | 現在のダイアログ状態を読み取り、プレビューした状態が正確に保持されている間だけダイアログボタンを 1 つ押下 — ダイアログボタンは破壊的な場合があり、状態が変わった瞬間に拒否 |
| MIDI クリップを作成してノートを書き込む | `live_midi_clip_preview/apply`、`live_note_update_preview/apply`、`live_note_delete_preview/apply` | 完全な表現フィールド: velocity、channel、probability、velocity deviation、release velocity、mute。安定したノート ID。クリップごとに 1 回の不可分バッチ |
| デバイスとプラグインのパラメータを変更 | `live_device_parameter_preview/apply` | 権威ある境界を持つ公開数値パラメータが対象。書き込み後に検証。ガード付きアンドゥ付き |
| インストゥルメント、エフェクト、プリセットをロード | `live_browser_search`、`live_browser_load_preview/apply` | 正確な Browser アイテムを選択したトラックにロード。プラグインは Live 自身の Browser に表示されている必要があります |
| デバイスを挿入、有効化、移動、削除 | `live_device_preview/apply`、`live_device_delete_preview/apply` | 削除はトランザクション自身が作成したデバイスに限定(正確なクリーンアップ)。既存デバイスの明示的な削除はフェンス付きで正直にアンドゥ不可 |
| 高度なデバイスとパラメータ制御 | `live_device_advanced_preview/apply`、`live_device_parameter_preview/apply` | すべての行でパラメータメタデータ(デフォルト値、元の名前、状態、列挙項目、表示値)を公開。パラメータバンク(正確なアンドゥ付き)。オートメーション再有効化と A/B 比較保存(瞬時)。チェーンデバイス挿入(空チェーンガード)。`Song.move_device` によるクロストラック/チェーンデバイス移動(正確な逆移動アンドゥ付き)。バイパスは読み取り専用の `Device.is_active` から書き込み可能を推測せず、プローブ済みの Device On パラメータのみ使用 |
| 専用デバイス API | `live_device_specialized_preview/apply`、`live_looper_preview/apply`、`live_simpler_preview/apply` | Drift モジュレーションマトリックスリスト(行)、ピッチベンドレンジ、ボイス数/モード。Drum Cell セマンティックゲイン。Eq8 編集/グローバルモード、オーバーサンプリング、選択バンド。Hybrid Reverb IR カテゴリ/ファイル選択と attack/decay/size/time シェーピング。Meld エンジン、ユニゾン、モノ/ポリ、ポリフォニー。プラグインプリセット発見/選択とエディターウィンドウ状態(読み書き)。Looper トランスポートアクション(瞬時)と速度/ループ長/テンポ/固定録音長プロパティ(正確なアンドゥ)。Simpler サンプル置換はオーディオインポートと同等のファイル権限と逆置換アンドゥ付き。すべてデバイスクラスとメンバー存在で形状ネゴシエート |
| ミックス: ボリューム、パン、ミュート、ソロ、キュー、センド | `live_mixer_preview/apply` | 事前値を先にキャプチャするため、ミックスの変更を正確に取り消せます |
| 拡張ミキサーとクロスフェード | `live_mixer_extended_preview/apply` | トラックアクティベーター、クロスフェーダー、クロスフェード割り当て、パンニングモード、スプリットステレオ左右パンナー(正確なアンドゥ付き)。マスタートラックのセマンティックテンポパラメータはミキサー行で読み取り専用で公開。テンポ変更は従来どおりテンポワークフロー経由 |
| ラックチェーンミキサー | `live_chain_mixer_preview/apply` | チェーンのボリューム、パン、センド、チェーンアクティベーター(正確なアンドゥ付き) |
| チェーン、ドラムパッド、ラック | `live_chain_preview/apply`、`live_drum_pad_preview/apply`、`live_rack_preview/apply`、`live_rack_view_preview/apply` | チェーンカラー/オートカラー/ミュート/ソロ、ドラムチェーンのノートとチョークグループを行で公開。ドラムパッドのノート/ソロ(正確なアンドゥ付き)と明示的な全チェーン削除(アンドゥ不可)。ラックのリターンチェーン、マクロ状態、可視マクロ数、選択バリエーションを行で公開。マクロ追加/削除/ランダム化、チェーン挿入、パッドコピー、バリエーション保存/呼出/削除は瞬時アクション。ラックビューの選択チェーン/パッド、パッドスクロール、チェーンデバイス可視性は正確なアンドゥ付き |
| デバイスルーティングとサイドチェーン | `live_device_io_preview/apply`、`live_routing_preview/apply` | トラックルーティング(型付き、フィードバック拒否)は `live_routing_*` に、デバイスレベル IO タイプ/チャネルとコンプレッサーサイドチェーンソースは `live_device_io_*` に — 別々の型付きサーフェス。それぞれ形状ゲートで、状態がある箇所はアンドゥ可能 |
| Session クリップを起動・停止 | `live_clip_launch_preview/apply/stop` | 一度に 1 つの確認済み起動。マッパー所有の再生のみ停止 |
| シーンを安全にオーディション | `live_session_audition_preview/apply/stop`、`live_session_emergency_stop` | 出力セーフティの確認と、停止済み・非アーム・非モニターのベースラインが必要。独立した緊急停止が常に利用可能 |
| 再生の開始/停止、位置、ループ、メトロノーム、パンチ | `live_transport_preview/apply` | リビジョンフェンス付き。アンドゥ可能。カウントインは読み取り専用で報告 |
| テンポを変更 | `live_tempo_preview/apply` | 有界 BPM、事後条件検証付き |
| ロケーター操作と再生ヘッドのジャンプ | `live_arrangement_section_preview/apply`、`live_locator_jump_preview/apply` | ロケーターの作成/削除/名前変更。次/前のロケーター、または `CuePoint.jump` で正確なロケーターへ、再生ヘッドフェンス付きでジャンプ |
| タイムライン上でクリップを編成 | `live_arrangement_clip_preview/apply`、`live_clip_duplicate_preview/apply`、`live_clip_move_preview/apply` | クリップの作成、複製、移動。トランザクション作成クリップのクリーンアップは正確。任意の Arrangement 削除は拒否 |
| オーディオファイルを Arrangement にインポート | `live_arrangement_clip_preview/apply` に `kind: "audio"` | ファイルバックのオーディオクリップを選択したトラックの正確な位置に配置し、作成されたアイデンティティを検証 |
| オーディオファイルを Session スロットにインポート | `live_audio_import_preview/apply` | 明示的なファイル権限: 許可ルート、正規パス、サイズ/タイプチェック、SHA-256 と適用時再検証(anti-TOCTOU)、インポートしたクリップのガード付きクリーンアップ |
| テイクレーンを操作 | ディスカバリ、`live_object_rename`(kind `takeLane`)、`live_arrangement_clip_preview/apply`(`takeLaneRef`)、`live_audio_import_preview/apply`(`takeLaneRef`) | レーンとそのクリップの読み取り、レーン作成、レーン名変更、レーン内での MIDI またはファイルオーディオクリップ作成。公開 LOM にテイクレーン削除がないため、レーンとレーンクリップの作成は正直にアンドゥ不可。コンプ領域編集は公開 API がなく利用不可 |
| ワープマーカーを編集 | `live_warp_marker_preview/apply` | ビートタイムでマーカーを追加/移動/削除(サンプルタイムマッピングは Live が所有)。マーカーコレクションフェンス、正確なロールバック、ガード付きアンドゥ |
| クリップのクロップ、複製、スクラブ | `live_clip_action_preview/apply` | ループへのクロップ、ループ/リージョンの複製、スクラブ、再生位置の移動。コンテンツアクションは正直にアンドゥ不可と表示 |
| ノートのクオンタイズと複製 | `live_note_edit_preview/apply` | タイミングまたはピッチのクオンタイズ、安定ノート ID による対象複製。正確な事前コンテンツアンドゥ付き |
| チューニングとスケールを編集 | `live_tuning_preview/apply` | チューニングシステム名、ノート範囲、基準ピッチ、全 128 ノートチューニング、ルートノート、スケール名/モード/インターバル。長さ/範囲制約の検証と正確なロールバック。再生ピッチにグローバルに影響し、`live_undo` で正確に復元 |
| グルーヴプールを操作 | `live_groove_preview/apply`、`live_clip_properties_preview/apply`(`grooveRef`) | グローバルグルーヴ量とグルーヴごとの名前/base/クオンタイズ/ランダム/タイミング/ベロシティ編集(正確なアンドゥ付き)。クリッププロパティ経由でクリップのグルーヴを割り当て/クリア(クリップ行に `hasGroove` を公開)。公開 API に完全なグルーヴインポート/抽出ワークフローはなく、グルーヴはプールに既存である必要がある |
| シーンを編集して発火 | `live_scene_preview/apply`、`live_scene_fire_preview/apply` | シーンのカラー、テンポ(+有効化)、拍子の分子/分母/有効化を正確なアンドゥ付きで編集。シーン行は空/発火/発火ボタン状態を、クリップスロット行はカラー、停止ボタン、グループスロット、再生、レコードオンスタート状態を公開。直接発火(fire-as-selected)は独立した、フェンス付き、可聴、アンドゥ不可のアクション — ガード付きシーンオーディションが聴取チェックの安全な経路のまま |
| 深い Song と Link 状態を読む | `live_song_state` | 可視トラック、任命デバイス、ソング長/開始、拍子、スウィング、オーバーダブ/アレンジメントオーバーダブ、バックトゥアレンジャー、キャプチャ/アンドゥ/リドゥ可否、排他アーム/ソロ、カウントイン中、テンポフォロワー、オートメーション再有効化、Session 録音/オートメーション、Ableton Link 有効/スタートストップ同期 — ビート↔SMPTE とループ時間変換付き |
| トランスポートを駆動 | `live_transport_preview/apply`、`live_transport_action_preview/apply` | リビジョンフェンス付きの位置/ループ/メトロノーム/パンチ編集(アンドゥ可能)と瞬時アクション: 開始、続行、停止、選択再生、スクラブ、タップテンポ、ナッジ上下、オートメーション再有効化、Session 録音トリガー、Link ビートタイム強制(フェンス付き、可聴アクションはアンドゥ不可と表示。緊急停止は別のまま) |
| ID または選択でノートを読む | `live_note_read` | 読み取り専用の対象ノート読み取り。Live が公開する場合は現在の選択も |
| クリップの全エンベロープをクリア | `live_automation_preview/apply` に `clear-envelopes` | クリップ上の全エンベロープ(デバイス、ラック、ミキサーパラメータ)のカウント済み・プレゼンスフェンス付きクリア。正直にアンドゥ不可 |
| クリップのミュート、カラー、ループ | `live_clip_properties_preview/apply` | 任意のクリップのミュートとカラー。MIDI クリップのループ境界(オーディオループは `live_audio_clip_*`) |
| オーディオクリップのサウンドを編集: ゲイン、ピッチ、ワープ、フェード | `live_audio_clip_preview/apply` | 正確なクリップがアドバタイズするフィールドのみ書き込み。ワープモードとフェードを含む |
| クリップオートメーションを書く | `live_automation_preview/apply` | エンベロープ作成、ポイント挿入、範囲削除、エンベロープリビジョンフェンス付き |
| トラックのルーティング、アーム、モニター | `live_routing_preview/apply` | フィードバックルートは拒否。アームとモニタリングはフェンス付きで復元可能 |
| Session または Arrangement に録音 | `live_recording_preview/apply` | アーム済みデスティネーションと出力セーフティの再確認付きの有界開始/停止、検証済み停止 |
| トラック出力を解析用にキャプチャ | `live_audio_capture_preview/apply/status/emergency_stop` | 同意バインドの Session Resampling、ウォッチドッグ、クリーンアップ、ゼロ残留検証付き(実 Live のみ) |
| トラック、シーン、クリップ、デバイス、ロケーターの名前変更 | `live_object_rename_preview/apply` | すべての名前変更に正確なアイデンティティフェンス |
| 変更を取り消す | `live_undo` | 事前の状態が一致している間は正確に復元。他の変更があった場合は拒否 |
| オーディオを解析(ラウドネス、トゥルーピーク、スペクトル) | `audio_analyze`、`audio_compare_reference`、`audio_diagnose_live_context` | ITU-R BS.1770/EBU R128 規格、プライバシー保護、結果に生 PCM を含まない |
| ビューを切り替え、Arrangement ビューを制御 | `live_view_preview/apply` | Session/Arranger の切り替え、ズーム/スクロール、フォローソング、トラック折りたたみ。UI のみ、音楽状態には触れない |
| Browser を検索してアイテムを検査 | `live_browser_search` | 読み取り専用 |
| Set を読む: トラック、クリップ、デバイス、ルーティング、再生 | `live_snapshot`、`live_discover`、`live_status` | 読み取り専用。古い参照は推測せず拒否 |

## エビデンス範囲

- **unit/property/simulator** — 決定論的リポジトリ契約のみ。
- **packaged fake-Live** — インストール済み tarball、認証済みクロスプロセス
  ブリッジ、意図的に偽の Live 出所。
- **real-Live** — 指定された使い捨て Live 環境での認証済み Remote Script
  観測。
- **host matrix** — Node/パッケージ/ライフサイクル動作。Windows Live では
  ありません。

セーフティクラス: **R** 読み取り専用。**G** リビジョン/エポックバインドの
プレビュー-確認-検証ミューテーション。**A** 出力/録音ゲートと独立停止を
持つ可聴または録音。**RT** 短期のリアルタイム権限。**FS** オーナー/
許可リストバインドのファイルシステム変更。**P** 同意/プライバシー配慮
オーディオ。**D** デリバリーとインストール権限。

## 基盤とコントロールドメイン

| ドメイン | 公開 API / 正規操作 | 実装とセーフティ | 主要テスト | プラットフォーム/本番エビデンス | ドキュメントとネゴシエートされた制限 |
|---|---|---|---|---|---|
| MCP トランスポートとホスト | initialize、tools/resources/prompts、stdio JSON-RPC | `host.ts`、`stdio.ts`、`framing.ts`。R/G。有界フレーム、ワーク、レート、キャンセル、順序付け | `host.test.ts`、`stdio.test.ts`、`framing.test.ts`、プロパティ/ベンチマーク | Node 22/24/25 ホストマトリクスが設定済み。パッケージ fake-Live ジャーニー。正確な SHA 結果が必要 | `DEVELOPER_GUIDE.md`、`OPERATIONS.md`。汎用ミューテーションツールなし |
| 正規 Live 契約 | `ableton-live/v1`、操作レジストリ、マニフェスト/ハッシュ | `registry.ts`、`live.ts`、Python マッパー。R/G/A/RT。厳密スキーマと単一正規ダイジェスト | `registry.test.ts`、Python 契約テスト、パッケージ/候補検証 | 過去の macOS 実 Live ネゴシエーションは古いレジストリダイジェストを使用。現在のダイジェストでの正確な候補証明が必要 | `DEVELOPER_GUIDE.md`、`LIVE_SAFETY.md`。未サポートの形状は利用不可のまま |
| 認証ブリッジ | status/snapshot/discover/get と用途別操作 | `remote-adapter.ts`、Python リスナー。ループバックチャレンジ、HMAC、エポック/シーケンス/デッドラインフェンス | `registry.test.ts`、`live.test.ts`、パッケージジャーニー | パッケージ fake-Live と macOS 実 Live | `OPERATIONS.md`、`RECOVERY.md`。リモートネットワークモードなし |
| 参照、ディスカバリ、選択 | set、track/return/main、scene、slot、clip、note、locator、device、parameter、routing、playback、selection | レジストリ + マッパー走査。R。親スコープの参照/カーソル/リビジョン。選択は正規の参照可能な track/scene/slot 参照を再利用 | レジストリ、ホスト、Python テスト | `phase-3-readonly-live-discovery.json` と以降の実 Live フェーズエビデンス | `USER_GUIDE.md`。古い参照/エポックは拒否 |
| トランスポート、ループ、メトロノーム、パンチ | `transport.set`、transport preview/apply/undo | ホストトランザクション + マッパー。再生が変化しうる場合は G/A | ホスト/Python/パッケージジャーニー | `phase-5a-transport-clip-live.txt`(macOS 実 Live) | `LIVE_SAFETY.md`。新鮮な再生/録音状態が必要。`Song.count_in_duration` は公開 LOM で get/observe であり、報告のみで書き込まない |
| 再生ヘッドキューナビゲーション | `locator.jump` 次/前 | 再生ヘッドとロケーターのフェンス付きホスト preview/apply。G | ホストと Python テスト | パッケージ fake-Live とシミュレーター。現在の候補での実 Live 証明は保留中 | `USER_GUIDE.md`。絶対位置指定は `transport.set`。ナビゲーション自体にアンドゥは提供しない |
| Session オーディションと緊急停止 | `session.audition-launch/stop`、`session.emergency-stop`、再生ディスカバリ | 専用ホスト/マッパートランザクション。A。予測不可能トークン、正確なターゲット、リプレイ、所有停止 | ホスト、Python、パッケージジャーニー | `phase-4-guarded-audition.json` と外部保持の正確な候補読み取り専用ステータス | `LIVE_SAFETY.md`、`RECOVERY.md`。外部再生は所有として主張されない |
| Session 構造 | track/scene 作成/削除/名前変更と clip/device/locator 名前変更。スロットと Session クリップのディスカバリ | preview/apply/undo マネージャー + マッパー。G。挿入インデックスは変更前にレギュラートラックとシーンに対して有界チェック | ホスト/Python/パッケージジャーニー | 実 Live フェーズ 5 エビデンス。パッケージ fake-Live | `USER_GUIDE.md`。作成は return/main トラックをレギュラートラックの挿入位置として扱わない。group/return/main の編集は正規操作が存在する場合のみ公開 |
| Session MIDI クリップとノート | `clip.create/delete`、単一ノート `note.add`、不可分 `note.add-batch`、`note.update/delete`、Session MIDI preview/apply/undo | `session-midi.ts`、ホスト、マッパー。G。安定ノートアイデンティティ、クリップ作成ごとに 1 つの有界ネイティブバッチと補償 | `session-midi.test.ts`、ホスト/Python/パッケージジャーニー | 過去の実 Live フェーズは当時の基本ライフサイクルをカバー。現在の契約と表現ライフサイクルは正確な候補での実 Live 証明保留中のパッケージ fake-Live | `USER_GUIDE.md`。pitch、velocity、channel、duration、probability、deviation、release velocity、mute はネゴシエートされる |
| 高度な MIDI / MPE | 公開されている場合の probability、velocity deviation、release velocity、mute | ノートスキーマとマッパー。G | レジストリ/ホスト/Python ジャーニーテスト | 表現フィールドはパッケージ fake-Live のみで証明。現在の候補での実 Live 証明は保留中。ノートごとの MPE プレッシャー/スライド/チューニングは利用不可 | `USER_GUIDE.md`。拡張ポイントは正規ノートスキーマ + ネゴシエートされたマッパー操作。捏造フィールドはなし |
| Session キャプチャ | `session.capture-midi`、`scene.capture` | ホスト preview/apply/冪等/ガード付きアンドゥトランザクションとマッパープリフライト、不変オブジェクトアイデンティティ削除フェンス、新鮮なリビジョン/読み戻し。G/A | ホスト/Python/パッケージジャーニー | 実 Live フェーズ 5 エビデンス | `LIVE_SAFETY.md`。キャプチャ結果は新規にディスカバー可能であること。MIDI キャプチャはすべての Session スロットが空の場合のみアドバタイズされ、ネイティブの失敗クリーンアップが既存クリップ内容を変更しないようにする |
| Arrangement ナビゲーションとクリップ | arrangement ディスカバリ。クリップ作成/複製/移動。トランザクション所有クリーンアップ。ロケーター追加/削除/名前変更 | ホストトランザクションマネージャー + マッパー。G | ホスト/Python/パッケージジャーニー | `phase-5cd-clip-arrangement-live.txt` と現在のテスト | `USER_GUIDE.md`。任意の Arrangement 削除は拒否。正確な作成アイデンティティ+フィンガープリントクリーンアップは作成/複製のみに適用。移動はソース/デスティネーションコンテンツをフェンスし、正確な逆移動回復を使用。削除権限を生成せず、トランザクション作成ソースの事前クリーンアップトークンを消費 |
| Arrangement オーディオインポート | `arrangement.audio-clip.create`(ファイルパスから正確な位置へ) | トラック/コレクションフェンス付きホスト preview/apply + マッパー作成アイデンティティ。G。`live_undo` によるトランザクション所有クリーンアップ | ホストと Python テスト | パッケージ fake-Live とシミュレーター。現在の候補での実 Live 証明は保留中 | `USER_GUIDE.md`。パスはそのマシンで Live が読み取れる必要がある。配置はファイルパス、位置、作成アイデンティティで検証 |
| クリッププロパティ | ミュート、カラーインデックス、MIDI ループ有効/境界の `clip.set` | 権限/状態リビジョン、順序付きループ書き込み、正確なロールバックを持つホスト preview/apply + マッパー。G | ホストと Python テスト | パッケージ fake-Live とシミュレーター。現在の候補での実 Live 証明は保留中 | `USER_GUIDE.md`。オーディオクリップループは `audio.clip.set`。クリップが公開しないフィールドは捏造せず拒否 |
| オーディオクリッププロパティ | `audio.clip.set` のフィールドネゴシエートされたゲイン、ピッチ、ループ、ワープ有効/モード、フェード。有界ワープマーカー読み戻し | ホスト/レジストリ/マッパー。G。要求された各フィールドは正確なクリップの `availableAudioFields` に現れる必要がある | ホスト、レジストリ、Python fake-Live テスト | 実 Live フェーズ 5cd は MIDI ターゲットでの安全な拒否を証明。成功したオーディオ編集ではない | `USER_GUIDE.md`。現在の候補での実 Live オーディオ編集とワープマーカー編集/テイクレーン/コンプ API は未証明または利用不可。マーカー読み戻しは編集権限を意味しない。予約済み正規 `audio.warp-marker.*`、`audio.take-lane.read`、`audio.comp.read` 契約は実行可能になるまで非公開のまま |
| オートメーション | クリップエンベロープとポイントの作成/読み取り/挿入/削除/復元 | ホスト + マッパー。G、親/リビジョンバインド | ホスト/Python/パッケージジャーニー | `phase-5e-mixer-automation-live.txt` | `USER_GUIDE.md`。Arrangement オートメーション/モジュレーションは観測された API では利用不可。厳密な `arrangement.automation.*` 契約はレジストリテスト済みで、実行可能になるまで非公開のまま |
| ミキサー、センド、リターン、グループ、キュー | 正確な行リビジョンを持つミキサーディスカバリ/設定 | ホスト + マッパー。G/A | ホスト/Python/パッケージジャーニー | `phase-5e-mixer-automation-live.txt` | `LIVE_SAFETY.md`。ディスカバーされた書き込み可能フィールドのみ変更。クリッピングは推測で回避されない |
| ルーティング、モニタリング、アーム | ルーティング選択ディスカバリ、`routing.set` | ホスト + マッパー。G/A。フィードバック拒否、正確なルート、アーム/モニターフェンス | ホスト/Python/パッケージジャーニー | `phase-6cd-routing-recording-live.txt` | `LIVE_SAFETY.md`。オペレーターが準備したキャプチャルーティングが必要 |
| Session/Arrangement 録音 | `recording.session`、`recording.arrangement` preview/apply/stop | ホスト + マッパー。A。正確な事前録音状態、アーム済みデスティネーション、出力セーフティ権限がマッパー内で不可分に再確認。検証済み停止 | ホスト/Python/パッケージジャーニー | `phase-6cd-routing-recording-live.txt` | `LIVE_SAFETY.md`、`RECOVERY.md`。無制限の録音コマンドなし |
| デバイス階層 | デバイス、ラック、チェーン、ドラムパッド、マクロ、パラメータ | 再帰的にフラット化された親スコープのネストデバイス/パラメータディスカバリとデバイス/パラメータトランザクション。G/A | ホスト/レジストリ/Python/パッケージジャーニー | `phase-6ab-devices-browser-live.txt` | `USER_GUIDE.md`。マクロバリエーションとサイドチェーンフィールドは Live が公開する場合のみ報告 |
| デバイスライフサイクルとパラメータ | 挿入/有効化/移動、トランザクション所有クリーンアップ、有界公開パラメータ設定/アンドゥ | ホスト + マッパー。G。ミューテーションは正確なデバイス、オーナー、トラック、兄弟順序、状態、該当する場合は作成フィンガープリントをバインド | ホスト/Python/パッケージジャーニー | `phase-6ab-devices-browser-live.txt` と現在のテスト | 任意のデバイス削除とプラグイン UI コントロールは未サポート。クリーンアップは正確なトランザクション作成デバイスに限定。挿入/ロードはクリーンアップが無関係な兄弟に影響しないよう空のデバイスオーナーに保守的に限定 |
| プリセットとサードパーティプラグイン | 正確な Browser アイテム検査とデバイスのみのロード。ディスカバリ後の公開パラメータ | browser/device トランザクション。G。非デバイス結果は変更前に拒否。所有権/可用性はオペレーターの事実 | ジャーニー/ホスト/Python テスト | パッケージ fake-Live。macOS 実 Live でのネイティブ Browser ロード | 正確なサードパーティプリセットワークフローと UI オートメーションは未認証。拡張ポイントはディスカバーされた Browser アイデンティティ + 公開パラメータ |
| Browser | 検索/フィルター/検査と正確なデバイスのみのロード | ホスト + マッパー。R/G。検査フェンスはロード前に再確認 | ホスト/Python/パッケージジャーニー | `phase-6ab-devices-browser-live.txt` | Browser オーディオプレビュー/停止は権威あるプレビュー/停止 API が存在しない場合は利用不可。厳密な `browser.preview.start/stop` 契約は非公開の拡張ポイントとしてテスト |
| アプリケーションビュー | `view.set` メインビュー切り替え。`view.control` ズーム/スクロール/フォロー/トラック折りたたみ | 読み戻し確認付きホスト preview/apply + マッパー。G。UI のみ、音楽状態なし | ホストと Python テスト | シミュレーターと Python 契約。現在の候補での実 Live 証明は保留中 | `USER_GUIDE.md`。一時的な UI 状態はアンドゥ不可で、音楽ミューテーションのゲートにもならない |
| プロジェクトとファイル | プロジェクト情報、マニフェスト、欠落メディアメタデータ、検証済みコロケートバックアップ | `project.ts`。R/FS。呼び出し側許可ルート、`.als` コンテンツマーカー、有界ファイル、メディア読み取りなし、不可分ハッシュ検証コピー | `project.test.ts`、ホスト/Python フェーズテスト | `phase-7a-project-ops-live.txt` | 正規 `project.new/open/save/save-as/collect/export/bounce` 拡張 ID は存在するが、アダプターが実行・検証できるまで非公開かつ呼び出し不可のまま |
| サブスクリプション/イベント | 生成された `transport`、`object`、`reset` イベントの認証済みサブスクライブ/アンサブスクライブ。有界イベントキュー | アダプター/マッパー。R。署名済みエポックバインドイベントはエポックを保持。未配信の隣接コアレッシングは連続性を保持し、実際のオーバーフローは reset イベントを発行 | ループバック/Python/パッケージジャーニー | `phase-7b-subscriptions-live.txt` | 未サポートの state/meter/Max/OSC イベントフィルターはサイレントに受け入れられず拒否。エポック変更、reset、シーケンスギャップは再スナップショットが必要。イベントはミューテーション権限ではない |
| UDP/OSC/XY/Max パケット互換リアルタイム | realtime arm/disarm/stats。有界 JSON、OSC、XY、`max` ラベルパケット入力 | マッパーリアルタイムプレーン。RT/A。トークン/TTL/ソース/チャネル/レート/キュー/世代フェンスと、すべての Live スレッドパケットで再確認される正確なパラメータ、オーナー、トラック、パス、兄弟アイデンティティ。誠実な `ableton://max-extension` リソース | ホスト/Python/パッケージジャーニー | `phase-7c-realtime-live.json` | ランタイムは `max` ケイパビリティではなく OSC/realtime をアドバタイズ。パケットラベルは拡張フォーマットのみ。バンドルされた Max デバイス、ハンドシェイク、`.amxd`、任意パケット権限は主張されない |
| 緊急回復 | Session 緊急停止、キャプチャ緊急停止/ステータス、realtime disarm | 用途別の独立権限。A/RT/P。Session 緊急停止はクリップ再生、トランスポート、両方の録音モードを不可分にクリア | ホスト/Python/パッケージ/再起動テスト | 実 Live フェーズ 4、7c、8 | `RECOVERY.md`。不確実なミューテーションは自動リプレイされない |

## オーディオインテリジェンスとプライバシー

| ドメイン | API / 実装 | セーフティ | テストとオラクル | 本番エビデンス | 制限 / ドキュメント |
|---|---|---|---|---|---|
| PCM 解析 | `audio_analyze`。`analysis.ts` と使い捨てワーカーランナー | P。有界入力/時間/メモリ/出力、キャンセル、シークレット除去ワーカー、結果に生 PCM なし | 解析、ワーカー、プロパティ、ベンチマークテスト | パッケージローカル解析 | `AUDIO_INTELLIGENCE.md`。供給 PCM の関係は呼び出し側の宣言 |
| 波形/スペクトル/時間-周波数/トランジェント/位相/ダイナミクス | `pcm-analysis/v2` 集計サマリー | P/R | 決定論的フィクスチャと境界 | パッケージジャーニー | 損失のある集計エビデンス。ソース再構築やマスタリング判定ではない |
| ラウドネス/LRA/トゥルーピーク | `audio-standards.ts`、BS.1770-5 / EBU R128/Tech 3341/3342 | P/R | `phase-8-audio-oracle.json` の独立 FFmpeg オラクル | パッケージ解析 | トゥルーピークは 44.1/48 kHz のみ検証。イマーシブ/オブジェクトレイアウトは利用不可 |
| リファレンス比較 | `audio_compare_reference`。有界リサンプル、アライメント、レベルマッチ | P/R | `reference-analysis.test.ts`、プロパティ/ベンチマーク | パッケージリファレンスジャーニー | 32–96 kHz 入力。曖昧さはオーバーラップ、クロスソースデルタ、ゲインアドバイスを差し控えてフェイルクローズ。独立したソース解析は保持。法的/ソース関係は推測されない |
| シグナルチェーン診断 | `diagnoseAudioWithLiveContext` | R/P。正確な参照、非因果言語 | 診断/ホストテスト | パッケージジャーニーとフェーズ 8 | 測定はデバイスが差異を引き起こしたことを証明しない |
| Live オーディオキャプチャ | ガード付き Session Resampling の開始/ステータス/停止/クリーンアップ/緊急停止 | A/P。同意、ソース/デスティネーションアイデンティティ、ウォッチドッグ、メディアアイデンティティ/アンリンク、状態復元 | キャプチャホスト/ファイル/Python/パッケージ回復テスト | macOS Live 12.4.5b8 の `phase-8-audio-live.json` | ネイティブ PCM タップは主張されない。保存済み Set、WAV、安全なルーティング、実 Live 出所が必要 |

## ノーススターユーザージャーニー

すべてのジャーニープランは、用途別ツールの読み取り専用コンポジション
レイヤーです。ミューテーション権限は付与しません。

| ジャーニー | ツール/リソース/プロンプトと実装 | 重要なパス | パッケージエビデンス | 実 Live / プラットフォーム状態 | 権利、アクセシビリティ、フォールバック |
|---|---|---|---|---|---|
| ビートまたはソングを作成 | `plan_user_journey`、`ableton://journeys`、`create_beat_or_song`。`journeys.ts` | MIDI/構造/Arrangement/オーディションプレビューと正確な確認 | `phase-9-journeys-packaged.json` | ガード付きプリミティブは macOS 実 Live フェーズエビデンスあり。完全な構成ジャーニーはパッケージ fake-Live | 高レベル特性のみ。利用不可の Arrangement ステージは再計画/フォールバック |
| 高度なドラムをシーケンス | `sequence_advanced_drums` | Session MIDI 作成、表現リビジョン、オーディション、読み戻し | フェーズ 9 パッケージエビデンス | MIDI/オーディションプリミティブは macOS で観測 | キットマッピングは捏造されない。オペレーター所有/ディスカバーされたマッピングのみ |
| 所有/ネイティブサウンドをデザイン | `design_owned_sound` | Browser ロード、ディスカバーされたパラメータシェーピング、オーディション/回復 | フェーズ 9 パッケージエビデンス | Browser/デバイスプリミティブは macOS で観測 | 所有権、プラグイン可用性、プリセット、アーティストアイデンティティは捏造されない |
| リファレンスミックスを比較 | `compare_reference_mix` | ローカル規格/リファレンス解析、オプションのガード付きキャプチャ/ミキサー仮説と復元 | フェーズ 9 パッケージエビデンス | キャプチャプリミティブは macOS で観測。ローカル解析はクロスプラットフォーム | 正確な複製/法的クリアランスの主張なし。生オーディオは保持されない |
| パフォーマンス/録音セットアップを診断 | `diagnose_performance_setup` | ルーティング/ミキサープレビュー、有界録音、オプションのリアルタイム、最終復元 | フェーズ 9 パッケージエビデンス | コンポーネントプリミティブは macOS で観測 | 権威ある API がなければレイテンシは不明のまま。realtime/キャプチャは実 Live が必要 |
| ジャーニー内の Session/Arrangement 編集 | 作成/ソングとドラムプランのステージ | 既存の用途別クリップ/ロケーター/オートメーションツール | フェーズ 9 パッケージエビデンス | フェーズ 5–6 のコンポーネント実 Live エビデンス | 未サポートの Arrangement オートメーションとコンプワークフローは利用不可のまま |

## デリバリー、互換性、アクセシビリティ

| ドメイン | 実装 / セーフティ | テストとエビデンス | サポート状態 | 制限 / ドキュメント |
|---|---|---|---|---|
| リリース成果物 | 厳密な 77 パス MIT npm tarball、リリースマニフェスト、ペイロードロール/ハッシュ、ライセンスバイト等価性 | `package:verify`、候補と Python バインダー、新規クローンバイト比較 | 正確な SHA のローカル未公開 tarball のみ | `DELIVERY.md`。npm `private: true`、未署名、未公証、未公開 |
| インストール/アクティベーション | `ableton-mcp-lifecycle` レシート/ジャーナル/ロック。D/FS | ライフサイクルユニット + インストール済み候補マトリクス。アクティベーションは実 Live と無傷のレシート紐付けパッケージが必要 | macOS 15 と Windows Server 2025 ホスト契約は正確な SHA CI が条件 | Windows Live/Windows 11 アクティベーションは未認証。`DELIVERY.md` |
| アップグレード/修復/ロールバック/アンインストール | 正確な新規成果物、隔離/保持クリーンアップ、正確な前世代、オーナー専用パージ | ライフサイクルユニット、Windows ACL/ジャンクション/保持ファイルケースを含む候補 OS マトリクス | ホストされた正確な SHA 結果まではホスト契約のみ | ネイティブインストーラーなし。オペレーターは Live を停止/再起動する必要がある |
| Node/OS 互換性 | Node 22/24/25。Ubuntu 24.04、macOS 15、Windows Server 2025 ワークフロー | 完全な Node テストと正確なインストール済み候補。Python 3.11 マッパー | 条件付き。現在のチェック結果を参照 | Linux に Live の主張なし。Windows 11 は Server から継承されない |
| キーボード操作 | サーバー stdio とライフサイクル CLI はキーボード/stdin のみで操作可能。順序付きテキストステータス | パッケージジャーニーと候補 CLI テスト | サーバー所有のテキスト境界 | サードパーティクライアント、ターミナル、Live は独自のフォーカス動作を持つ |
| スクリーンリーダー | サーバー所有のビジュアル UI なし。セマンティックテキストと非カラーステータス | 契約チェックのみ。VoiceOver/Narrator インタラクションエビデンスではない | **未認証** | VoiceOver、Narrator、Live、プラグイン、MCP クライアントの動作には別のインタラクティブプラットフォームエビデンスが必要。`USER_JOURNEYS.md`、`SUPPORT_MATRIX.md` |
| 署名/公開 | 明示的な利用不可診断とポリシー | パッケージ/候補ポリシーアサーション | 現在のローカル未公開チャネルには適用外 | MIT の権利は独立。承認されたアイデンティティと別個の公開決定が必要 |

## エビデンス鮮度ルール

追跡されたフェーズエビデンスは、指定された過去のフェーズと環境を証明
します。後の成果物にサイレントに昇格されることはありません。最終的な
準備完了にはさらに、プッシュされたヘッドの CI 成果物メタデータ、正確な
候補ホスト結果、同じ Git SHA と成果物 SHA-256 を名指しする外部保持の
実 Live 観測が必要です。Windows Server ホストエビデンスが Windows
Live/Windows 11 のセルを埋めることはありません。

## 実行可能と予約済みレジストリ契約

正規レジストリには、マッパーが現在アドバタイズする数より多くの操作 ID
が含まれます。ネゴシエート済みの実行可能な操作のみが `live_status` /
`capabilities` の `operations.executable` に表示されます。残り
(`operations.reserved`)は厳密な契約であり、アダプターが実行・検証
できるまでフェイルクローズします。予約済み ID は動作するケイパビリティ
のエビデンスではありません。

| 予約済み操作 ID | ディスポジション |
|---|---|
| `audio.warp-marker.read/add/move/delete` | 実装済み(ワープマーカーファミリーはこのブランチで出荷)。スキーマはビートタイムでマーカーをアドレス — 整数 ID は捏造しない |
| `audio.take-lane.read`、`audio.comp.read` | テイクレーンのディスカバリ/作成/名前変更とレーンクリップ作成は実装済み。コンプ領域編集は制限されたまま(公開 API なし)のため、`audio.comp.read` は予約済みのまま |
| `arrangement.automation.*` | Arrangement オートメーション作成には安定した公開 API がない。予約済み・フェイルクローズのまま |
| `browser.preview.start/stop` | Browser プレビューは非公式 Python バインディングを使用。ディスポジションは Browser ファミリー作業で決定 |
| `project.new/open/save/save-as/collect/export/bounce` | 公開 Remote Script API なし。`live_project_save` / `live_project_open` は明示的な制限レポーターのまま |
| `session.discover` | 予約済みエイリアス。ディスカバリは `discover`/`snapshot`/`get` が提供 |
