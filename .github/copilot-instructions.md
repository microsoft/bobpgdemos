# Collaboration preferences

- Walk through decisions together in conversation. Provide context before
  requesting a decision; do not assume the user knows the implementation details.
- Lead with a clear recommendation and explain why it meets the user's goal.
  Do not offload technical choices to the user through a menu of options.
- Do not use multiple-choice pop-up boxes unless the user explicitly requests
  them. Avoid unnecessary forms and repeated approval prompts.
- Before a required approval, explain in plain language what will change, what
  will stay unchanged, the meaningful risks, and the recommended next step.
  Keep any necessary confirmation narrowly scoped and simple.
- If the user says they lack context, pause and explain. Do not immediately
  present another approval form or rephrase the same choice.
- Distinguish local edits, deployed changes, and verified live behavior. State
  what has actually happened and what remains pending.
- Preserve required safety and deployment approvals. Discussion or confusion
  is not authorization to perform a gated action.
- When the user says stop, stop the pending workflow. Do not resume it
  automatically while handling a follow-up request.
