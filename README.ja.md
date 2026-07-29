<p align="center">
  <img src="docs/assets/logo.svg" width="100" alt="Ableton MCP Beyond ロゴ" />
</p>

<h1 align="center">Ableton MCP Beyond</h1>

<p align="center">
  安全性第一の Ableton Live 12 MCP コントロール ——<br/>
  76 のツール、認証済みループバックブリッジ、規格準拠のオーディオ解析。
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · 日本語
</p>

<p align="center">
  <a href="https://github.com/user1303836/ableton-mcp-beyond/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://github.com/user1303836/ableton-mcp-beyond/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT ライセンス" /></a>
  <a href="apps/mcp-server/package.json"><img src="https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2025-339933?style=flat-square" alt="Node 22 | 24 | 25" /></a>
  <a href="https://modelcontextprotocol.io/specification/2025-11-25"><img src="https://img.shields.io/badge/MCP-2025--11--25-blue?style=flat-square" alt="MCP プロトコル 2025-11-25" /></a>
  <a href="docs/SUPPORT_MATRIX.md"><img src="https://img.shields.io/badge/Ableton%20Live-12-555555?style=flat-square" alt="Ableton Live 12" /></a>
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
完全な手順: [docs/USER_GUIDE.md](docs/USER_GUIDE.md)(英語)。

## 安全モデル

すべての変更は **検出 → プレビュー → 確認 → 適用 → 検証 → アンドゥ** の手順に従います。冪等キー、エポックフェンシング、実行台帳により、応答喪失時も安全に照合でき、恣意的な削除は拒否されます。明示的なブリッジ設定がない限り、サーバーはフェイルクローズド —— Live を読むことも触れることもありません。詳細: [docs/LIVE_SAFETY.md](docs/LIVE_SAFETY.md)(英語)。

## 互換性

| 環境 | ステータス |
|---|---|
| Node.js 22 / 24 / 25 | サポート(CI テスト済み) |
| macOS + Live 12 | 12.4.5b8 beta で検証済み([エビデンス](docs/evidence/)) |
| Windows ホスト | CI テスト済み。Windows 11 + Live は未認証 |
| Linux / Live 11 以前 | 非対応 |

ケイパビリティは接続時にネゴシエートされるため、エージェントは常にその Live 環境で何ができるかを正確に把握できます。完全なマトリクス: [docs/SUPPORT_MATRIX.md](docs/SUPPORT_MATRIX.md)(英語)。

## ドキュメント

以下のドキュメントはすべて英語です。

| ドキュメント | 内容 |
|---|---|
| [USER_GUIDE](docs/USER_GUIDE.md) | ツール一覧、変更ワークフロー、リソース、プロンプト |
| [LIVE_SAFETY](docs/LIVE_SAFETY.md) | 実機 Live の安全境界 |
| [OPERATIONS](docs/OPERATIONS.md) / [RECOVERY](docs/RECOVERY.md) | 運用監視、障害対応、不確定状態からの回復 |
| [AUDIO_INTELLIGENCE](docs/AUDIO_INTELLIGENCE.md) | DSP 規格、キャプチャ同意、プライバシー制限 |
| [USER_JOURNEYS](docs/USER_JOURNEYS.md) | 5 つのガイド付き作曲ワークフロー |
| [REALTIME_CONTROL](docs/REALTIME_CONTROL.md) | アームされた UDP/OSC/XY コントロールプレーン |
| [CAPABILITY_MATRIX](docs/CAPABILITY_MATRIX.md) | ツールごとのケイパビリティと操作要件 |
| [DELIVERY](docs/DELIVERY.md) | パッケージ成果物のインストール、アップグレード、ロールバック、アンインストール |
| [IMPLEMENTATION_STATUS](docs/IMPLEMENTATION_STATUS.md) | 検証済みの内容と現在の制限 |

## ライセンス

[MIT ライセンス](LICENSE.md)のオープンソースです。Ableton Live は Ableton AG の商標です。本プロジェクトは Ableton AG とは提携しておらず、認められたものでもありません。
