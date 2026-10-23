import type { Core } from "@oni/agent";
import { canonicalJson } from "@oni/protocol";
import { Effect } from "effect";
import { conflictRow, type ChildRow } from "./reconcile";

type SessionClient = Effect.Success<typeof Core.sessionClient>;
type Deliver = ReturnType<SessionClient>["Deliver"];
type DeliveryPort = (input: Parameters<Deliver>[0]) => Effect.Effect<
  { readonly seq: number; readonly existed: boolean },
  Effect.Error<ReturnType<Deliver>>
>;

/** The receiver must already exist; this door neither creates nor opens a session. */
export function admit(
  client: (sessionId: string) => { readonly Deliver: DeliveryPort },
  sessionId: string,
  rows: readonly ChildRow[],
) {
  const deliver = (row: ChildRow): ReturnType<DeliveryPort> =>
    client(sessionId).Deliver({
      kind: "action",
      body: canonicalJson({ content: canonicalJson(row) }),
      source: canonicalJson({ kind: "child_activity" }),
      idempotencyKey: row.key,
    });
  return Effect.gen(function* () {
    const admitted: ChildRow[] = [];
    for (const row of rows) {
      const accepted = yield* deliver(row).pipe(
        Effect.as(row),
        Effect.catchIf(
          (error) => error._tag === "DeliverRefused" && error.code === "idempotency_conflict",
          () => {
            const conflict = conflictRow(row);
            return deliver(conflict).pipe(Effect.as(conflict));
          },
        ),
      );
      admitted.push(accepted);
    }
    return admitted;
  });
}
