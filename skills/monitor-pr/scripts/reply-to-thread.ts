#!/usr/bin/env bun
/**
 * Reply to PR review threads.
 *
 * Usage:
 *   bun run reply-to-thread.ts THREAD_ID BODY [THREAD_ID BODY ...]
 *
 * Accepts one or more (thread_id, body) pairs as positional arguments.
 * Batches all replies into a single GraphQL mutation for efficiency.
 *
 * Example:
 *   bun run reply-to-thread.ts PRRT_abc "Fixed the issue.\n\n*-- Claude Code*"
 *   bun run reply-to-thread.ts PRRT_abc "Fixed." PRRT_def "Also fixed."
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeBody(body: string): string {
  // Normalize escaped newlines from shell input
  let normalized = body.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");

  // Add Claude Code attribution if not already present
  const lines = normalized.trimEnd().split("\n");
  const lastLine = lines.at(-1) ?? "";

  // Match bot signatures like "*-- Claude Code*", "*— Any Bot*"
  const botSignaturePattern = /^\*[—-]\s+.+\*$/;

  if (!botSignaturePattern.test(lastLine.trim())) {
    normalized = normalized.trimEnd() + "\n\n*-- Claude Code*";
  }

  return normalized;
}

interface OperationResult {
  threadId: string;
  success: boolean;
}

function replyToThreads(
  pairs: Array<[string, string]>,
): OperationResult[] {
  // Build aliased GraphQL mutation
  const mutations = pairs.map(([threadId, body], i) => {
    const escapedThreadId = JSON.stringify(threadId);
    const escapedBody = JSON.stringify(normalizeBody(body));
    return `  r${i}: addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: ${escapedThreadId}, body: ${escapedBody}}) { clientMutationId }`;
  });

  const query = `mutation {\n${mutations.join("\n")}\n}`;

  const result = Bun.spawnSync(
    ["gh", "api", "graphql", "-f", `query=${query}`],
    { stdout: "pipe", stderr: "pipe" },
  );

  if (result.exitCode !== 0) {
    console.error(`GraphQL error: ${result.stderr.toString()}`);
    return pairs.map(([threadId]) => ({ threadId, success: false }));
  }

  let response: Record<string, unknown>;
  try {
    response = JSON.parse(result.stdout.toString());
  } catch {
    console.error(
      `Failed to parse GraphQL response: ${result.stdout.toString()}`,
    );
    return pairs.map(([threadId]) => ({ threadId, success: false }));
  }

  const data = (response.data as Record<string, unknown>) ?? {};
  const errors = (response.errors as Array<Record<string, unknown>>) ?? [];

  // Build set of alias indices that have errors
  const errorPaths = new Set<string>();
  for (const err of errors) {
    for (const segment of (err.path as string[]) ?? []) {
      if (typeof segment === "string" && segment.startsWith("r")) {
        errorPaths.add(segment);
      }
    }
  }

  const results: OperationResult[] = pairs.map(([threadId], i) => {
    const alias = `r${i}`;
    const success = !errorPaths.has(alias) && data[alias] != null;
    return { threadId, success };
  });

  const failed = results.filter((r) => !r.success).map((r) => r.threadId);
  if (failed.length > 0) {
    console.error(`GraphQL partial failure for threads: ${failed.join(", ")}`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = Bun.argv.slice(2);

  if (args.length === 0 || args.length % 2 !== 0) {
    console.error(
      "Usage: reply-to-thread.ts THREAD_ID BODY [THREAD_ID BODY ...]",
    );
    console.error("Arguments must be (thread_id, body) pairs");
    process.exit(1);
  }

  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < args.length; i += 2) {
    pairs.push([args[i], args[i + 1]]);
  }

  const results = replyToThreads(pairs);

  const byThread: Record<string, boolean[]> = {};
  for (const { threadId, success } of results) {
    (byThread[threadId] ??= []).push(success);
  }

  const output = {
    replied: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    operations: results.map((r) => ({
      thread_id: r.threadId,
      status: r.success ? "ok" : "failed",
    })),
    threads: Object.fromEntries(
      Object.entries(byThread).map(([tid, statuses]) => [
        tid,
        statuses.every(Boolean) ? "ok" : "failed",
      ]),
    ),
  };

  console.log(JSON.stringify(output, null, 2));

  if (results.some((r) => !r.success)) {
    process.exit(1);
  }
}

main();
