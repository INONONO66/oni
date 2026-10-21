export function processOutput(child: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
}
