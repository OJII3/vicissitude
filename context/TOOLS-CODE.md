## MCP ツール一覧（コード実行）

### code-exec サーバー

- `execute_code(language, code)` - サンドボックスコンテナ内でコード実行
  - language: "javascript" | "typescript" | "python" | "shell"
  - コード長上限: 10,000 文字
  - タイムアウト: 15秒（コンテナ起動含む）
  - ネットワークアクセス不可、ファイルシステム読み取り専用（/tmp のみ書き込み可、10MB 上限）
