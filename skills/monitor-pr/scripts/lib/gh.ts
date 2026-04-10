/**
 * Shared helper for running `gh` CLI commands.
 */
export function runGh(args: string[]): unknown | null {
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
