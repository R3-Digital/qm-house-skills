---
name: scheduled-jobs
description: Rules for crons and recurring checks. Load this before you create, patch, re-enable or run a cron (cron tool action=create, patch, run) or set up anything that checks something repeatedly. Also load it whenever you are waiting on the user for a sign-in, auth, a credential or token, an approval or a decision.
scope: org
---

# Scheduled jobs

## The rule

When you are waiting on the user (a sign-in, auth, a credential or token, an approval, a decision, a file, anything only they can give), ask once in the main chat and stop.

Never create a cron, schedule or any recurring job that keeps checking or polling for it unless the user has said yes to that specific job in the chat.

- Asking is fine. For example: "Want me to check hourly for the CI result and archive the check when it lands, 24 fires max?" Then wait for the answer.
- The yes must refer to that job. "Keep going", "work autonomously", "don't stop until it's done", a /goal, or approval of a different job is not a yes.
- Silence is not a yes.
- Patching an existing cron to poll for something new, or re-enabling a paused cron, counts as creating one.

When the user replies (says it's done, pastes the token, signs in), that turn is your trigger. Pick up from there.

Every cron fire opens a new untitled session in the project sidebar, even when it ends with finish_silently. Crons that polled for a user action have flooded two projects this way, and neither could ever finish:

- "Kernel sandbox refresh watch" (87f17ed0671198c8) fired every 10 minutes waiting on Kernel auth.
- "R3 Vault: push when auth lands" (8e0e7f0b8f223e6d) fired every 15 minutes, then hourly, waiting on a GitHub token. Its fires tried to mint credential drop links, which are refused (403) on cron-triggered turns.

## Asking once

Send one message in the main chat with:

1. Exactly what you need (for a token, the scopes; for a sign-in, the link or code).
2. How to give it (a secret drop link minted on this live turn, where to paste it, where to sign in).
3. What you will do as soon as you have it.

Then end the turn. Don't repeat the ask in later turns unless the user raises it. Write what is pending to memory so the next turn picks it up.

For a device-flow sign-in (`gh auth login` and similar), use the background tool: action=start, relay the URL and code, then action=watch. The login's exit wakes this conversation. No cron needed.

To wait on a long job you started (a build, deploy or data job), use background action=watch, not a cron.

## Crons the user has approved

The rest of this skill applies only to a cron the user has said yes to.

Use a cron only for work that is time-based (a digest at 08:00) or waits on an external event that can complete without the user (a CI result, a deploy finishing, a public page changing).

### Before creating

- Run cron action=list. If a cron for the same purpose exists, update it with action=patch instead of creating a second one.
- If one check at a known time is enough, use a one-shot: schedule `{firstFireAt}`.

### Frequency

- Default to hourly or slower with `{cron, timezone}`, for example `"20 * * * *"` (hourly) or `"0 8 * * *"` (daily at 08:00), timezone `"Europe/London"`.
- Never schedule faster than every 30 minutes unless you gave the reason in the chat and the user agreed to that frequency.
- Use `{everyMs}` only for sub-day intervals where the time of day doesn't matter.

### What the task must contain

- The end condition: what "done" looks like.
- A cap: a maximum number of fires or an end date. The cron tool has no built-in limit, so the task enforces it. Track the count with cron action=note or in a file on the workspace disk.
- The self-archive step: when done or capped, call cron action=patch with its own id, `enabled: false` and `archived: true`, then post one line in the main chat.
- finish_silently when nothing has changed.

### Never on a cron fire

- Mint credential drop links (refused on trigger-fired turns).
- Start device-flow or web logins.
- Ask the user questions or wait for a reply.
- Anything else that needs a person present or an interactive tool.

If a fire finds it needs one of these, it archives the cron and posts once in the main chat saying what is needed.

### Announce

When you create a cron, post in the main chat:

- title and cron id
- schedule in plain words, with timezone
- end condition and cap

Do the same when you change its schedule or purpose.

### Finish

When the job is done or no longer needed, archive the cron: action=patch, `id`, `enabled: false`, `archived: true`. action=disable only pauses it; it stays in the list and can be resumed. Then say so in the main chat: "Archived cron <title> (<id>): <reason>."

## Checklist before cron action=create

1. Did the user say yes to this exact job in the chat? If not, ask and stop.
2. Is it time-based or external-event work that can complete without the user? If not, don't create it.
3. Did action=list show an existing cron to reuse?
4. Is it hourly or slower, or was a faster rate explained and agreed?
5. Does the task have an end condition, a cap, a self-archive step and finish_silently, with nothing interactive?
6. Will you announce it in the main chat?
