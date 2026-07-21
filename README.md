# cc-review-gate

Claude Code がターンを終えようとした瞬間に、別プロセスの Claude に直前の変更をレビューさせるフックです。
問題が見つかれば停止をブロックし、指摘をそのまま本体に差し戻して修正を続けさせます。

人間がレビューを頼み忘れても、コードを書いたセッションは必ず一度レビューを通ってから止まります。

```
あなた「この関数を直して」
  → Claude が編集して終了しようとする
  → [Stop フック] 変更を検出 → レビュア Claude が起動 → 診断
  → BLOCK なら Claude は止まらず、指摘を読んで自分で直す
  → ALLOW ならそのまま終了
```

## 必要なもの

- Claude Code（`claude` コマンドが PATH にあること）
- Node.js 18 以上
- macOS または Linux

Claude Code 2.1.216 で動作確認しています。
レビュアの起動に `--effort` や `--tools` を使うため、これより古い版では動かない可能性があります。

## インストール

```bash
git clone https://github.com/tnkshuuhei/cc-review-gate.git
cd cc-review-gate
node install.mjs
```

インストーラがやることは 4 つです。

1. `hooks/review-gate/` を `~/.claude/hooks/review-gate/` にコピーする
2. `commands/gate.md` を `~/.claude/commands/gate.md` にコピーする（`/gate` コマンドが使えるようになる）
3. `~/.claude/review-gate/config.json` を作る（既にあれば触らない）
4. `~/.claude/settings.json` の Stop フックに 1 行追加する

`settings.json` は書き換える前に `settings.json.bak-<日時>` としてバックアップを取ります。
既存の Stop フック（通知など）は消しません。
同じフックが登録済みなら何もしないので、何度実行しても壊れません。

書き込む前に内容を確認したい場合は `--dry-run` を付けます。

```bash
node install.mjs --dry-run
```

インストール後、起動中の Claude Code があれば再起動してください。
`settings.json` は起動時に読まれます。

### 手動で入れる場合

インストーラを使わず自分で配置しても構いません。

```bash
cp -R hooks/review-gate ~/.claude/hooks/
cp commands/gate.md ~/.claude/commands/
```

そのうえで `~/.claude/settings.json` に次を足します。

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$HOME/.claude/hooks/review-gate/stop-gate.mjs\"",
            "timeout": 900
          }
        ]
      }
    ]
  }
}
```

`timeout` はフック全体の上限（秒）です。
レビュア側のタイムアウト（既定 600 秒）より長くしておきます。

## 動作確認

Claude Code を起動して `/gate` と打つと、現在の状態が出ます。

```
review-gate: ON / このディレクトリ: 有効
  model=opus effort=high timeout=600s
  maxBlocksPerTurn=2
  ...
```

適当なリポジトリで何かコードを書かせてみてください。
Claude が終了しようとしたところで、レビュアが動く数十秒の間があります。
指摘が出た場合は、Claude が止まらずに修正を始めます。

判定の履歴は次で見られます。

```
/gate log
```

```
2026-07-21T12:32:03.366Z [block] $0.184 47s レビューゲートが問題を検出しました: ...
2026-07-21T12:40:11.902Z [allow] $0.092 31s ALLOW: 変更は既存の呼び出し側と整合している
```

## 使い方

`/gate` に続けてサブコマンドを渡します（`node ~/.claude/hooks/review-gate/gate.mjs <サブコマンド>` と同じです）。

| コマンド | 動作 |
| --- | --- |
| `/gate` | 状態と設定を表示する |
| `/gate off` | ゲートを止める |
| `/gate on` | ゲートを動かす |
| `/gate here-off` | いま開いているディレクトリ配下だけ除外する |
| `/gate here-on` | その除外を解除する |
| `/gate log 50` | 直近 50 件の判定履歴を表示する |
| `/gate set model sonnet` | 設定値を書き換える |

## 設定

`~/.claude/review-gate/config.json` を直接編集するか、`/gate set <キー> <値>` で書き換えます。

| キー | 既定値 | 意味 |
| --- | --- | --- |
| `enabled` | `true` | ゲート全体の ON/OFF |
| `model` | `opus` | レビュアのモデル |
| `effort` | `high` | レビュアの思考量 |
| `timeoutSeconds` | `600` | レビュアの制限時間。超えたら通す |
| `maxBlocksPerTurn` | `2` | 同じターンでブロックできる回数の上限 |
| `disabledPaths` | `[]` | ここに書いた絶対パス配下ではゲートを動かさない |
| `ignoreGlobs` | 下記 | このパターンだけの変更ならレビューしない |

`ignoreGlobs` の既定値は、ドキュメント（`**/*.md`, `**/*.mdx`, `**/*.txt`）、ロックファイル、scratchpad、一時ディレクトリです。
README を直しただけのターンでレビュアが起動しないようにするためのものです。

コストを抑えたい場合は、モデルを下げるのが一番効きます。

```
/gate set model sonnet
/gate set effort medium
```

## どういうときにレビュアが起動するか

毎ターン起動するわけではありません。
起動をスキップする条件が 4 つあります。

- 直前のターンでファイルを一つも編集していない（調査、質問、設定の確認だけのターン）
- 編集したのが `ignoreGlobs` にマッチするファイルだけ
- カレントディレクトリが `disabledPaths` 配下
- 同じターンで既に `maxBlocksPerTurn` 回ブロックしている

日常的な会話や調査では動かないため、常時 ON にしても体感はあまり変わりません。

編集されたファイルの検出には、Claude Code が transcript に残す `file-history-delta` の記録を使っています。
アシスタントの自己申告ではなく、実際に書き込まれたファイルの一覧です。

## 判定できないときは必ず通す

このゲートは全面的に fail-open で作ってあります。
レビュアが異常終了した、タイムアウトした、出力の形式が想定と違った、`claude` が見つからなかった。
どれも「通す」に倒れます。

ゲート自身の事故で作業が止まる方が、見落としより体験を壊すからです。
配布物としては特に、他人の環境で誤爆しても仕事が止まらないことを優先しています。

レビュアのプロンプトも同じ方向に倒してあります。
迷ったら ALLOW、ブロックするなら「このファイルのこの行が、この入力でこう壊れる」まで書く、という基準です。
誤検知で 1 往復を無駄にすると、人はゲートを切ってしまうからです。

## レビュアが見ているもの

レビュア Claude は読み取り専用で起動します。
渡してあるツールは `Read` / `Grep` / `Glob` と、読み取り系の git コマンド（`git diff`, `git status`, `git log`, `git show`, `git rev-parse`, `git blame`）だけです。
書き込み系のツールは最初から渡していないため、レビュアがコードを直すことはありません。

MCP サーバとスキルは切ってあります（起動時のトークンが 19.4k から 9.1k に減ります）。
ただし設定ソースは切っていないので、プロジェクトの `CLAUDE.md` は読まれます。
レビュアはプロジェクトの規範を知ったうえで判断します。

ブロックの基準は `hooks/review-gate/prompts/review.md` に書いてあります。

ブロックする対象は、具体的な失敗経路のあるバグ、握り潰されたエラー、セキュリティやデータ整合性のリスク、リポジトリの他の箇所との契約違反、明文化されたプロジェクト規則への違反、そして「やったと書いてあるのに実際にはやっていない」ケースです。

ブロックしない対象は、スタイル、命名、書式、好み、テストの不足、書き方が違うだけの正しいリファクタリング、失敗経路を特定できない推測、そのターンより前から存在していた問題です。

基準を変えたいときは `~/.claude/hooks/review-gate/prompts/review.md` を編集してください。
出力の 1 行目を `ALLOW:` か `BLOCK:` で始める契約だけは変えないでください。
判定はこの 1 行目だけを見ています。

指摘の言語も同じファイルの末尾で指定しています。
既定は日本語です。

## コスト

既定の設定（opus + effort high）で手元の 20 回分を集計した実測値は、1 回あたり中央値 0.28 ドル / 50 秒、最大で 1.04 ドル / 137 秒でした。
変更の規模に素直に比例します。

同じ期間のフック起動 70 回のうち、レビュアが実際に走ったのは 20 回です。
残りは編集のないターンや、ドキュメントだけの変更としてスキップされています。

実測値は `/gate log` に残るので、自分の使い方でいくらかかっているかはそこで確認できます。

## アンインストール

```bash
node uninstall.mjs
```

`settings.json` からフックの登録を外し（バックアップを取ってから）、フック本体と `/gate` コマンドを削除します。
設定とログ（`~/.claude/review-gate/`）は残ります。
まとめて消すなら `--purge` を付けてください。

一時的に止めたいだけなら、アンインストールせず `/gate off` で足ります。

## うまく動かないとき

**レビュアが起動しない**

`/gate` で `enabled` と、そのディレクトリが除外されていないかを確認します。
そのうえで `/gate log` を見てください。
スキップした理由（「直前ターンにコード変更なし」「変更が ignoreGlobs のみ」など）が記録されています。

**`claude 実行ファイルが見つからずレビューをスキップ` とログに出る**

フックはログインシェルを経由せずに起動するため、`claude` が PATH の標準的な場所にないと見つかりません。
`CLAUDE_REVIEW_GATE_BIN` にフルパスを設定してください。

```json
{
  "env": {
    "CLAUDE_REVIEW_GATE_BIN": "/Users/you/.local/bin/claude"
  }
}
```

**毎回ブロックされて終われない**

`maxBlocksPerTurn`（既定 2）で打ち切られるので、無限には続きません。
それでも煩わしければ、そのプロジェクトだけ `/gate here-off` で除外できます。

**設定を変えたのに反映されない**

`config.json` は毎回読み直すため、Claude Code の再起動は不要です。
再起動が要るのは `settings.json` を変えたときだけです。

## ファイル構成

```
hooks/review-gate/
  stop-gate.mjs        Stop フック本体。起動条件の判定とブロックの返却
  gate.mjs             /gate の実体。設定の読み書きとログ表示
  lib/config.mjs       設定・ブロック回数・ログの永続化
  lib/transcript.mjs   transcript を読んで直前ターンの変更ファイルを取り出す
  lib/reviewer.mjs     レビュア Claude の起動と判定のパース
  prompts/review.md    レビュアへの指示。ブロック基準はここ
commands/gate.md       /gate スラッシュコマンドの定義
install.mjs            インストーラ
uninstall.mjs          アンインストーラ
```

外部依存はありません。
Node.js の標準モジュールだけで動きます。

## 実装上の注意点

レビュアも `claude` なので、そのプロセスが終了するとまた Stop フックが走ります。
放置すると無限に入れ子になるため、レビュアの起動時に `CLAUDE_REVIEW_GATE_ACTIVE=1` を渡し、フックの先頭でこれを見て即座に抜けています。

同じターンを何度もブロックし続けると往復が終わらないため、`session_id` とターン境界の uuid をキーにしてブロック回数を数え、上限で打ち切っています。
記録は `~/.claude/review-gate/state.json` に直近 100 件だけ残ります。

## ライセンス

MIT
