# memory/ 依存関係（自動生成）

> commit 時に自動再生成。手動編集禁止。

## ファイル依存関係図

```mermaid
graph LR
  chat_adapter["chat-adapter"] --> types
  composite_llm_adapter["composite-llm-adapter"] --> chat_adapter["chat-adapter"]
  composite_llm_adapter["composite-llm-adapter"] --> llm_port["llm-port"]
  composite_llm_adapter["composite-llm-adapter"] --> types
  consolidation --> episode
  consolidation --> episodic
  consolidation --> llm_port["llm-port"]
  consolidation --> semantic_fact["semantic-fact"]
  consolidation --> storage
  consolidation --> types
  consolidation --> utils
  consolidation --> vector_math["vector-math"]
  conversation_recorder["conversation-recorder"] --> consolidation
  conversation_recorder["conversation-recorder"] --> episode
  conversation_recorder["conversation-recorder"] --> episodic
  conversation_recorder["conversation-recorder"] --> llm_port["llm-port"]
  conversation_recorder["conversation-recorder"] --> namespace
  conversation_recorder["conversation-recorder"] --> segmenter
  conversation_recorder["conversation-recorder"] --> storage
  episode --> types
  episodic --> episode
  episodic --> fsrs
  episodic --> storage
  episodic --> types
  episodic --> utils
  fact_reader["fact-reader"] --> namespace
  fact_reader["fact-reader"] --> retrieval
  fact_reader["fact-reader"] --> semantic_fact["semantic-fact"]
  fact_reader["fact-reader"] --> storage
  fsrs --> types
  index --> consolidation
  index --> episode
  index --> episodic
  index --> fsrs
  index --> llm_port["llm-port"]
  index --> retrieval
  index --> segmenter
  index --> semantic_fact["semantic-fact"]
  index --> semantic_memory["semantic-memory"]
  index --> storage
  index --> types
  llm_port["llm-port"] --> types
  namespace
  parse_helpers["parse-helpers"] --> types
  retrieval --> episode
  retrieval --> episodic
  retrieval --> fsrs
  retrieval --> llm_port["llm-port"]
  retrieval --> semantic_fact["semantic-fact"]
  retrieval --> storage
  retrieval --> utils
  segmenter --> episode
  segmenter --> llm_port["llm-port"]
  segmenter --> storage
  segmenter --> types
  segmenter --> utils
  semantic_fact["semantic-fact"] --> types
  semantic_memory["semantic-memory"] --> semantic_fact["semantic-fact"]
  semantic_memory["semantic-memory"] --> storage
  semantic_memory["semantic-memory"] --> types
  semantic_memory["semantic-memory"] --> utils
  storage --> episode
  storage --> fsrs
  storage --> semantic_fact["semantic-fact"]
  storage --> storage_rows["storage-rows"]
  storage --> storage_schema["storage-schema"]
  storage --> types
  storage --> vector_math["vector-math"]
  storage_rows["storage-rows"] --> episode
  storage_rows["storage-rows"] --> parse_helpers["parse-helpers"]
  storage_rows["storage-rows"] --> semantic_fact["semantic-fact"]
  storage_rows["storage-rows"] --> types
  storage_schema["storage-schema"]
  types
  utils
  vector_math["vector-math"]
```

## ファイル別依存一覧

### chat-adapter.ts

- モジュール内依存: types
- 他モジュール依存: shared

### composite-llm-adapter.ts

- モジュール内依存: chat-adapter, llm-port, types
- 他モジュール依存: ollama

### consolidation.ts

- モジュール内依存: episode, episodic, llm-port, semantic-fact, storage, types, utils, vector-math

### conversation-recorder.ts

- モジュール内依存: consolidation, episode, episodic, llm-port, namespace, segmenter, storage
- 他モジュール依存: shared
- 外部依存: fs, path

### episode.ts

- モジュール内依存: types

### episodic.ts

- モジュール内依存: episode, fsrs, storage, types, utils

### fact-reader.ts

- モジュール内依存: namespace, retrieval, semantic-fact, storage
- 他モジュール依存: shared
- 外部依存: fs

### fsrs.ts

- モジュール内依存: types

### index.ts

- モジュール内依存: consolidation, episode, episodic, fsrs, llm-port, retrieval, segmenter, semantic-fact, semantic-memory, storage, types

### llm-port.ts

- モジュール内依存: types

### namespace.ts

- 他モジュール依存: shared

### parse-helpers.ts

- モジュール内依存: types

### retrieval.ts

- モジュール内依存: episode, episodic, fsrs, llm-port, semantic-fact, storage, utils

### segmenter.ts

- モジュール内依存: episode, llm-port, storage, types, utils

### semantic-fact.ts

- モジュール内依存: types

### semantic-memory.ts

- モジュール内依存: semantic-fact, storage, types, utils

### storage.ts

- モジュール内依存: episode, fsrs, semantic-fact, storage-rows, storage-schema, types, vector-math
- 外部依存: bun:sqlite

### storage-rows.ts

- モジュール内依存: episode, parse-helpers, semantic-fact, types

### storage-schema.ts

- 外部依存: bun:sqlite

### types.ts

- 依存なし

### utils.ts

- 依存なし

### vector-math.ts

- 依存なし
