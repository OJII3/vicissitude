# ltm/ 依存関係（自動生成）

> commit 時に自動再生成。手動編集禁止。

## ファイル依存関係図

```mermaid
graph LR
  composite_llm_adapter["composite-llm-adapter"] --> llm_port["llm-port"]
  composite_llm_adapter["composite-llm-adapter"] --> ltm_chat_adapter["ltm-chat-adapter"]
  composite_llm_adapter["composite-llm-adapter"] --> types
  consolidation --> episode
  consolidation --> llm_port["llm-port"]
  consolidation --> ltm_storage["ltm-storage"]
  consolidation --> semantic_fact["semantic-fact"]
  consolidation --> types
  consolidation --> utils
  conversation_recorder["conversation-recorder"] --> consolidation
  conversation_recorder["conversation-recorder"] --> llm_port["llm-port"]
  conversation_recorder["conversation-recorder"] --> ltm_storage["ltm-storage"]
  conversation_recorder["conversation-recorder"] --> segmenter
  episode --> types
  episodic --> episode
  episodic --> fsrs
  episodic --> ltm_storage["ltm-storage"]
  episodic --> types
  episodic --> utils
  fact_reader["fact-reader"] --> ltm_storage["ltm-storage"]
  fsrs --> types
  index --> consolidation
  index --> episode
  index --> episodic
  index --> fsrs
  index --> llm_port["llm-port"]
  index --> ltm_storage["ltm-storage"]
  index --> retrieval
  index --> segmenter
  index --> semantic_fact["semantic-fact"]
  index --> semantic_memory["semantic-memory"]
  index --> types
  llm_port["llm-port"] --> types
  ltm_chat_adapter["ltm-chat-adapter"] --> types
  ltm_storage["ltm-storage"] --> episode
  ltm_storage["ltm-storage"] --> fsrs
  ltm_storage["ltm-storage"] --> ltm_storage_rows["ltm-storage-rows"]
  ltm_storage["ltm-storage"] --> ltm_storage_schema["ltm-storage-schema"]
  ltm_storage["ltm-storage"] --> semantic_fact["semantic-fact"]
  ltm_storage["ltm-storage"] --> types
  ltm_storage["ltm-storage"] --> vector_math["vector-math"]
  ltm_storage_rows["ltm-storage-rows"] --> episode
  ltm_storage_rows["ltm-storage-rows"] --> parse_helpers["parse-helpers"]
  ltm_storage_rows["ltm-storage-rows"] --> semantic_fact["semantic-fact"]
  ltm_storage_rows["ltm-storage-rows"] --> types
  ltm_storage_schema["ltm-storage-schema"]
  parse_helpers["parse-helpers"] --> types
  retrieval --> episode
  retrieval --> fsrs
  retrieval --> llm_port["llm-port"]
  retrieval --> ltm_storage["ltm-storage"]
  retrieval --> semantic_fact["semantic-fact"]
  retrieval --> utils
  segmenter --> episode
  segmenter --> llm_port["llm-port"]
  segmenter --> ltm_storage["ltm-storage"]
  segmenter --> types
  segmenter --> utils
  semantic_fact["semantic-fact"] --> types
  semantic_memory["semantic-memory"] --> ltm_storage["ltm-storage"]
  semantic_memory["semantic-memory"] --> semantic_fact["semantic-fact"]
  semantic_memory["semantic-memory"] --> types
  semantic_memory["semantic-memory"] --> utils
  types
  utils
  vector_math["vector-math"]
```

## ファイル別依存一覧

### composite-llm-adapter.ts

- モジュール内依存: llm-port, ltm-chat-adapter, types
- 他モジュール依存: ollama/

### consolidation.ts

- モジュール内依存: episode, llm-port, ltm-storage, semantic-fact, types, utils

### conversation-recorder.ts

- モジュール内依存: consolidation, llm-port, ltm-storage, segmenter
- 他モジュール依存: core/
- 外部依存: fs, path

### episode.ts

- モジュール内依存: types

### episodic.ts

- モジュール内依存: episode, fsrs, ltm-storage, types, utils

### fact-reader.ts

- モジュール内依存: ltm-storage
- 他モジュール依存: core/
- 外部依存: fs, path

### fsrs.ts

- モジュール内依存: types

### index.ts

- モジュール内依存: consolidation, episode, episodic, fsrs, llm-port, ltm-storage, retrieval, segmenter, semantic-fact, semantic-memory, types

### llm-port.ts

- モジュール内依存: types

### ltm-chat-adapter.ts

- モジュール内依存: types
- 他モジュール依存: core/

### ltm-storage.ts

- モジュール内依存: episode, fsrs, ltm-storage-rows, ltm-storage-schema, semantic-fact, types, vector-math
- 外部依存: bun:sqlite

### ltm-storage-rows.ts

- モジュール内依存: episode, parse-helpers, semantic-fact, types

### ltm-storage-schema.ts

- 外部依存: bun:sqlite

### parse-helpers.ts

- モジュール内依存: types

### retrieval.ts

- モジュール内依存: episode, fsrs, llm-port, ltm-storage, semantic-fact, utils

### segmenter.ts

- モジュール内依存: episode, llm-port, ltm-storage, types, utils

### semantic-fact.ts

- モジュール内依存: types

### semantic-memory.ts

- モジュール内依存: ltm-storage, semantic-fact, types, utils

### types.ts

- 依存なし

### utils.ts

- 依存なし

### vector-math.ts

- 依存なし
