import { AppInvariantError } from "../invariant";
import type { ActorRegistry, PersonStore } from "@openomni/channels";
import type { PlainValue, SessionTransition } from "@openomni/protocol";
import { ContactOperation, contactDomainRevisions } from "../bundles/provision/contact-mutations";
import { AutomationOperation } from "../bundles/provision/automation-schema";
import { automationDomainRevisions, automationId, type AutomationPort } from "../bundles/provision/automation";
import { MachineOperation } from "../bundles/provision/machine-schema";
import type { machineEnrollments } from "../bundles/provision/machine-enrollment";

export interface RequestDomainDeps {
  readonly machineEnrollments?: ReturnType<typeof machineEnrollments>;
  readonly automations?: AutomationPort;
  readonly actors: ActorRegistry;
  readonly persons: Pick<PersonStore, "get">;
}

function operationDomainRevisions(
  deps: RequestDomainDeps,
  operation: PlainValue | undefined,
): Readonly<Record<string, number>> | undefined {
  if (operation !== null && typeof operation === "object" && !Array.isArray(operation)) {
    const contact = ContactOperation.safeParse(operation);
    if (contact.success) return contactDomainRevisions(deps.actors, contact.data);
    if (operation.op === "contact_add") return personDomainRevisions(deps, operation.args);
  }
}

function personDomainRevisions(
  deps: RequestDomainDeps,
  args: PlainValue | undefined,
): Readonly<Record<string, number>> | undefined {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    const manifest = args.manifest;
    if (
      manifest !== null &&
      typeof manifest === "object" &&
      !Array.isArray(manifest) &&
      typeof manifest.id === "string"
    )
      return { [manifest.id]: deps.persons.get(manifest.id)?.revision ?? -1 };
  }
}

/** Product read-back injected into the generic request owner, including dormant answers. */
export function createRequestDomainRevisions(deps: RequestDomainDeps) {
  return (request: SessionTransition.Request): Readonly<Record<string, number>> => {
    if (Object.keys(request.domainRevisions).length === 0) return {};
    const input = request.parsedInput;
    if (input !== null && typeof input === "object" && !Array.isArray(input)) {
      const machine = MachineOperation.safeParse(input.operation);
      if (machine.success && machine.data.op === "machine_add")
        return deps.machineEnrollments?.revisions(machine.data.args.machineId) ?? {};
      const automation = AutomationOperation.safeParse(input.operation);
      if (automation.success)
        return automationDomainRevisions(deps.automations, automationId(automation.data, request));
      const revisions = operationDomainRevisions(deps, input.operation);
      if (revisions !== undefined) return revisions;
    }
    throw new AppInvariantError(`unrecognized request domain preconditions: ${request.requestId}`);
  };
}
