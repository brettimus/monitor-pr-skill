---
name: monitor-pr
description: "Use when a pull request has CI failures, review bot feedback to address, or checks still running that need monitoring until green."
---

# Monitor PR Until CI Passes

Continuously iterate on the current branch until all CI checks pass and review feedback is addressed.

**Requires**: GitHub CLI (`gh`) authenticated.

**Requires**: `bun` runtime for running helper scripts.

**Important**: All scripts must be run from the repository root directory (where `.git` is located), not from the skill directory. Use the full path to the script via `${CLAUDE_SKILL_ROOT}`.

## Bundled Scripts

### `scripts/fetch-pr-checks.ts`

Fetches CI check status and extracts failure snippets from logs.

```bash
bun run ${CLAUDE_SKILL_ROOT}/scripts/fetch-pr-checks.ts [--pr NUMBER]
```

Returns JSON:
```json
{
  "pr": {"number": 123, "branch": "feat/foo"},
  "summary": {"total": 5, "passed": 3, "failed": 2, "pending": 0},
  "checks": [
    {"name": "tests", "status": "fail", "log_snippet": "...", "run_id": 123},
    {"name": "lint", "status": "pass"}
  ]
}
```

### `scripts/fetch-pr-feedback.ts`

Fetches and categorizes PR review feedback by priority.

```bash
bun run ${CLAUDE_SKILL_ROOT}/scripts/fetch-pr-feedback.ts [--pr NUMBER]
```

Returns JSON with feedback categorized as:
- `high` - Must address before merge (blocker, changes requested)
- `medium` - Should address (standard feedback)
- `low` - Optional (nit, style, suggestion)
- `bot` - Informational automated comments (Codecov, Dependabot, etc.)
- `resolved` - Already resolved threads

Review bot feedback (from Cursor, Bugbot, CodeQL, etc.) appears in `high`/`medium`/`low` with `review_bot: true` — it is NOT placed in the `bot` bucket.

### `scripts/reply-to-thread.ts`

Reply to PR review threads via GraphQL.

```bash
bun run ${CLAUDE_SKILL_ROOT}/scripts/reply-to-thread.ts THREAD_ID BODY [THREAD_ID BODY ...]
```

## Workflow

**IMPORTANT: You MUST use the Monitor tool for all waiting/polling.** Do NOT use `bash sleep` loops — they burn context and cost tokens on every poll cycle. Instead, use the `Monitor` tool to run a polling script in the background. The Monitor streams stdout lines as notifications, so you get alerted when something happens without occupying the conversation. This is not optional.

### 1. Identify PR

```bash
gh pr view --json number,url,headRefName
```

Stop if no PR exists for the current branch.

### 2. Gather Review Feedback

Run `bun run ${CLAUDE_SKILL_ROOT}/scripts/fetch-pr-feedback.ts` to get categorized feedback already posted on the PR.

### 3. Handle Feedback by Priority

**Auto-fix (no prompt):**
- `high` - must address (blockers, security, changes requested)
- `medium` - should address (standard feedback)

When fixing feedback:
- Understand the root cause, not just the surface symptom
- Check for similar issues in nearby code or related files
- Fix all instances, not just the one mentioned

This includes review bot feedback (items with `review_bot: true`). Treat it the same as human feedback:
- Real issue found -> fix it
- False positive -> skip, but explain why
- Never silently ignore review bot feedback — always verify the finding

**Prompt user for selection:**
- `low` - present numbered list and ask which to address:

```
Found 3 low-priority suggestions:
1. [nit] "Consider renaming this variable" - @reviewer in api.ts:42
2. [nit] "Could use a ternary" - @reviewer in utils.ts:18
3. [style] "Add a docstring" - @reviewer in models.ts:55

Which would you like to address? (e.g., "1,3" or "all" or "none")
```

**Skip silently:**
- `resolved` threads
- `bot` comments (informational only — Codecov, Dependabot, etc.)

### 4. Check CI Status

Run `bun run ${CLAUDE_SKILL_ROOT}/scripts/fetch-pr-checks.ts` to get structured failure data.

**Wait if pending:** If review bot checks (cursor, bugbot, codeql) are still running, wait before proceeding—they post actionable feedback that must be evaluated. Use the Monitor tool for waiting:

```sh
while true; do
  pending=$(gh pr checks --json bucket --jq '[.[] | select(.bucket != "pass" and .bucket != "fail")] | length') || { sleep 30; continue; }
  if [ "$pending" = "0" ]; then
    echo "ALL_CHECKS_COMPLETE"
    gh pr checks | head -20
    exit 0
  fi
  sleep 30
done
```

Use `persistent: false` with `timeout_ms: 900000` (15 min).

### 5. Fix CI Failures

**Investigation is mandatory before any fix.** Do not guess, assume, or infer the cause from the check name or a surface-level reading of the error. You must trace the failure to its root cause in the actual code.

For each failure:

1. **Read the full log, not just the snippet.** Use `gh run view <run-id> --log-failed` if the snippet is truncated or ambiguous. Identify the exact failing assertion, exception, or lint rule.
2. **Trace backwards from the failure to the cause.** Follow the stack trace or error message into the source code. Read the relevant functions, types, and call sites — not just the line flagged. Do not stop at the first plausible explanation.
3. **Verify your understanding before touching code.** You should be able to state: "This fails because X, which was introduced/affected by Y." If you cannot state that clearly, keep investigating.
4. **Do not assume the feedback is wrong.** If a check flags something that seems incorrect, investigate fully before concluding it's a false positive. Most apparent false positives turn out to be real issues on closer inspection.
5. **Check for related instances.** If a type error, import issue, or logic bug exists at one call site, search for the same pattern in nearby code and related files. Fix all instances.
6. **Fix the root cause with minimal, targeted changes.** Do not paper over the symptom with a workaround.

### 6. Verify Locally, Then Commit and Push

Before committing, verify your fixes locally:
- If you fixed a test failure: re-run that specific test locally
- If you fixed a lint/type error: re-run the linter or type checker on affected files
- For any code fix: run existing tests covering the changed code

If local verification fails, fix before proceeding — do not push known-broken code.

```bash
git add <files>
git commit -m "fix: <descriptive message>"
git push
```

### 7. Evaluate Bugbot Comments

Bugbot runs as a GitHub Actions check — the step 4 monitor already covers waiting for it to finish. Once CI is green, bugbot comments (posted by `cursor[bot]`) should already be available.

- Fetch comments: `bun run ${CLAUDE_SKILL_ROOT}/scripts/fetch-pr-feedback.ts`
- For each comment, evaluate whether the feedback is correct and actionable
- If a comment identifies a real issue, fix it
- If a comment is a false positive, skip it but explain why

### 8. Monitor CI and Address Feedback

Use the **Monitor tool** to poll CI status and review feedback instead of blocking:

1. Run `bun run ${CLAUDE_SKILL_ROOT}/scripts/fetch-pr-checks.ts` to get current CI status
2. If all checks passed -> proceed to exit conditions
3. If any checks failed (none pending) -> return to step 5
4. If checks are still pending:
   a. Run `bun run ${CLAUDE_SKILL_ROOT}/scripts/fetch-pr-feedback.ts` for new review feedback
   b. Address any new high/medium feedback immediately (same as step 3)
   c. If changes were needed, commit and push (this restarts CI), then use Monitor to wait
   d. Use the Monitor tool with the polling script from step 4, then repeat from sub-step 1
5. After all checks pass, do a final feedback check: run `bun run ${CLAUDE_SKILL_ROOT}/scripts/fetch-pr-feedback.ts`. Address any new high/medium feedback — if changes are needed, return to step 6.

### 9. Repeat

If step 8 required code changes (from new feedback after CI passed), return to step 2 for a fresh cycle.

## Exit Conditions

**Success:** All checks pass, post-CI feedback re-check is clean (no new unaddressed high/medium feedback including review bot findings), user has decided on low-priority items.

**Ask for help:** Same failure after 2 attempts, feedback needs clarification, infrastructure issues.

**Stop:** No PR exists, branch needs rebase.

## Fallback

If scripts fail, use `gh` CLI directly:
- `gh pr checks`
- `gh run view <run-id> --log-failed`
- `gh api repos/{owner}/{repo}/pulls/{number}/comments`
