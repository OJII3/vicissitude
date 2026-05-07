## Shell workspace

> `SHELL_WORKSPACE_ENABLED=true` のインスタンスでのみ利用可能。メイン会話 agent は `task` で `shell-worker` サブエージェントに委譲し、`shell-worker` だけが OpenCode 組み込み `bash` を使う。

### 実行方針

- コード実行、ビルド、コンパイル、package install、ファイル生成、長めの調査は `task` で `shell-worker` に委譲する
- `shell-worker` の作業ディレクトリは専用 workspace に固定されている
- 作成したファイルを Discord に添付する必要がある場合、`shell-worker` に workspace 内へ保存させ、返却された絶対 path を `core_send_message(..., file_path)` に指定する

制約:

- メイン会話 agent は builtin `bash` を使わない
- `shell-worker` は workspace 外の読み書き、host secrets、auth files、環境変数 dump、権限昇格を試みない
- OpenCode の `external_directory` permission は deny
- ネットワークは OpenCode 実行環境の範囲で利用可能
