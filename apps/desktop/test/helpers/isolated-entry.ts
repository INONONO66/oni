export async function runIsolated(path: string, env: Record<string, string>): Promise<void> {
  const proc = Bun.spawn([process.execPath, "test", path], {
    env: { ...process.env, ...env },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exit, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exit !== 0) throw new Error(stderr);
}
