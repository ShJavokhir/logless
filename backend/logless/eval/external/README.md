# External reference labels

Labels that other research groups published for WildChat-1M conversations, joined to our sample. Each file holds only our private `conv_id` and the labels, with no conversation text. None of these labels ever reach discovery, classification or any prompt. The evaluation job alone reads them.

| File | Rows (of our 5,000) | Source | Licence | How the labels were made | Join |
|---|---|---|---|---|---|
| `wildfeedback.jsonl` | 679 | [microsoft/WildFeedback](https://huggingface.co/datasets/microsoft/WildFeedback) (`sat_dsat_annotation`), [paper](https://arxiv.org/abs/2408.15549) | ODC-By | GPT-4 with a SPUR-style rubric. In the authors' 50-conversation check against humans: κ 0.50 on dissatisfaction, precision 83%, recall 48% | Exact ordered user-turn text → `turn_identifier` |
| `wildchat_aqa.jsonl` | 980 | [ksx-wz/wildchat_aqa_conversations](https://huggingface.co/datasets/ksx-wz/wildchat_aqa_conversations), [paper](https://arxiv.org/abs/2505.23765) | ODC-BY (source) | GPT-4o with a TnT-LLM taxonomy of 29 level-1 topics. Human vs model κ 0.62 on 100 samples | `conversation_hash` |
| `sh0416_category.jsonl` | 5,000 | [sh0416/wildchat-1m-tagged](https://huggingface.co/datasets/sh0416/wildchat-1m-tagged) | ODC-By | Mistral-7B, last user message only, 16 coarse categories | `conversation_hash` + timestamp |

Caveats to state wherever these numbers appear:
- **WildFeedback:** the overlap covers only English conversations with at least 3 user turns. It is a conversation-level "any dissatisfied turn" flag, and its low recall caps any agreement.
- **WildChat-AQA:** it is built from users with at least 10 sessions, and 27% of its conversations carry more than one topic.
- **None of these are human labels.** They are independent of our pipeline: different labs, models and rubrics.

Joined by `scratchpad/ext/join_wildfeedback.py`, reproduced in the build notes.
