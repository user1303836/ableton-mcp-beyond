# ケイパビリティおよびエビデンスマトリクス

[English](../en/CAPABILITY_MATRIX.md) · [简体中文](../zh-CN/CAPABILITY_MATRIX.md) · 日本語

このマトリクスは、指定されたプラットフォームドメインとノーススター
ジャーニーのバージョン管理された信頼できる情報源です。「実装済み」は
「すべての外部環境で証明済み」を意味しません。エビデンスの範囲は明示的です:

- **unit/property/simulator** —— 決定論的リポジトリ契約のみ
- **packaged fake-Live** —— インストール済み tarball、認証済みクロスプロセス
  ブリッジ、意図的な偽 Live 出所
- **real-Live** —— 指定された使い捨て Live 環境での認証済み Remote Script 観測
- **host matrix** —— Node/パッケージ/ライフサイクル動作。Windows Live では
  ありません

安全クラス: **R** 読み取り専用。**G** リビジョン/エポック bound の
プレビュー-確認-検証変更。**A** 出力/録音ゲートと独立停止を伴う可聴または
録音。**RT** 短期リアルタイム権限。**FS** オーナー/許可リスト bound の
ファイルシステム変更。**P** 同意/プライバシー敏感なオーディオ。**D**
デリバリーおよびインストール権限。

## 基盤およびコントロールドメイン

| ドメイン | 公開 API / 正規操作 | 実装と安全性 | 主要テスト | プラットフォーム / 本番エビデンス | ドキュメントとネゴシエートされた制限 |
|---|---|---|---|---|---|
| MCP トランスポートとホスト | initialize、tools/resources/prompts、stdio JSON-RPC | `host.ts`、`stdio.ts`、`framing.ts`;R/G;有界フレーム、作業、レート、キャンセル、順序 | `host.test.ts`、`stdio.test.ts`、`framing.test.ts`、プロパティ/ベンチマーク | Node 22/24/25 ホストマトリクス設定済み。パッケージ fake-Live ジャーニー。正確な SHA 結果が必要 | `DEVELOPER_GUIDE.md`、`OPERATIONS.md`。汎用変更ツールなし |
| 正規 Live 契約 | `ableton-live/v1`、操作レジストリ、マニフェスト/ハッシュ | `registry.ts`、`live.ts`、Python マッパー;R/G/A/RT;厳密なスキーマと 1 つの正規ダイジェスト | `registry.test.ts`、Python 契約テスト、パッケージ/候補検証 | 過去の macOS 実 Live ネゴシエーションは旧レジストリダイジェストを使用。現在のダイジェストの正確な候補証明が必要 | `DEVELOPER_GUIDE.md`、`LIVE_SAFETY.md`。サポート外の形状は利用不可のまま |
| 認証済みブリッジ | status/snapshot/discover/get と用途別操作 | `remote-adapter.ts`、Python リスナー;ループバックチャレンジ、HMAC、エポック/シーケンス/デッドラインフェンス | `registry.test.ts`、`live.test.ts`、パッケージジャーニー | パッケージ fake-Live と macOS 実 Live | `OPERATIONS.md`、`RECOVERY.md`。リモートネットワークモードなし |
| 参照、ディスカバリ、選択 | set、track/return/main、scene、slot、clip、note、locator、device、parameter、routing、playback、selection | レジストリ + マッパー走査;R;親スコープ参照/カーソル/リビジョン;選択は正規の参照解除可能な track/scene/slot 参照を再利用 | registry、host、Python テスト | `phase-3-readonly-live-discovery.json` 以降の実 Live フェーズエビデンス | `USER_GUIDE.md`。古い参照/エポックは拒否 |
| トランスポート、ループ、メトロノーム、パンチ、カウントイン | `transport.set`、トランスポート preview/apply/undo | ホストトランザクション + マッパー;再生が変わりうる場合は G/A | host/Python/パッケージジャーニー | `phase-5a-transport-clip-live.txt`(macOS 実 Live) | `LIVE_SAFETY.md`。新鮮な再生/録音状態が必要 |
| Session オーディションと緊急停止 | `session.audition-launch/stop`、`session.emergency-stop`、再生ディスカバリ | 専用ホスト/マッパートランザクション;A;予測不可能トークン、正確なターゲット、リプレイ、所有停止 | host、Python、パッケージジャーニー | `phase-4-guarded-audition.json` と外部保持の正確な候補読み取り専用ステータス | `LIVE_SAFETY.md`、`RECOVERY.md`。外部再生は所有と主張されない |
| Session 構造 | track/scene 作成/削除/リネーム、clip/device/locator リネーム。slot と Session clip ディスカバリ | preview/apply/undo マネージャー + マッパー;G;挿入インデックスは変更前に通常トラックとシーンに対して有界チェック | host/Python/パッケージジャーニー | 実 Live フェーズ 5 エビデンス。パッケージ fake-Live | `USER_GUIDE.md`。作成は return/main トラックを通常トラック挿入位置として扱わない。group/return/main 編集は正規操作が存在する場合のみ公開 |
| Session MIDI クリップとノート | `clip.create/delete`、単一ノート `note.add`、アトミック `note.add-batch`、`note.update/delete`、Session MIDI preview/apply/undo | `session-midi.ts`、host、マッパー;G;安定ノート ID、クリップ作成ごとに 1 回の有界ネイティブバッチ、補償 | `session-midi.test.ts`、host/Python/パッケージジャーニー | 過去の実 Live フェーズは当時の基本ライフサイクルをカバー。現在の契約と表現ライフサイクルはパッケージ fake-Live で、正確な候補の実 Live 証明待ち | `USER_GUIDE.md`。ピッチ、ベロシティ、チャンネル、長さ、確率、偏差、リリースベロシティ、ミュートはネゴシエートされる |
| 高度な MIDI / MPE | 確率、ベロシティ偏差、リリースベロシティ、ミュート(公開されている場合) | ノートスキーマとマッパー;G | registry/host/Python ジャーニーテスト | 表現フィールドはパッケージ fake-Live のみで証明。現在の候補の実 Live 証明は保留中。ノートごとの MPE プレッシャー/スライド/チューニングは利用不可 | `USER_GUIDE.md`。拡張ポイントは正規ノートスキーマ + ネゴシエート済みマッパー操作。捏造されたフィールドはなし |
| Session キャプチャ | `session.capture-midi`、`scene.capture` | ホスト preview/apply/冪等/ガード付きアンドゥトランザクション + マッパープリフライト、不変オブジェクト ID 削除フェンス、新鮮なリビジョン/読み戻し;G/A | host/Python/パッケージジャーニー | 実 Live フェーズ 5 エビデンス | `LIVE_SAFETY.md`。キャプチャ結果は新たに発見可能でなければならない。MIDI キャプチャはすべての Session スロットが空の場合にのみ通知され、ネイティブ失敗クリーンアップが既存クリップ内容を変更できない |
| Arrangement ナビゲーションとクリップ | arrangement ディスカバリ;clip 作成/複製/移動;トランザクション所有クリーンアップ;locator 追加/削除 | ホストトランザクションマネージャー + マッパー;G | host/Python/パッケージジャーニー | `phase-5cd-clip-arrangement-live.txt` と現在のテスト | `USER_GUIDE.md`。恣意 Arrangement 削除は拒否。正確な作成 ID+フィンガープリントクリーンアップは作成/複製のみに適用。移動はソース/デスティネーション内容をフェンスし、正確な逆移動回復を使用。削除権限を発行せず、トランザクション作成ソースの以前のクリーンアップトークンを消費 |
| オーディオクリッププロパティ | `audio.clip.set` でフィールドネゴシエートされたゲイン、ピッチ、ループ、ワープ有効/モード、フェード。有界ワープマーカー読み戻し | host/registry/マッパー;G;要求された各フィールドは正確なクリップの `availableAudioFields` に存在しなければならない | host、registry、Python fake-Live テスト | 実 Live フェーズ 5cd は MIDI ターゲットでの安全な拒否を証明し、成功したオーディオ編集ではない | `USER_GUIDE.md`。成功した現在候補の実 Live オーディオ編集とワープマーカー編集/テイクレーン/コンプ API は未証明または利用不可。マーカー読み戻しは編集権限を意味しない。予約済み正規 `audio.warp-marker.*`、`audio.take-lane.read`、`audio.comp.read` 契約は実行可能になるまで通知されない |
| オートメーション | クリップエンベロープとポイントの作成/読み取り/挿入/削除/復元 | host + マッパー;G、親/リビジョン bound | host/Python/パッケージジャーニー | `phase-5e-mixer-automation-live.txt` | `USER_GUIDE.md`。観測された API では Arrangement オートメーション/モジュレーションは利用不可。厳密な `arrangement.automation.*` 契約はレジストリテスト済みで、実行可能になるまで通知されない |
| ミキサー、センド、リターン、グループ、cue | 正確な行リビジョンでのミキサーディスカバリ/設定 | host + マッパー;G/A | host/Python/パッケージジャーニー | `phase-5e-mixer-automation-live.txt` | `LIVE_SAFETY.md`。発見された書き込み可能フィールドのみ変更。クリッピングは推測で除去されない |
| ルーティング、モニタリング、arm | ルーティング選択ディスカバリ、`routing.set` | host + マッパー;G/A;フィードバック拒否、正確なルート、arm/モニターフェンス | host/Python/パッケージジャーニー | `phase-6cd-routing-recording-live.txt` | `LIVE_SAFETY.md`。オペレーターが準備したキャプチャルーティングが必要 |
| Session/Arrangement 録音 | `recording.session`、`recording.arrangement` preview/apply/stop | host + マッパー;A;正確な以前の録音状態、armed デスティネーション、出力安全性権限がマッパーで原子的に再チェック。検証済み停止 | host/Python/パッケージジャーニー | `phase-6cd-routing-recording-live.txt` | `LIVE_SAFETY.md`、`RECOVERY.md`。無制限の録音コマンドなし |
| デバイス階層 | devices、racks、chains、drum pads、macros、parameters | 再帰的に平坦化された親スコープのネストデバイス/パラメータディスカバリ + デバイス/パラメータトランザクション;G/A | host/registry/Python/パッケージジャーニー | `phase-6ab-devices-browser-live.txt` | `USER_GUIDE.md`。マクロバリエーションとサイドチェーンフィールドは Live が公開する場合のみ報告 |
| デバイスライフサイクルとパラメータ | 挿入/有効化/移動、トランザクション所有クリーンアップ、有界公開パラメータ設定/アンドゥ | host + マッパー;G;変更は正確なデバイス、オーナー、トラック、兄弟順序、状態、作成フィンガープリント(該当する場合)にバインド | host/Python/パッケージジャーニー | `phase-6ab-devices-browser-live.txt` と現在のテスト | 恣意デバイス削除とプラグイン UI コントロールは未サポート。クリーンアップは正確なトランザクション作成デバイスに限定。挿入/ロードは空のデバイスオーナーに保守的に限定され、クリーンアップが無関係な兄弟に影響しない |
| プリセットとサードパーティプラグイン | 正確な Browser アイテム検査とデバイスのみのロード。ディスカバリ後の公開パラメータ | browser/device トランザクション;G;デバイス以外の結果は変更前に拒否。所有権/可用性はオペレーター事実 | journey/host/Python テスト | パッケージ fake-Live。macOS 実 Live でのネイティブ Browser ロード | 正確なサードパーティプリセットワークフローと UI オートメーションは未認証。拡張ポイントは発見された Browser ID + 公開パラメータ |
| Browser | 検索/フィルター/検査 + 正確なデバイスのみのロード | host + マッパー;R/G;ロード前に検査フェンスを再チェック | host/Python/パッケージジャーニー | `phase-6ab-devices-browser-live.txt` | 権威ある preview/stop API がない場合、Browser オーディオプレビュー/停止は利用不可。厳密な `browser.preview.start/stop` 契約は通知されない拡張ポイントとしてテスト |
| プロジェクトとファイル | プロジェクト情報、マニフェスト、欠落メディアメタデータ、検証済みコロケートバックアップ | `project.ts`;R/FS;呼び出し側許可ルート、`.als` コンテンツマーカー、有界ファイル、メディア読み取りなし、アトミックハッシュ検証コピー | `project.test.ts`、host/Python フェーズテスト | `phase-7a-project-ops-live.txt` | 正規 `project.new/open/save/save-as/collect/export/bounce` 拡張 ID は存在するが、アダプターが実行および検証できるまで通知されず呼び出し不可 |
| サブスクリプション/イベント | 生成される `transport`、`object`、`reset` イベントの認証済み subscribe/unsubscribe。有界イベントキュー | adapter/マッパー;R;署名付きエポック bound イベントはエポックを運ぶ。未配信の隣接結合は連続性を保持。実際のオーバーフローは reset イベントを発行 | loopback/Python/パッケージジャーニー | `phase-7b-subscriptions-live.txt` | 未サポートの状態/メーター/Max/OSC イベントフィルターはサイレントに受け入れられず拒否。エポック変更、reset、シーケンスギャップは再スナップショットが必要。イベントは変更権限ではない |
| UDP/OSC/XY/Max パケット互換リアルタイム | realtime arm/disarm/stats;有界 JSON、OSC、XY、`max` ラベルパケット入力 | マッパーリアルタイムプレーン;RT/A;トークン/TTL/ソース/チャンネル/レート/キュー/世代フェンス + すべての Live スレッドパケットで再チェックされる正確なパラメータ、オーナー、トラック、パス、兄弟 ID。正直な `ableton://max-extension` リソース | host/Python/パッケージジャーニー | `phase-7c-realtime-live.json` | ランタイムは OSC/realtime を通知し、`max` ケイパビリティではない。パケットラベルは拡張フォーマットのみ。バンドルされた Max デバイス、ハンドシェイク、`.amxd`、任意パケット権限は主張されない |
| 緊急回復 | Session 緊急停止、キャプチャ緊急停止/ステータス、リアルタイム disarm | 用途別独立権限;A/RT/P;Session 緊急停止はクリップ再生、トランスポート、両方の録音モードを原子的にクリア | host/Python/パッケージ/再起動テスト | 実 Live フェーズ 4、7c、8 | `RECOVERY.md`。不確定な変更は自動リプレイされない |

## オーディオインテリジェンスとプライバシー

| ドメイン | API / 実装 | 安全性 | テストとオラクル | 本番エビデンス | 制限 / ドキュメント |
|---|---|---|---|---|---|
| PCM 解析 | `audio_analyze`;`analysis.ts` と使い捨てワーカーランナー | P;有界入力/時間/メモリ/出力、キャンセル、シークレット除去ワーカー、結果に生 PCM なし | analysis、worker、property、benchmark テスト | パッケージローカル解析 | `AUDIO_INTELLIGENCE.md`。供給 PCM の関係は呼び出し側宣言 |
| 波形/スペクトル/時間-周波数/トランジェント/位相/ダイナミクス | `pcm-analysis/v2` 集約サマリー | P/R | 決定論的フィクスチャと境界 | パッケージジャーニー | 非可逆集約エビデンス。ソース再構成やマスタリング判定ではない |
| ラウドネス/LRA/トゥルーピーク | `audio-standards.ts`、BS.1770-5 / EBU R128/Tech 3341/3342 | P/R | `phase-8-audio-oracle.json` の独立した FFmpeg オラクル | パッケージ解析 | トゥルーピークは 44.1/48 kHz のみ検証。イマーシブ/オブジェクトレイアウトは利用不可 |
| リファレンス比較 | `audio_compare_reference`;有界リサンプル、アライメント、レベルマッチ | P/R | `reference-analysis.test.ts`、property/benchmark | パッケージリファレンスジャーニー | 32–96 kHz 入力。曖昧さはオーバーラップ、クロスソースデルタ、ゲイン助言を保留してフェイルクローズし、個別解析を保持。法的/ソース関係は推測されない |
| シグナルチェーン診断 | `diagnoseAudioWithLiveContext` | R/P;正確な参照、非因果言語 | diagnosis/host テスト | パッケージジャーニーとフェーズ 8 | 測定値はデバイスが差異を引き起こしたことを証明しない |
| Live オーディオキャプチャ | ガード付き Session Resampling 開始/ステータス/停止/クリーンアップ/緊急停止 | A/P;同意、ソース/デスティネーション ID、ウォッチドッグ、メディア ID/アンリンク、状態復元 | capture host/file/Python/パッケージ回復テスト | macOS Live 12.4.5b8 の `phase-8-audio-live.json` | ネイティブ PCM タップは主張されない。保存された Set、WAV、安全なルーティング、実 Live 出所が必要 |

## ノーススターユーザージャーニー

すべてのジャーニープランは、用途別ツールの上の読み取り専用コンポジション
レイヤーです。変更権限を付与しません。

| ジャーニー | ツール/リソース/プロンプトと実装 | 重要パス | パッケージエビデンス | 実 Live / プラットフォームステータス | 権利、アクセシビリティ、フォールバック |
|---|---|---|---|---|---|
| ビートまたはソング作成 | `plan_user_journey`、`ableton://journeys`、`create_beat_or_song`;`journeys.ts` | MIDI/構造/Arrangement/オーディションプレビューと正確な確認 | `phase-9-journeys-packaged.json` | ガード付きプリミティブは macOS 実 Live フェーズエビデンスあり。完全な構成ジャーニーはパッケージ fake-Live | 高レベル特性のみ。利用不可の Arrangement ステージは再計画/フォールバック |
| 高度なドラムのシーケンス | `sequence_advanced_drums` | Session MIDI 作成、表現改訂、オーディション、読み戻し | フェーズ 9 パッケージエビデンス | MIDI/オーディションプリミティブは macOS で観測 | キットマッピングは捏造されない。オペレーター所有/発見マッピングのみ |
| 所有/ネイティブサウンドデザイン | `design_owned_sound` | Browser ロード、発見パラメータシェイピング、オーディション/回復 | フェーズ 9 パッケージエビデンス | Browser/デバイスプリミティブは macOS で観測 | 所有権、プラグイン可用性、プリセット、アーティスト ID は捏造されない |
| リファレンスミックス比較 | `compare_reference_mix` | ローカル規格/リファレンス解析、オプションのガード付きキャプチャ/ミキサー仮説と復元 | フェーズ 9 パッケージエビデンス | キャプチャプリミティブは macOS で観測。ローカル解析はクロスプラットフォーム | 正確な複製/法的クリアランスの主張なし。生オーディオは保持されない |
| パフォーマンス/録音セットアップ診断 | `diagnose_performance_setup` | ルーティング/ミキサープレビュー、有界録音、オプションのリアルタイム、最終復元 | フェーズ 9 パッケージエビデンス | コンポーネントプリミティブは macOS で観測 | 権威ある API がない場合レイテンシは不明のまま。リアルタイム/キャプチャは実 Live が必要 |
| ジャーニー内の Session/Arrangement 編集 | create/song およびドラムプランのステージ | 既存の用途別クリップ/ロケーター/オートメーションツール | フェーズ 9 パッケージエビデンス | フェーズ 5–6 のコンポーネント実 Live エビデンス | 未サポートの Arrangement オートメーションとコンプワークフローは利用不可のまま |

## デリバリー、互換性、アクセシビリティ

| ドメイン | 実装 / 安全性 | テストとエビデンス | サポートステータス | 制限 / ドキュメント |
|---|---|---|---|---|
| リリース成果物 | 厳密な 77 パス npm tarball、リリースマニフェスト、ペイロードロール/ハッシュ、MIT ライセンス | `package:verify`、候補および Python バインダー、新規クローンバイト比較 | 正確な SHA ローカル tarball。npm 未公開 | `DELIVERY.md`。未署名・未公証 |
| インストール/アクティベーション | `ableton-mcp-lifecycle` レシート/ジャーナル/ロック;D/FS | ライフサイクルユニット + インストール済み候補マトリクス。アクティベーションは実 Live と無傷のレシート紐付けパッケージが必要 | macOS 15 と Windows Server 2025 ホスト契約は正確な SHA CI が条件 | Windows Live/Windows 11 アクティベーションは未認証。`DELIVERY.md` |
| アップグレード/修復/ロールバック/アンインストール | 正確な新しい成果物、隔離/保持クリーンアップ、正確な前世代、オーナー専用パージ | ライフサイクルユニット、候補 OS マトリクス(Windows ACL/ジャンクション/保持ファイルケースを含む) | ホストされた正確な SHA 結果まではホスト契約のみ | ネイティブインストーラーなし。オペレーターは Live を停止/再起動する必要がある |
| Node/OS 互換性 | Node 22/24/25;Ubuntu 24.04、macOS 15、Windows Server 2025 ワークフロー | 完全な Node テスト + 正確なインストール済み候補。Python 3.11 マッパー | 条件付き。現在のチェック結果を参照 | Linux は Live の主張なし。Windows 11 は Server から継承されない |
| キーボード操作 | サーバー stdio とライフサイクル CLI はキーボード/stdin のみ必要。順序付きテキストステータス | パッケージジャーニーと候補 CLI テスト | サーバー所有テキスト境界 | サードパーティクライアント、ターミナル、Live がフォーカス動作を所有 |
| スクリーンリーダー | サーバー所有の視覚 UI なし。セマンティックテキストと非カラーステータス | 契約チェックのみ。VoiceOver/Narrator インタラクションエビデンスではない | **未認証** | VoiceOver、Narrator、Live、プラグイン、MCP クライアントの動作は別のインタラクティブプラットフォームエビデンスが必要。`USER_JOURNEYS.md`、`SUPPORT_MATRIX.md` |
| 署名/公開 | 明示的な利用不可診断とポリシー | パッケージ/候補ポリシーアサーション | 現在のローカル tarball チャネルには適用されない | 承認された ID と別のチャネル決定が必要 |

## エビデンスの鮮度ルール

追跡されたフェーズエビデンスは、指定された過去のフェーズと環境を証明します。
後の成果物にサイレントに昇格されることはありません。最終的な準備にはさらに、
プッシュされたヘッドの CI 成果物メタデータ、正確な候補ホスト結果、同じ Git
SHA と成果物 SHA-256 を指定する外部保持の実 Live 観測が必要です。Windows
Server ホストエビデンスが Windows Live/Windows 11 セルを埋めることはありません。
