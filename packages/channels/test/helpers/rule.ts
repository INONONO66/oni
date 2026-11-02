import type { Ingress } from "@oni/protocol";
import { ledger } from "./ledger";

export function registerRule(overrides: Partial<Ingress.Rule> = {}): void {
  ledger().stores.rules.add({
    id: "allow", position: 0, enabled: true, createdBy: "owner",
    when: { instance: "discord" }, outcome: { kind: "deliver", target: "conversation", deliveryKind: "prompt", reply: "auto" },
    ...overrides,
  });
}
