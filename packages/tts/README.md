# @vicissitude/tts

感情 TTS の公開契約は `EmotionToTtsStyleMapper` と `TtsSynthesizer` port で表す。

## Port 契約

- `EmotionToTtsStyleMapper.mapToStyle(emotion)` は VAD 感情値から `TtsStyleParams` を返す。
- `TtsStyleParams.style` はエンジン非依存の感情 style ラベル。
- `TtsStyleParams.styleWeight` は style 固有設定をどれだけ反映するかを表す `[0, 1]` の強度。
- `TtsStyleParams.speed` は話速倍率で、Aivis では `speedScale` として直接反映する。
- `TtsSynthesizer.synthesize(...)` は既存の graceful degradation 用に成功時 `TtsResult`、失敗時 `null` を返す。
- 失敗理由が必要な実装は `synthesizeWithReason(...)` を提供し、`TtsSynthesisOutcome` の `reason` で理由を返す。

## Aivis 設定

`AivisSpeechSynthesizer` は HTTP 副作用を `fetch` 注入で扱う。テストや別ランタイムでは `config.fetch` に互換関数を渡す。

```ts
new AivisSpeechSynthesizer({
	baseUrl: "http://localhost:10101",
	fetch,
	speakerId: 0,
	styleConfigs: {
		happy: {
			speakerId: 5,
			audioQuery: {
				pitchScale: 0.2,
				intonationScale: 1.4,
				volumeScale: 1.1,
			},
		},
	},
});
```

`styleConfigs[style].speakerId` は Aivis の speaker/style 選択に使う。speaker は離散値のため `styleWeight` で補間せず、style が選ばれた時点で適用する。

`styleConfigs[style].audioQuery` は Aivis の `audio_query` が返す数値パラメータへの目標値で、`styleWeight` により現在値から線形補間する。`styleWeight = 0` では style 固有値を反映せず、`styleWeight = 1` で設定値をそのまま使う。

## 失敗理由

`synthesizeWithReason` は以下の reason を返す。

- `audio_query_http_error`: `/audio_query` が 2xx 以外を返した。
- `audio_query_invalid_response`: `/audio_query` の JSON を解釈できない。
- `synthesis_http_error`: `/synthesis` が 2xx 以外を返した。
- `invalid_audio`: WAV として再生時間を算出できない。
- `aborted`: 呼び出し側 signal または timeout で中断された。
- `network_error`: fetch がネットワーク系エラーを投げた。
- `unexpected_error`: 上記以外の予期しない例外。

## Style 反映範囲

Aivis はエンジン側に任意 style の連続補間 API を持たないため、style 反映は best effort とする。

- speaker/style ID は style ラベル単位の離散選択。
- pitch / intonation / volume などの `audioQuery` 数値設定は `styleWeight` で補間。
- speed は `TtsStyleParams.speed` を常に優先。
- 未設定の style は default speaker と Aivis の `audio_query` 初期値を使う。
