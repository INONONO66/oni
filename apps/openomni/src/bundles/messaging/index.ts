import { Gateway, type PolicyRow } from "@openomni/protocol";
import { DEFAULT_DELEGATION_CAPS } from "../seams";

const external = Gateway.RuleTableA.shape.check.options.map((check) =>
  Gateway.RuleTableA.parse({
    id: `message.external.${check}`,
    table: "A",
    sender: "external",
    check,
    effect: "deny",
  }),
);
const internal = (["resident", "child"] as const).flatMap((senderRole) => [
  Gateway.RuleTableB.parse({
    id: `message.${senderRole}.parent`,
    table: "B",
    sender: "session",
    senderRole,
    targetKind: "session",
    check: { kind: "parent_child" },
    effect: "deny",
  }),
  Gateway.RuleTableB.parse({
    id: `message.${senderRole}.fanout`,
    table: "B",
    sender: "session",
    senderRole,
    targetKind: "new_session",
    check: { kind: "fanout", max: 8 },
    effect: "deny",
  }),
  Gateway.RuleTableB.parse({
    id: `message.${senderRole}.depth`,
    table: "B",
    sender: "session",
    senderRole,
    targetKind: "new_session",
    // Gateway ingest can create a child without passing through tool.pre.
    check: { kind: "depth", max: DEFAULT_DELEGATION_CAPS.maxDepth },
    effect: "deny",
  }),
  Gateway.RuleTableB.parse({
    id: `message.${senderRole}.deadline`,
    table: "B",
    sender: "session",
    senderRole,
    check: { kind: "deadline", withinParent: true },
    effect: "deny",
  }),
]);
const denials = [
  Gateway.RuleTableB.parse({
    id: "message.resident.actor_grant",
    table: "B",
    sender: "session",
    senderRole: "resident",
    targetKind: "actor",
    check: { kind: "actor_send" },
    effect: "deny",
  }),
  Gateway.RuleTableB.parse({
    id: "message.child.actor",
    table: "B",
    sender: "session",
    senderRole: "child",
    targetKind: "actor",
    check: { kind: "type" },
    effect: "deny",
  }),
  Gateway.RuleTableB.parse({
    id: "message.child.allocate",
    table: "B",
    sender: "session",
    senderRole: "child",
    targetKind: "new_session",
    check: { kind: "type" },
    effect: "deny",
  }),
  Gateway.RuleTableB.parse({
    id: "message.child.interrupt_parent",
    table: "B",
    sender: "session",
    senderRole: "child",
    targetKind: "session",
    targetRole: "resident",
    type: "interrupt",
    check: { kind: "type" },
    effect: "deny",
  }),
  ...(["resident", "child"] as const).map((senderRole) =>
    Gateway.RuleTableB.parse({
      id: `message.${senderRole}.actor_interrupt`,
      table: "B",
      sender: "session",
      senderRole,
      targetKind: "actor",
      type: "interrupt",
      check: { kind: "type" },
      effect: "deny",
    }),
  ),
];

export const MESSAGE_POLICY_ROWS: readonly Omit<PolicyRow.Row, "generation">[] = [
  ...external,
  ...internal,
  ...denials,
].map((message) => ({
  name: message.id,
  kind: "message",
  phase: "pre",
  priority: 1_000,
  match: { encodingVersion: 1, value: { message } },
  verdict: { encodingVersion: 1, value: { type: message.effect, reason: message.id } },
}));
