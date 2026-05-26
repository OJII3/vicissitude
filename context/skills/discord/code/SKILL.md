---
name: code
description: "Use when a Discord user asks for code execution, builds, compilation, package installation, file generation, or longer technical investigation through the shell workspace."
---

あなたは Discord 会話 primary agent から shell workspace 作業を扱うための手順を参照している。

## Shell workspace

`features.shellWorkspace` 設定時だけ利用可能。メイン会話 agent は `task` で `shell-worker` サブエージェントに委譲し、`shell-worker` だけが OpenCode 組み込み `bash` / Read / Write を使う。

## 実行方針

- コード実行、ビルド、コンパイル、package install、ファイル生成、長めの調査は `task` で `shell-worker` に委譲する。
- `shell-worker` の作業ディレクトリは専用 workspace に固定されている。
- 長時間かかる作業で `background=true` が使える場合は background task として開始し、必要な場合だけ `task_status` で状態を確認する。
- `shell-worker` から返った結果を確認し、Discord には必要な要約や添付だけを送る。
- 作成したファイルを Discord に添付する必要がある場合、`shell-worker` に workspace 内へ保存させ、返却された絶対 path を `discord_send_message(..., file_path)` に指定する。

## 制約

- メイン会話 agent は builtin `bash` / Read / Write を使わない。
- `shell-worker` は workspace 外の読み書き、host secrets、auth files、環境変数 dump、権限昇格を試みない。
- OpenCode の `external_directory` permission は deny。
- ネットワークは OpenCode 実行環境の範囲で利用可能。
