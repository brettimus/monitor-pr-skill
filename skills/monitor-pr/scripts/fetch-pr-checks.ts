#!/usr/bin/env bun
/**
 * Fetch PR CI checks and extract relevant failure snippets.
 *
 * Usage:
 *   bun run fetch-pr-checks.ts [--pr PR_NUMBER]
 *
 * If --pr is not specified, uses the PR for the current branch.
 *
 * Output: JSON to stdout with structured check data.
 */

import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runGh(args: string[]): unknown | null {
  const result = Bun.spawnSync(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    if (stderr) console.error(`Error running gh ${args.join(" ")}: ${stderr}`);
    return null;
  }
  const stdout = result.stdout.toString().trim();
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

interface PrInfo {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
}

function getPrInfo(prNumber?: number): PrInfo | null {
  const args = ["pr", "view", "--json", "number,url,headRefName,baseRefName"];
  if (prNumber) args.splice(2, 0, String(prNumber));
  return runGh(args) as PrInfo | null;
}

interface RawCheck {
  name: string;
  bucket: string;
  link: string;
  workflow: string;
}

function getChecks(prNumber?: number): RawCheck[] {
  const args = ["gh", "pr", "checks"];
  if (prNumber) args.push(String(prNumber));

  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString().trim();
  if (!stdout) return [];

  const checks: RawCheck[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length >= 2) {
      checks.push({
        name: parts[0].trim(),
        bucket: parts[1].trim(),
        link: parts.length > 3 ? parts[3].trim() : "",
        workflow: "",
      });
    }
  }
  return checks;
}

interface WorkflowRun {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string;
  headSha: string;
}

function getFailedRuns(branch: string): WorkflowRun[] {
  const result = runGh([
    "run",
    "list",
    "--branch",
    branch,
    "--limit",
    "10",
    "--json",
    "databaseId,name,status,conclusion,headSha",
  ]);
  if (!Array.isArray(result)) return [];
  return (result as WorkflowRun[]).filter((r) => r.conclusion === "failure");
}

// ---------------------------------------------------------------------------
// Failure snippet extraction
// ---------------------------------------------------------------------------

const FAILURE_PATTERNS = [
  /error[:\s]/i,
  /failed[:\s]/i,
  /failure[:\s]/i,
  /traceback/i,
  /exception/i,
  /assert(ion)?.*failed/i,
  /FAILED/,
  /panic:/,
  /fatal:/i,
  /npm ERR!/,
  /yarn error/i,
  /ModuleNotFoundError/,
  /ImportError/,
  /SyntaxError/,
  /TypeError/,
  /ValueError/,
  /KeyError/,
  /AttributeError/,
  /NameError/,
  /IndentationError/,
  /===.*FAILURES.*===/,
  /___.*___/, // pytest failure separators
];

function extractFailureSnippet(logText: string, maxLines = 50): string {
  const lines = logText.split("\n");

  const failureIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (FAILURE_PATTERNS.some((p) => p.test(lines[i]))) {
      failureIndices.push(i);
    }
  }

  if (failureIndices.length === 0) {
    // No clear failure point — return last N lines
    return lines.slice(-maxLines).join("\n");
  }

  // Extract context around first failure point
  const firstFailure = failureIndices[0];
  const start = Math.max(0, firstFailure - 5);
  const end = Math.min(lines.length, firstFailure + maxLines - 5);

  const snippetLines = lines.slice(start, end);

  const remaining = failureIndices.filter((i) => i >= end);
  if (remaining.length > 0) {
    snippetLines.push(`\n... (${remaining.length} more error(s) follow)`);
  }

  return snippetLines.join("\n");
}

function getRunLogs(runId: number): string | null {
  try {
    const result = Bun.spawnSync(
      ["gh", "run", "view", String(runId), "--log-failed"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = result.stdout.toString();
    return stdout || result.stderr.toString() || null;
  } catch {
    return null;
  }
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

  // Get PR info
  const prInfo = getPrInfo(prNumber);
  if (!prInfo) {
    console.log(JSON.stringify({ error: "No PR found for current branch" }));
    process.exit(1);
  }

  const branch = prInfo.headRefName;

  // Get checks
  const checks = getChecks(prInfo.number);

  // Process checks and add failure snippets
  let failedRuns: WorkflowRun[] | null = null;

  const processedChecks = checks.map((check) => {
    const processed: Record<string, unknown> = {
      name: check.name,
      status: check.bucket,
      link: check.link,
      workflow: check.workflow,
    };

    if (processed.status === "fail") {
      if (failedRuns === null) {
        failedRuns = getFailedRuns(branch);
      }

      const workflowName = (check.workflow || check.name) as string;
      const matchingRun = failedRuns!.find((r) =>
        r.name.includes(workflowName),
      );

      if (matchingRun) {
        const logs = getRunLogs(matchingRun.databaseId);
        if (logs) {
          processed.log_snippet = extractFailureSnippet(logs);
          processed.run_id = matchingRun.databaseId;
        }
      }
    }

    return processed;
  });

  const output = {
    pr: {
      number: prInfo.number,
      url: prInfo.url ?? "",
      branch,
      base: prInfo.baseRefName ?? "",
    },
    summary: {
      total: processedChecks.length,
      passed: processedChecks.filter((c) => c.status === "pass").length,
      failed: processedChecks.filter((c) => c.status === "fail").length,
      pending: processedChecks.filter((c) => c.status === "pending").length,
      skipped: processedChecks.filter(
        (c) => c.status === "skipping" || c.status === "cancel",
      ).length,
    },
    checks: processedChecks,
  };

  console.log(JSON.stringify(output, null, 2));
}

main();
