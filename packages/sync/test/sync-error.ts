import { SyncError } from "@oni/sync";

export function code(run: () => void): string {
  let thrown = "no error";
  try {
    run();
  } catch (error) {
    thrown = error instanceof SyncError ? error.code : `not a SyncError: ${String(error)}`;
  }
  return thrown;
}
