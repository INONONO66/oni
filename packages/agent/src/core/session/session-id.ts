/**
 * A session id names one file in the sessions dir, so it must be one safe
 * filename component. Unsafe ids are refused, never normalized.
 */
export function sessionIdProblem(id: string): string | undefined {
  if (id.length === 0) return "session id is empty";
  if (id === "." || id === "..") return `session id ${JSON.stringify(id)} is a dot segment`;
  if (/[/\\\0]/.test(id)) return `session id ${JSON.stringify(id)} holds a path separator or NUL`;
  return undefined;
}
