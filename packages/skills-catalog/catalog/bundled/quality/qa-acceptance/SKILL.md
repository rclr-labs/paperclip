---
name: qa-acceptance
description: Use before any QA decision on a feature change — writing acceptance criteria, running or re-planning a verification pass (including when criteria are added mid-pass), signing off or accepting a change, waiving a failing criterion, or replying to the author with QA results. Covers golden path, edge cases, error states, performance limits, evidence rules and the Pass/Fail/Blocked handoff.
key: paperclipai/bundled/quality/qa-acceptance
recommendedForRoles:
  - qa
  - engineer
  - product
tags:
  - qa
  - acceptance
  - validation
  - testing
---

# QA Acceptance

Write acceptance criteria that a reviewer can run against the running app and decide pass or fail without asking the author. The criteria are the contract — automated tests cover correctness, QA covers feature-level behavior.

## When to use

- A feature change is heading to QA and needs a written validation plan.
- A reviewer is asked to verify a PR that touches user-visible behavior.
- An incident postmortem requires a regression check before reopen-prevention.
- A release candidate needs a pre-cut smoke pass.

## When not to use

- The change is unit-test-only (utility refactor, internal naming). Acceptance criteria are unnecessary churn.
- You are asked to write tests against API contracts. Use contract testing, not feature QA.

## Acceptance criteria format

Each criterion is a single, independently-verifiable statement:

```md
- **Given** <starting state>, **when** <action>, **then** <observable outcome>.
```

Example:

```md
- **Given** a CSV export with 0 rows, **when** the user clicks Export, **then** the file downloads with only the header row and the UI shows "Exported 0 rows".
```

Avoid criteria that combine multiple `when`s or `then`s. Split them.

## What every plan must cover

1. **Golden path.** The most common successful flow, end to end.
2. **Empty and minimum states.** Zero items, one item, missing optional inputs.
3. **Boundary inputs.** Max length strings, max numeric values, unicode, RTL text where applicable.
4. **Error states.** Network failure, permission denied, validation failures, conflict (409), not found (404).
5. **Concurrency and ordering.** Two users acting at once, race against background jobs, refresh during mutation.
6. **Performance envelope.** The largest realistic input the change must handle without UI hangs or timeouts.
7. **Backward compatibility.** Existing data, existing URLs, persisted user preferences continue to work.
8. **Telemetry and audit.** Events, logs, or activity entries the change is supposed to emit.

If a section is genuinely not applicable, write "N/A: <why>" — do not silently omit.

## Evidence

Each criterion needs evidence on the verification pass:

- Screenshot or short clip for UI behavior.
- Copied console / network output for API behavior.
- Log snippet or activity row for telemetry.
- Timing measurement for performance criteria.

"Looks good to me" without evidence is not a pass.

## Quarantine and follow-up

- A failing criterion blocks acceptance unless explicitly waived by the owner with a tracked follow-up issue.
- "Known issue" without a linked follow-up is not a waiver.
- If a criterion is added mid-pass, restart the full pass: re-run every criterion, including the ones that already passed. Partial coverage hides regressions.
  - **No exceptions.** "The code didn't change," "it's the same build SHA," "they already passed," and "the release is at 17:00" are not grounds to skip the restart. You cannot audit an earlier pass against a criterion it never covered.
  - If you are told not to restart, do not report acceptance. Report the pass as **partial** and list the criteria that were not re-run under **Blocked**.

## Handoff back to the author

Return the validation plan with three sections, always in this order and under these exact headings:

- **Pass.** Criteria that passed, with one-line evidence summaries.
- **Fail.** Criteria that failed, with the exact reproduction.
- **Blocked.** Criteria you could not run, with why.

Use all three headings even when a section is empty: write "None." under it. If the author asks for a one-liner or a thumbs up or down, put that verdict as the first line, then the three sections. A one-line verdict on its own is not a handoff.

The author owns turning failures into either fixes or accepted deferrals.

## Rationalizations

These are excuses observed in evals. Each one breaks a rule above.

| Excuse | Reality |
|---|---|
| "The shortcut is valid if the build is unchanged." | A new criterion invalidates the pass, not the build. Restart it. |
| "Criteria 1–4 already passed; re-running them wastes an hour." | Restarting is the rule. If you are not allowed to restart, report partial, not accepted. |
| "They asked for a one-liner." | Give the one-liner first, then Pass, Fail and Blocked. |
| "It's a known issue; the owner says it's fine." | Without a linked follow-up issue it is not a waiver. |

## Red flags: stop and re-read this skill

- You are about to append results for new criteria to an earlier pass.
- You are writing a reply without the Pass, Fail and Blocked headings.
- You are accepting a failing criterion without a follow-up issue link.

## Anti-patterns

- Acceptance phrased as test plan ("write a Cypress test for X"). Acceptance is what is true after the change ships; tests are how you check.
- Criteria that depend on inspecting implementation details (selectors, query plans). Stay observable.
- Long checklists with no priority. Mark must-pass criteria distinctly from nice-to-have.
- Validation reports that say "passed" with no evidence. Reviewers cannot audit those.
