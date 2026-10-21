import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { canonicalDigest } from "@oni/protocol";
import { OUTBOUND_STATES_SQL } from "../../../src/core/store/session-file/reads";
import { materializeSession } from "../helpers/session";
import { withDiskStores } from "../helpers/storage";

const OLD_OUTBOUND_STATES_SQL = OUTBOUND_STATES_SQL.replace(
  "AND json_extract(b.intent, '$.op') IN ('open', 'ack')\n        ",
  "",
);

test.each([600, 2000])("outbound fold preserves rows and uses the partial index at %i turns", (turns) =>
  withDiskStores(`a9c-outbound-${turns}`, (stores) => {
    const kernel = stores.kernel;
    materializeSession(kernel, "s");
    for (let index = 0; index < turns; index += 1) {
      const message = {
        messageId: `m${String(index).padStart(4, "0")}`,
        sourceSessionId: "s",
        sourceActionId: "turn",
        destinationSessionId: "receiver",
        requestId: "request",
        replyTo: "binding",
        terminal: "completed",
        content: `reply-${index}`,
      };
      const receipt = stores.session.actions.append(
        {
          id: `${message.messageId}:open`,
          parentId: "s:configure",
          sessionId: "s",
          kind: "message",
          intent: { encodingVersion: 1, value: { op: "open" } },
          effect: {
            encodingVersion: 1,
            value: {
              outbound: {
                message: { ...message, digest: canonicalDigest(message) },
                state: index % 2 ? "pending" : "delivered",
                destinationReceipt: null,
              },
            },
          },
          ts: index + 2,
          irreversible: true,
        },
        kernel.row("s").revision,
      );
      if (receipt === undefined) throw new Error(`append refused: ${message.messageId}`);
      if (index % 2 === 0) {
        const ack = stores.session.actions.append(
          {
            id: `${message.messageId}:ack`,
            parentId: `${message.messageId}:open`,
            sessionId: "s",
            kind: "message",
            intent: { encodingVersion: 1, value: { op: "ack", messageId: message.messageId } },
            effect: {
              encodingVersion: 1,
              value: {
                outbound: {
                  message: { ...message, digest: canonicalDigest(message) },
                  state: "delivered",
                  destinationReceipt: { id: "receipt", revision: 1 },
                },
              },
            },
            ts: index + 2,
            irreversible: true,
          },
          kernel.row("s").revision,
        );
        if (ack === undefined) throw new Error(`ack refused: ${message.messageId}`);
      }
    }
    using db = new Database(stores.path, { readonly: true });
    const beforeStart = Bun.nanoseconds();
    const before = db
      .query<{ id: string }, [string, string, number]>(OLD_OUTBOUND_STATES_SQL)
      .all("s", "", turns)
      .map(({ id }) => id);
    const beforeMs = (Bun.nanoseconds() - beforeStart) / 1e6;
    const afterStart = Bun.nanoseconds();
    const after = db
      .query<{ id: string }, [string, string, number]>(OUTBOUND_STATES_SQL)
      .all("s", "", turns)
      .map(({ id }) => id);
    const afterMs = (Bun.nanoseconds() - afterStart) / 1e6;
    const plan = db.query<{ detail: string }, [string, string, number]>(
      `EXPLAIN QUERY PLAN ${OUTBOUND_STATES_SQL}`,
    ).all("s", "", turns).map(({ detail }) => detail).join("\n");
    console.log(
      `outbound fold ${turns} turns: old=${(beforeMs * 1000).toFixed(0)}µs ` +
        `new=${(afterMs * 1000).toFixed(0)}µs outboundSame:${before.join() === after.join()}`,
    );
    expect(after).toEqual(before);
    expect(plan).toContain("SEARCH b USING INDEX idx_action_outbound_state");
  }),
);
