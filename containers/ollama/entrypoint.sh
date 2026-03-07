#!/bin/sh
set -e

# Ollama サーバーをバックグラウンドで起動
ollama serve &
SERVE_PID=$!

# サーバー起動をポーリングで待機（最大 60 秒）
echo "Waiting for Ollama server to be ready..."
for i in $(seq 1 60); do
  if ollama list > /dev/null 2>&1; then
    echo "Ollama server is ready"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "ERROR: Ollama server failed to start within 60 seconds" >&2
    exit 1
  fi
  sleep 1
done

# モデルプル（既に存在する場合はスキップされる）
MODEL="${LTM_EMBEDDING_MODEL:-embeddinggemma}"
echo "Pulling model: ${MODEL}"
ollama pull "$MODEL"

# フォアグラウンドで待機
wait $SERVE_PID
