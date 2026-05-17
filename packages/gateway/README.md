# @vicissitude/gateway

Discord bot と Web クライアントの間に立つ WebSocket gateway です。

## 責務境界

- WebSocket 接続の登録、切断、受信メッセージのパース、送信、broadcast を扱う。
- HTTP/WS アプリの生成は `createGatewayApp`、listen 副作用は `listenGatewayServer` が扱う。
- avatar / TTS / mood の具象実装は持たず、`WsConnectionManagerDeps` の mapper / synthesizer / reader 経由で受け取る。
- 1 接続への送信失敗はログに記録し、その接続単位に隔離する。broadcast の残りの接続へは送信を継続する。

## プロトコル契約

- クライアント入力は `@vicissitude/shared/ws-protocol` の `ClientMessage` として解釈する。
- サーバー出力は `ServerMessage` を JSON 文字列化して送信する。
- パースできない入力には送信元へ `INVALID_MESSAGE` の `ErrorMessage` を返す。
- `chat_input` には `chat_message` と `emotion_update` を返し、TTS が設定されている場合のみ `audio_data` を追加送信する。
