import { MachinesFailure } from "@oni/machines";
import { CodemodeError, DriverFailure, type CodeError } from "./errors";

/** Dispatches a caught value to its typed error; anything untyped becomes `MachinesFailure`. */
export function decodeCodeFailure(operation: string) {
  return <Caught>(error: Caught): CodeError =>
    error instanceof CodemodeError ||
    error instanceof DriverFailure ||
    error instanceof MachinesFailure
      ? error
      : new MachinesFailure({ operation, cause: String(error) });
}
