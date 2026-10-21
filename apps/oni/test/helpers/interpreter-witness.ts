import { spyOn } from "bun:test";
import { ChildProcess, type SendHandle, type Serializable } from "node:child_process";

// Native ChildProcess event payloads. The optional spawn listener also models
// Node's declared spawn overload; the actual native spawn event has no payload.
type ChildEvent =
  | [event: "spawn", listener?: () => void]
  | [event: "disconnect"]
  | [event: "exit" | "close", code: number | null, signal: NodeJS.Signals | null]
  | [event: "error", error: Error]
  | [event: "message", message: Serializable, handle: SendHandle];

type EmitChildEvent = (this: ChildProcess, ...args: ChildEvent) => boolean;

/** Observes actual births; never replaces spawn, execution, kill, or event delivery. */
export function interpreterWitness() {
  const children: {
    readonly pid: number;
    readonly closed: Promise<void>;
  }[] = [];
  let completed = false;
  const emit = ChildProcess.prototype.emit;
  const observer = spyOn(ChildProcess.prototype, "emit").mockImplementation(
    new Proxy(emit, {
      apply(target: EmitChildEvent, child: ChildProcess, args: ChildEvent): boolean {
        const [event] = args;
        if (event === "spawn" && child.spawnfile === "python3") {
          const pid = child.pid;
          if (pid === undefined) throw new Error("spawn event without interpreter PID");
          // Both listeners exist before the original spawn event is delivered.
          const exited = new Promise<void>((resolve) => {
            child.once("exit", (code, signal) => {
              console.log("967-U1 interpreter exit", JSON.stringify({ pid, code, signal }));
              resolve();
            });
          });
          const closed = new Promise<void>((resolve) => {
            child.once("close", (code, signal) => {
              console.log("967-U1 interpreter close", JSON.stringify({ pid, code, signal }));
              resolve();
            });
          });
          children.push({ pid, closed: Promise.all([exited, closed]).then(() => undefined) });
          console.log("967-U1 interpreter birth", JSON.stringify({ pid, parentPid: process.pid }));
        }
        return target.apply(child, args);
      },
    }),
  );
  return {
    get pids() {
      return children.map(({ pid }) => pid);
    },
    get completed() {
      return completed;
    },
    async wait() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(children.map(({ closed }) => closed)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("owned interpreter completion timed out")),
              5000,
            );
          }),
        ]);
        completed = true;
      } finally {
        clearTimeout(timer);
      }
    },
    restore() {
      observer.mockRestore();
    },
  };
}
