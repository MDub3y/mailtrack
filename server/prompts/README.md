# Prompt variants

Files here are alternative texts for a run kind's `system` section, used by the replay harness:

    npm run replay -- --kind draft_follow_up --variant draft.v2 --judge

A variant replaces the first system block of every replayed run; the rest of the stored prompt (voice, memory, thread, task) is byte-identical to what the original run saw. Ship a variant's replay report with the PR that promotes it into the production prompt constant.
