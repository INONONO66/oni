let sequence = 0;

/** Returns a short, process-unique Unix socket path for an app test. */
export function socketPath(): string {
  sequence += 1;
  return `/tmp/omo-app-${process.pid}-${sequence}.sock`;
}
