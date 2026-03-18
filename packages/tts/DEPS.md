# tts/ 依存関係（自動生成）

> commit 時に自動再生成。手動編集禁止。

## ファイル依存関係図

```mermaid
graph LR
  emotion_to_tts_style_mapper["emotion-to-tts-style-mapper"]
  index --> emotion_to_tts_style_mapper["emotion-to-tts-style-mapper"]
  index --> style_bert_vits2_synthesizer["style-bert-vits2-synthesizer"]
  style_bert_vits2_synthesizer["style-bert-vits2-synthesizer"]
```

## ファイル別依存一覧

### emotion-to-tts-style-mapper.ts

- 他モジュール依存: shared

### index.ts

- モジュール内依存: emotion-to-tts-style-mapper, style-bert-vits2-synthesizer

### style-bert-vits2-synthesizer.ts

- 他モジュール依存: shared
