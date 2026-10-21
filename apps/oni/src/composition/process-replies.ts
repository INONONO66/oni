import { AppInvariantError } from "../invariant";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { EffectRunner } from "@oni/channels";
import { Deferred, Effect, Exit, Result } from "effect";
import { ThrownError } from "../thrown";
import type { Delivery, SessionTransition } from "@oni/protocol";
import type { ProcessDelivery } from "../process-entry";
import { ProcessReplyReceipt } from "./process-session";

/** #1248: the receiving session has this long to acknowledge an answer frame. */
const RECEIPT_DEADLINE_MS = 30_000;

/** Transport response correlation only; durable delivery truth remains in the source action tree. */
export function createProcessReplyChannel(
  input: Readable,
  write: (line: string) => void,
  run: EffectRunner,
) {
  const lines = createInterface({ input });
  const first = Promise.withResolvers<string | undefined>();
  let opened = false;
  const pending = new Map<string, Deferred.Deferred<SessionTransition.Resolution, Error>>();
  const deliveries = new Map<string, Deferred.Deferred<Delivery.Row, Error>>();
  function fail(error: Error): void {
    first.reject(error);
    for (const entry of pending.values()) Deferred.doneUnsafe(entry, Exit.fail(error));
    for (const entry of deliveries.values()) Deferred.doneUnsafe(entry, Exit.fail(error));
  }
  lines.on("line", (line) => {
    if (!opened) {
      opened = true;
      first.resolve(line);
      return;
    }
    const parsed = Result.try({
      try: () => ProcessReplyReceipt.parse(JSON.parse(line)),
      catch: ThrownError.parse,
    });
    if (Result.isFailure(parsed)) {
      fail(parsed.failure);
      return;
    }
    const receipt = parsed.success;
    const delivery = deliveries.get(receipt.inputId);
    if (delivery !== undefined) {
      Deferred.doneUnsafe(
        delivery,
        !receipt.ok
          ? Exit.fail(new Error(receipt.error))
          : "row" in receipt
            ? Exit.succeed(receipt.row)
            : Exit.fail(new Error("process delivery receipt carries no row")),
      );
      return;
    }
    const entry = pending.get(receipt.inputId);
    if (entry === undefined) {
      fail(new Error("unsolicited process receiving receipt"));
      return;
    }
    Deferred.doneUnsafe(
      entry,
      !receipt.ok
        ? Exit.fail(new Error(receipt.error))
        : "resolution" in receipt
          ? Exit.succeed(receipt.resolution)
          : Exit.fail(new Error("process answer receipt carries no resolution")),
    );
  });
  lines.on("close", () => {
    if (!opened) first.resolve(undefined);
    const closed = new Error("process reply transport closed");
    for (const entry of pending.values()) Deferred.doneUnsafe(entry, Exit.fail(closed));
    for (const entry of deliveries.values()) Deferred.doneUnsafe(entry, Exit.fail(closed));
  });
  lines.on("error", fail);
  return {
    first: first.promise,
    async answer(answer: SessionTransition.Answer): Promise<SessionTransition.Resolution> {
      if (pending.has(answer.inputId)) throw new AppInvariantError("process reply is already in flight");
      const response = Deferred.makeUnsafe<SessionTransition.Resolution, Error>();
      pending.set(answer.inputId, response);
      try {
        write(JSON.stringify({ kind: "request_answer", answer }));
        // The wait is an Effect on the injected runtime's clock: hitting the
        // deadline interrupts the wait and fails with the typed timeout error.
        return await run(
          Deferred.await(response).pipe(
            Effect.timeoutOrElse({
              duration: RECEIPT_DEADLINE_MS,
              orElse: () => Effect.fail(new Error("process receiving receipt timed out")),
            }),
          ),
        );
      } finally {
        pending.delete(answer.inputId);
      }
    },
    /** #1346: one child delivery, admitted by the parent's Session entity; the receipt is the pending row. */
    async deliver(input: ProcessDelivery): Promise<Delivery.Row> {
      const key = input.commit.id;
      if (deliveries.has(key)) throw new AppInvariantError("process delivery is already in flight");
      const response = Deferred.makeUnsafe<Delivery.Row, Error>();
      deliveries.set(key, response);
      try {
        write(JSON.stringify({ kind: "request_deliver", commit: input.commit, deliver: input.deliver }));
        return await run(
          Deferred.await(response).pipe(
            Effect.timeoutOrElse({
              duration: RECEIPT_DEADLINE_MS,
              orElse: () => Effect.fail(new Error("process delivery receipt timed out")),
            }),
          ),
        );
      } finally {
        deliveries.delete(key);
      }
    },
    close() {
      lines.close();
      input.pause();
    },
  };
}
