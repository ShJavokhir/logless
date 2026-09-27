# Reference-set labelling guidelines (friction v1)

Label each conversation independently, from the conversation text only. You never see the pipeline's (Jev's) answers. When the evidence is genuinely ambiguous, answer `unclear` rather than guessing. Conversations can be in any language; judge them in their own language.

For every conversation, give one of `observed | not_observed | unclear` for each of the four signals.

## correction
Does the user point out that an assistant answer was wrong, broken or not what they asked for? That includes a factual error, buggy code, an ignored constraint or the wrong format.
- **observed:** the user explicitly says, or clearly shows, that a previous assistant answer was wrong or didn't follow their request. Examples: "that's not what I asked", pasting an error the assistant's code produced, "you forgot X", "this command deletes the repo".
- **not_observed:** anything else. New requests, follow-ups, adding details, asking for more or a variation, and the user changing their own mind don't count. A single-turn conversation is always not_observed.
- **unclear:** it might be a correction, but you can't tell from the text.

## repeat_request
Does the user repeat or rephrase essentially the same request because a previous assistant answer didn't satisfy it?
- **observed:** the user re-asks or rephrases the same request after an assistant answer, and that implies the answer fell short. Examples: "wheres the code" after getting prose, or sending the same prompt again.
- **not_observed:** no repeated request. Asking for more, asking for a variation ("now do the same for Y") or asking a new question doesn't count. A single-turn conversation is always not_observed.
- **unclear:** a repeat is possible, but you can't tell why from the text.

## assistant_limit
Does the assistant decline, or fail to do what the user asked, because of a limitation or policy? Examples: no internet or real-time data, can't open links or files, can't generate images, no memory of earlier chats, or refusing the request.
- **observed:** the assistant doesn't do the requested task and cites a limitation, lack of access or a policy.
- **not_observed:** the assistant does the task. A disclaimer such as "As an AI language model…" followed by an actual answer doesn't count.
- **unclear:** you can't tell whether the requested task was declined.

## complaint
Does the user express frustration or dissatisfaction with the assistant itself?
- **observed:** the user complains about the assistant's answers or behaviour. Examples: "that's useless", "you keep doing this", "stop apologizing", an angry "!!!" after a bad answer.
- **not_observed:** no complaint about the assistant. Complaints about other people, life or third-party tools don't count.
- **unclear:** the tone suggests dissatisfaction, but it isn't clearly aimed at the assistant.

## Output format (one JSON object per line)
```json
{"conv_id": "c_…", "labeller": "<your labeller id>", "friction": {"correction": "…", "repeat_request": "…", "assistant_limit": "…", "complaint": "…"}, "note": "<optional, ≤ 15 words, no quotes from the conversation>"}
```
Don't copy any conversation text into the output.

---

# Theme labelling (v1, taxonomy frozen at build b_20260927T011827)

For each conversation, choose the one published workflow (leaf) that best describes what the user is mainly trying to get done. Use the workflow definitions file (title, description, includes, excludes). Judge by the user's goal, not by the tool or format they used. If the conversation covers several goals, pick the dominant one: the goal that most of the user's turns serve. If no workflow fits well, answer `cl_other` (Other or unclear). Don't force a weak fit.

Output (one JSON object per line):
```json
{"conv_id": "c_…", "labeller": "<id>", "theme": "cl_…", "confidence": "high|medium|low", "note": "<optional, ≤ 15 words, no quotes>"}
```
