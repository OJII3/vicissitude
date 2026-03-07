#!/bin/sh
# Ollama サーバーをバックグラウンドで起動
ollama serve &
# サーバー起動待ち
sleep 3
# モデルプル（既に存在する場合はスキップされる）
ollama pull "${OLLAMA_MODEL:-embeddinggemma}"
# フォアグラウンドで待機
wait
