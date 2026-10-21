import type { LedgerSession } from "@oni/protocol";
import type { MachineToolPorts } from "../bundles/tools/core/ports";
import type { ProvisionPort } from "../bundles/provision/channels";
import type { ContactPorts, MessagePort } from "../bundles/messaging/send-message/index";

export interface CatalogOrigin {
  readonly role: LedgerSession.Role;
  readonly sessionId: string;
}

/** Every dependency is declared; unavailable capabilities are explicitly undefined. */
export interface ToolPorts extends MachineToolPorts {
  readonly messages: MessagePort | undefined;
  /** Contact connectors (#1258); absent means connector kinds report not_sent. */
  readonly contacts?: ContactPorts;
  readonly provisioning: ProvisionPort | undefined;
  readonly clock: () => number;
  /** Injected id entropy (#1245): required, no ambient crypto fallback. */
  readonly id: () => string;
}
