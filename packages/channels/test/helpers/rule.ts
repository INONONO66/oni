import type { Ingress } from "@oni/protocol";
import { ledger } from "./ledger";

export function registerRule(overrides: Partial<Ingress.Rule> = {}): void {
  ledger().stores.rules.add({
    id: "allow", position: 0, enabled: true, createdBy: "owner",
    when: { instance: "discord" }, then: { target: "conversation", kind: "prompt", reply: "auto" },
    ...overrides,
  });
}
