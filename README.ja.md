<p align="center">
  <img src="docs/assets/logo.svg" width="100" alt="Ableton MCP Beyond ロゴ" />
</p>

<h1 align="center">Ableton MCP Beyond</h1>

<p align="center">
  安全性第一の Ableton Live 12 MCP コントロール ——<br/>
  能力認識済みの 156 のネゴシエート済みツール、認証済みループバックブリッジ、規格準拠のオーディオ解析。
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · 日本語
</p>

<p align="center">
  <a href="https://github.com/user1303836/ableton-mcp-beyond/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://github.com/user1303836/ableton-mcp-beyond/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT ライセンス" /></a>
  <a href="apps/mcp-server/package.json"><img src="https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2025-339933?style=flat-square" alt="Node 22 | 24 | 25" /></a>
  <a href="https://modelcontextprotocol.io/specification/2025-11-25"><img src="https://img.shields.io/badge/MCP-2025--11--25-blue?style=flat-square" alt="MCP プロトコル 2025-11-25" /></a>
  <a href="docs/en/SUPPORT_MATRIX.md"><img src="https://img.shields.io/badge/Ableton%20Live-12-555555?style=flat-square" alt="Ableton Live 12" /></a>
</p>

---

**決して推測で動かず、あなたの Set を壊さない MCP ホスト。**

- **ディープな Live 制御** —— トランスポート、Session + Arrangement、クリップ、MIDI ノート、ミキサー、オートメーション、ルーティング、録音、プロジェクト、サブスクリプション。
- **デバイスを使いこなす** —— rack/chain/pad/macro の再帰的ディスカバリ、ガード付きパラメータ編集、Browser の検索とロード。
- **オーディオインテリジェンス** —— ITU-R BS.1770-5 / EBU R128 ラウドネス、検証済みトゥルーピーク、リファレンスミックス比較。Live なしで動作。
- **同意ベースのキャプチャ** —— 1 つのクリップをリサンプリングし、内部で解析、すべての痕跡を削除。ウォッチドッグと緊急停止を内蔵。
- **リアルタイム制御** —— トークンで隔離された UDP/OSC/XY チャンネル。書き込み検証と独立した緊急停止付き。
- **ガイド付きジャーニー** —— `plan_user_journey` が「ローファイなビートを作って」を、順序立て・確認可能・ケイパビリティ対応のプランに変換。

## クイックスタート

Node.js 22 / 24 / 25 が必要です。ブリッジには Ableton Live 12 が必要ですが、ホスト・テスト・デモは Live なしで動きます。

```sh
cd apps/mcp-server
npm ci && npm run build
npm run demo      # 実際の MCP セッション。Live 不要
npm test          # フルテストスイート
```

MCP クライアントをサーバーに向け、Live を制御する場合はブリッジを設定して Remote Script をインストールします:

```sh
npm run setup -- --output /abs/path/client-config.json
npm run setup -- --output /abs/path/bridge-config.json \
  --bridge-host 127.0.0.1 --bridge-port 9000 \
  --secret-file /abs/path/bridge.secret
node dist/src/install-remote-script.js --destination '/abs/.../Remote Scripts/AbletonMcpBridge' --dry-run
```

Live を再起動し、検証します: `npm run diagnostics -- --config /abs/path/bridge-config.json`。
完全な手順: [docs/ja/USER_GUIDE.md](docs/ja/USER_GUIDE.md)。

## 安全モデル

すべての変更は **検出 → プレビュー → 確認 → 適用 → 検証 → アンドゥ** の手順に従います。冪等キー、エポックフェンシング、実行台帳により、応答喪失時も安全に照合でき、恣意的な削除は拒否されます。明示的なブリッジ設定がない限り、サーバーはフェイルクローズド —— Live を読むことも触れることもありません。詳細: [docs/ja/LIVE_SAFETY.md](docs/ja/LIVE_SAFETY.md)。

このデプロイメントは、オーナーが管理するローカル OS アカウントと MCP クライアントの承認ポリシーを信頼境界とします。サーバーの確認は、人間がモデルとは別経路で同意した証明ではありません。可聴操作、録音、ルーティング、キャプチャ、リアルタイム操作を自動承認しないでください。

## 互換性

| 環境 | ステータス |
|---|---|
| Node.js 22 / 24 / 25 | サポート対象。現在の正確な SHA のマトリクス成功が必要 |
| macOS + Live 12 | 12.4.5b8 beta での過去の実 Live エビデンス([エビデンス](docs/evidence/))。リリース前に最終候補での再実行が必要 |
| Windows ホスト | CI 契約を設定済み。現在の正確な SHA の結果が必要。Windows 11 + Live は未認証 |
| Linux / Live 11 以前 | 非対応 |

ケイパビリティは接続時にネゴシエートされるため、エージェントは常にその Live 環境で何ができるかを正確に把握できます。完全なマトリクス: [docs/ja/SUPPORT_MATRIX.md](docs/ja/SUPPORT_MATRIX.md) · [docs/ja/EXTENSION_SURFACES.md](docs/ja/EXTENSION_SURFACES.md)。

## ドキュメント


| ドキュメント | 内容 |
|---|---|
| [USER_GUIDE](docs/ja/USER_GUIDE.md) | ツール一覧、変更ワークフロー、リソース、プロンプト |
| [LIVE_SAFETY](docs/ja/LIVE_SAFETY.md) | 実機 Live の安全境界 |
| [OPERATIONS](docs/ja/OPERATIONS.md) / [RECOVERY](docs/ja/RECOVERY.md) | 運用監視、障害対応、不確定状態からの回復 |
| [AUDIO_INTELLIGENCE](docs/ja/AUDIO_INTELLIGENCE.md) | DSP 規格、キャプチャ同意、プライバシー制限 |
| [USER_JOURNEYS](docs/ja/USER_JOURNEYS.md) | 5 つのガイド付き作曲ワークフロー |
| [REALTIME_CONTROL](docs/ja/REALTIME_CONTROL.md) | アームされた UDP/OSC/XY コントロールプレーン |
| [CAPABILITY_MATRIX](docs/ja/CAPABILITY_MATRIX.md) | エージェントにできることの早見表と、ドメイン別のケイパビリティ/エビデンス詳細 |
| [EXTENSION_SURFACES](docs/ja/EXTENSION_SURFACES.md) | Max/Link/Push/Connection Kit の評価と非公開 UI 機能のディスポジション |
| [DELIVERY](docs/ja/DELIVERY.md) | パッケージ成果物のインストール、アップグレード、ロールバック、アンインストール |
| [DISTRIBUTION_POLICY](docs/ja/DISTRIBUTION_POLICY.md) | ローカル MIT 成果物、必須チェック、緊急手順 |
| [IMPLEMENTATION_STATUS](docs/ja/IMPLEMENTATION_STATUS.md) | 検証済みの内容と現在の制限 |

## ライセンス

[MIT ライセンス](LICENSE.md)のオープンソースです。パッケージの `private: true` と、ローカル・未公開・未署名・未公証の配布チャネルは誤公開を防ぐためのもので、MIT の権利を変更しません。Ableton Live は Ableton AG の商標です。MIT は Ableton の商標権、提携、承認、署名、認証を付与または意味するものではありません。
