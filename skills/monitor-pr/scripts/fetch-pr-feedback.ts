#!/usr/bin/env bun
/**
 * Fetch and categorize PR review feedback.
 *
 * Usage:
 *   bun run fetch-pr-feedback.ts [--pr PR_NUMBER]
 *
 * If --pr is not specified, uses the PR for the current branch.
 *
 * Output: JSON to stdout with categorized feedback.
 *
 * Categories:
 * - high: Must address before merge (blocker, changes requested)
 * - medium: Should address (standard feedback)
 * - low: Optional suggestions (nit, style)
 * - bot: Informational automated comments (Codecov, Dependabot, etc.)
 * - resolved: Already resolved threads
 *
 * Bot classification:
 * - Review bots (Cursor, Bugbot, CodeQL, etc.) provide actionable code
 *   feedback. Their comments are categorized by content into high/medium/low
 *   with a `review_bot: true` flag — they are NOT placed in the `bot` bucket.
 * - Info bots (Codecov, Dependabot, Renovate, etc.) post status reports and
 *   are placed in the `bot` bucket for silent skipping.
 */

import { parseArgs } from "node:util";
import { runGh } from "./lib/gh.ts";

// ---------------------------------------------------------------------------
// Bot patterns
// ---------------------------------------------------------------------------

/** Bots that provide actionable code review feedback. */
const REVIEW_BOT_PATTERNS = [
  /^cursor/i,
  /^bugbot/i,
  /^copilot/i,
  /^codex/i,
  /^claude/i,
  /^codeql/i,
  /^sentry/i,
  /^warden/i,
  /^seer/i,
];

/** Bots that post informational status reports — skipped silently. */
const INFO_BOT_PATTERNS = [
  /^codecov/i,
  /^dependabot/i,
  /^renovate/i,
  /^github-actions/i,
  /^mergify/i,
  /^semantic-release/i,
  /^sonarcloud/i,
  /^snyk/i,
  /bot$/i,
  /\[bot\]$/i,
];

function isReviewBot(username: string): boolean {
  return REVIEW_BOT_PATTERNS.some((p) => p.test(username));
}

function isInfoBot(username: string): boolean {
  return INFO_BOT_PATTERNS.some((p) => p.test(username));
}

// ---------------------------------------------------------------------------
// gh CLI helpers
// ---------------------------------------------------------------------------

function getRepoInfo(): { owner: string; name: string } | null {
  const result = runGh(["repo", "view", "--json", "owner,name"]) as Record<
    string,
    unknown
  > | null;
  if (!result) return null;
  const owner = (result.owner as Record<string, string>)?.login;
  const name = result.name as string;
  return owner && name ? { owner, name } : null;
}

interface PrInfo {
  number: number;
  url: string;
  headRefName: string;
  author: { login: string };
  reviews: Array<{
    state: string;
    author: { login: string };
    body: string;
  }>;
  reviewDecision: string;
}

function getPrInfo(prNumber?: number): PrInfo | null {
  const args = [
    "pr",
    "view",
    "--json",
    "number,url,headRefName,author,reviews,reviewDecision",
  ];
  if (prNumber) args.splice(2, 0, String(prNumber));
  return runGh(args) as PrInfo | null;
}

function getReviewComments(
  owner: string,
  repo: string,
  prNumber: number,
): Array<Record<string, unknown>> {
  const result = runGh([
    "api",
    `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
    "--paginate",
  ]);
  return Array.isArray(result)
    ? (result as Array<Record<string, unknown>>)
    : [];
}

function getIssueComments(
  owner: string,
  repo: string,
  prNumber: number,
): Array<Record<string, unknown>> {
  const result = runGh([
    "api",
    `repos/${owner}/${repo}/issues/${prNumber}/comments`,
    "--paginate",
  ]);
  return Array.isArray(result)
    ? (result as Array<Record<string, unknown>>)
    : [];
}

interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: {
    nodes: Array<{
      id: string;
      body: string;
      author: { login: string };
      createdAt: string;
    }>;
  };
}

function getReviewThreads(
  owner: string,
  repo: string,
  prNumber: number,
): ReviewThread[] {
  const query = `
    query($owner: String!, $repo: String!, $pr: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              isOutdated
              path
              line
              comments(first: 10) {
                nodes {
                  id
                  body
                  author { login }
                  createdAt
                }
              }
            }
          }
        }
      }
    }
  `;

  const result = Bun.spawnSync(
    [
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repo}`,
      "-F",
      `pr=${prNumber}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  if (result.exitCode !== 0) return [];

  try {
    const data = JSON.parse(result.stdout.toString());
    return (
      data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Categorization
// ---------------------------------------------------------------------------

function detectPriority(body: string): "high" | "medium" | "low" | null {
  // Explicit markers (LOGAF-style)
  const markerPatterns: Array<[RegExp, "high" | "medium" | "low"]> = [
    [/^\s*(?:h:|h\s*:|high:|\[h\])/i, "high"],
    [/^\s*(?:m:|m\s*:|medium:|\[m\])/i, "medium"],
    [/^\s*(?:l:|l\s*:|low:|\[l\])/i, "low"],
  ];

  for (const [pattern, level] of markerPatterns) {
    if (pattern.test(body)) return level;
  }

  return null;
}

function categorizeComment(
  author: string,
  body: string,
): "high" | "medium" | "low" | "bot" {
  // Info bots get skipped (unless also a review bot)
  if (isInfoBot(author) && !isReviewBot(author)) return "bot";

  // Explicit markers first
  const explicit = detectPriority(body);
  if (explicit) return explicit;

  // High-priority content patterns
  const highPatterns = [
    /must\s+(fix|change|update|address)/i,
    /this\s+(is\s+)?(wrong|incorrect|broken|buggy)/i,
    /security\s+(issue|vulnerability|concern)/i,
    /will\s+(break|cause|fail)/i,
    /critical/i,
    /blocker/i,
  ];
  if (highPatterns.some((p) => p.test(body))) return "high";

  // Low-priority content patterns
  const lowPatterns = [
    /nit[:\s]/i,
    /nitpick/i,
    /suggestion[:\s]/i,
    /consider\s+(using|renaming|extracting|simplifying|splitting)/i,
    /could\s+(also\s+)?(be\s+(simplified|shortened|improved|cleaner)|use\s+)/i,
    /might\s+(want\s+to|be\s+(better|cleaner|nicer))/i,
    /optional[:\s]/i,
    /minor[:\s]/i,
    /style[:\s]/i,
    /prefer\s+/i,
    /what\s+do\s+you\s+think/i,
    /up\s+to\s+you/i,
    /take\s+it\s+or\s+leave/i,
    /fwiw/i,
  ];
  if (lowPatterns.some((p) => p.test(body))) return "low";

  return "medium";
}

// ---------------------------------------------------------------------------
// Feedback item builder
// ---------------------------------------------------------------------------

interface FeedbackItem {
  author: string;
  body: string;
  full_body: string;
  path?: string;
  line?: number;
  url?: string;
  resolved?: boolean;
  outdated?: boolean;
  review_bot?: boolean;
  thread_id?: string;
  type?: string;
}

function extractFeedbackItem(opts: {
  body: string;
  author: string;
  path?: string | null;
  line?: number | null;
  url?: string | null;
  isResolved?: boolean;
  isOutdated?: boolean;
  reviewBot?: boolean;
  threadId?: string | null;
}): FeedbackItem {
  const summary =
    opts.body.length > 200
      ? opts.body.slice(0, 200) + "..."
      : opts.body;

  const item: FeedbackItem = {
    author: opts.author,
    body: summary.replace(/\n/g, " ").trim(),
    full_body: opts.body,
  };

  if (opts.path) item.path = opts.path;
  if (opts.line) item.line = opts.line;
  if (opts.url) item.url = opts.url;
  if (opts.isResolved) item.resolved = true;
  if (opts.isOutdated) item.outdated = true;
  if (opts.reviewBot) item.review_bot = true;
  if (opts.threadId) item.thread_id = opts.threadId;

  return item;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      pr: { type: "string", short: "p" },
    },
    allowPositionals: false,
  });

  const prNumber = values.pr ? Number(values.pr) : undefined;

  // Get repo info
  const repoInfo = getRepoInfo();
  if (!repoInfo) {
    console.log(JSON.stringify({ error: "Could not determine repository" }));
    process.exit(1);
  }
  const { owner, name: repo } = repoInfo;

  // Get PR info
  const prInfo = getPrInfo(prNumber);
  if (!prInfo) {
    console.log(JSON.stringify({ error: "No PR found for current branch" }));
    process.exit(1);
  }

  const prAuthor = prInfo.author?.login ?? "";

  const feedback: Record<string, FeedbackItem[]> = {
    high: [],
    medium: [],
    low: [],
    bot: [],
    resolved: [],
  };

  // Process reviews for "changes requested"
  for (const review of prInfo.reviews ?? []) {
    if (review.state === "CHANGES_REQUESTED") {
      const author = review.author?.login ?? "";
      if (review.body && author !== prAuthor) {
        const item = extractFeedbackItem({ body: review.body, author });
        item.type = "changes_requested";
        feedback.high.push(item);
      }
    }
  }

  // Get review threads (inline comments with resolution status)
  const threads = getReviewThreads(owner, repo, prInfo.number);

  for (const thread of threads) {
    const comments = thread.comments?.nodes ?? [];
    if (comments.length === 0) continue;

    const firstComment = comments[0];
    const author = firstComment.author?.login ?? "";
    const body = firstComment.body ?? "";

    if (author === prAuthor) continue;
    if (!body || body.trim().length < 3) continue;

    const item = extractFeedbackItem({
      body,
      author,
      path: thread.path,
      line: thread.line,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      threadId: thread.id,
    });

    if (thread.isResolved) {
      feedback.resolved.push(item);
    } else if (isReviewBot(author)) {
      const category = categorizeComment(author, body);
      item.review_bot = true;
      feedback[category].push(item);
    } else if (isInfoBot(author)) {
      feedback.bot.push(item);
    } else {
      const category = categorizeComment(author, body);
      feedback[category].push(item);
    }
  }

  // Get issue comments (general PR conversation)
  const issueComments = getIssueComments(owner, repo, prInfo.number);

  for (const comment of issueComments) {
    const author =
      (comment.user as Record<string, string>)?.login ?? "";
    const body = (comment.body as string) ?? "";

    if (author === prAuthor) continue;
    if (!body || body.trim().length < 3) continue;

    const item = extractFeedbackItem({
      body,
      author,
      url: comment.html_url as string,
    });

    if (isReviewBot(author)) {
      const category = categorizeComment(author, body);
      item.review_bot = true;
      feedback[category].push(item);
    } else if (isInfoBot(author)) {
      feedback.bot.push(item);
    } else {
      const category = categorizeComment(author, body);
      feedback[category].push(item);
    }
  }

  // Count review bot items across priority buckets
  const reviewBotCount = ["high", "medium", "low"].reduce(
    (acc, bucket) =>
      acc + feedback[bucket].filter((i) => i.review_bot).length,
    0,
  );

  const output = {
    pr: {
      number: prInfo.number,
      url: prInfo.url ?? "",
      author: prAuthor,
      review_decision: prInfo.reviewDecision ?? "",
    },
    summary: {
      high: feedback.high.length,
      medium: feedback.medium.length,
      low: feedback.low.length,
      bot_comments: feedback.bot.length,
      resolved: feedback.resolved.length,
      review_bot_feedback: reviewBotCount,
      needs_attention: feedback.high.length + feedback.medium.length,
    },
    feedback,
    action_required: feedback.high.length
      ? "Address high-priority feedback before merge"
      : feedback.medium.length
        ? "Address medium-priority feedback"
        : feedback.low.length
          ? "Review low-priority suggestions - ask user which to address"
          : null,
  };

  console.log(JSON.stringify(output, null, 2));
}

main();
