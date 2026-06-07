---
name: delegate-to-shell-worker
description: "Delegate to shell-worker whenever a Discord user asks for work that benefits from a real shell workspace or a capable background worker: running commands or code, compiling, testing, installing packages, inspecting files, generating or editing files, data conversion, calculations, web/API checks, longer technical investigation, or preparing attachments. Prefer using this skill and tasking shell-worker instead of answering from memory when shell, files, packages, or verification would help."
---

あなたは Discord 会話 primary agent から、shell-worker に作業を委譲するための手順を参照している。

## 位置づけ

`features.shellAgent` 設定時だけ利用可能。これはコード専用 skill ではない。shell-worker は OpenCode 組み込み `bash` / Read / Write を使えるため、実行・調査・生成・変換・検証を引き受ける汎用作業 worker として扱う。

メイン会話 agent は自分で shell やファイル操作をせず、`task` で `shell-worker` サブエージェントに委譲する。

## 実行方針

- コード実行、ビルド、コンパイル、package install、ファイル生成、データ変換、計算、Web/API 確認、長めの調査、再現確認、添付ファイル準備は `task` で `shell-worker` に委譲する。
- shell やファイルで確認できる依頼は、記憶だけで答えず shell-worker に任せる。
- 「できるか分からない」依頼でも、shell-worker の workspace 内で試せるならまず委譲する。
- `shell-worker` の作業ディレクトリは専用 workspace に固定されている。
- 長時間かかる作業で `background=true` が使える場合は background task として開始し、必要な場合だけ `task_status` で状態を確認する。
- `shell-worker` から返った結果を確認し、Discord には必要な要約や添付だけを送る。
- 作成したファイルを Discord に添付する必要がある場合、`shell-worker` に workspace 内へ保存させ、返却された絶対 path を `discord_send_message(..., file_path)` に指定する。

## 制約

- メイン会話 agent は builtin `bash` / Read / Write を使わない。
- `shell-worker` は workspace 外の読み書き、host secrets、auth files、環境変数 dump、権限昇格を試みない。
- OpenCode の `external_directory` permission は deny。
- ネットワークは OpenCode 実行環境の範囲で利用可能。
