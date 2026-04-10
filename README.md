# monitor-pr-skill

A [Claude Code](https://claude.ai/code) skill plugin for monitoring PR CI checks, fixing failures, addressing review bot feedback (cursor[bot]), and pushing until green.

## Installation

Inside a Claude Code session:

```bash
# Add the repo as a marketplace
/plugin marketplace add brettimus/monitor-pr-skill

# Install the plugin
/plugin install monitor-pr@brettimus-monitor-pr-skill
```

**For local development:**
```bash
claude --plugin-dir /path/to/monitor-pr-skill
```

## Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`) authenticated
- [Bun](https://bun.sh/) runtime

## What it does

Automates the PR iteration cycle:

1. Check CI status (using the Monitor tool for efficient polling)
2. Fix failures with mandatory root-cause investigation
3. Evaluate and address review bot feedback (cursor[bot], CodeQL, etc.)
4. Push fixes and repeat until green

## Scripts

| Script | Purpose |
|--------|---------|
| `fetch-pr-checks.ts` | CI check status + failure log snippets |
| `fetch-pr-feedback.ts` | Categorized review feedback (high/medium/low/bot/resolved) |
| `reply-to-thread.ts` | Batched GraphQL thread replies |

All scripts output structured JSON and are run with `bun`.

## Attribution

Inspired by Sentry's [`iterate-pr`](https://github.com/getsentry/skills/tree/main/plugins/sentry-skills/skills/iterate-pr) skill. Ported from Python/uv to TypeScript/Bun with added Monitor tool integration for efficient CI polling.

## License

MIT
