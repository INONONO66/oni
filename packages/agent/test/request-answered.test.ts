import { expect, it } from "bun:test";
import { Effect } from "effect";
import { Journal, type LedgerAction, type PlainObject, type PlainValue } from "@openomni/protocol";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { sessionTree } from "./helpers/session-tree";
import { planeAnswer, requestPlane } from "./helpers/session-request-plane";

/**
 * Answers are the `answered` phase of the one `request` kind — no row
 * is ever written with the retired `reply` kind, and SQL correlation selects
 * answered requests by `kind = 'request' AND phase = 'answered'`.
 */
function requestRowsOf(sessionId: string): readonly LedgerAction.Node[] {
  return sessionTree(isolatedLedger().kernel, sessionId).filter(
    (action) => action.kind === "request",
  );
}

function phaseOf(action: LedgerAction.Node): PlainValue | undefined {
  const effect = action.effect.value;
  if (effect === null || typeof effect !== "object" || Array.isArray(effect)) return undefined;
  return effect.phase;
}

it("an answer lands as request{phase: answered, answer} and resolution as resolved", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const { port, opening } = yield* requestPlane();
        const request = yield* port.open(opening);
        const resolution = yield* port.answer(planeAnswer(request));
        expect(resolution).toBe("resolved");

        const rows = requestRowsOf("parent");
        expect(rows.length).toBeGreaterThanOrEqual(3);
        const phases = rows.map(phaseOf);
        expect(phases).toContain("open");
        expect(phases).toContain("answered");
        expect(phases).toContain("resolved");
        // every request row satisfies the closed-kind declaration
        const declaration = Journal.declarationFor("request");
        if (declaration === undefined) throw new Error("request kind undeclared");
        for (const row of rows) {
          expect(declaration.schema.safeParse({ intent: row.intent, effect: row.effect }).success).toBe(true);
        }
        const answered = rows.find((row) => phaseOf(row) === "answered");
        if (answered === undefined) throw new Error("missing answered row");
        const effect = answered.effect.value as PlainObject;
        expect(effect.answer).toMatchObject({ content: "child", decision: "answer" });

        // SQL correlation reads the answered phase through the one request kind
        const kernel = isolatedLedger().kernel;
        const state = kernel.requestById(request.requestId);
        expect(state?.state).toBe("resolved");
        expect(state?.replies).toHaveLength(1);
        const input = kernel.requestInputById("parent", "child:answer");
        expect(input?.kind).toBe("request");
        expect(phaseOf(input as LedgerAction.Node)).toBe("answered");
      }),
    ),
  ));

it("an expired request records the expired phase, never a reply row", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const { port, opening } = yield* requestPlane();
        const request = yield* port.open(opening);
        yield* port.timeout(request.requestId, 500);
        const rows = requestRowsOf("parent");
        expect(rows.map(phaseOf)).toContain("expired");
        const all = sessionTree(isolatedLedger().kernel, "parent");
        expect(all.every((action) => String(action.kind) !== "reply")).toBe(true);
        expect(isolatedLedger().kernel.requestById(request.requestId)?.state).toBe("expired");
      }),
    ),
  ));
