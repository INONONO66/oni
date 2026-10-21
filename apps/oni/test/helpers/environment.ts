/** Isolate real configuration parsing from the developer's exported credentials. */
export function replaceEnvironment(env: Record<string, string | undefined>): () => void {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  return () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  };
}
