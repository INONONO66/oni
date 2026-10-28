import { AppInvariantError } from "../invariant";
import type { ActorRegistry, ChannelInstanceStore, PersonStore } from "@oni/channels";
import type { PlainValue, SessionTransition } from "@oni/protocol";
import { ContactOperation, contactDomainRevisions } from "../bundles/provision/contact-mutations";
import { secretRotateDomainRevisions } from "../bundles/provision/channels";
import { AutomationOperation } from "../bundles/provision/automation-schema";
import { automationDomainRevisions, automationId, type AutomationPort } from "../bundles/provision/automation";
import { MachineOperation } from "../bundles/provision/machine-schema";
import { machineDomainRevisions, type MachinePort } from "../bundles/provision/machines";

export interface RequestDomainDeps {
  readonly machineEnrollments?: MachinePort["enrollments"];
  readonly automations?: AutomationPort;
  readonly actors: ActorRegistry;
  readonly persons: Pick<PersonStore, "get">;
  /** #1600 lane R1: the channel declarations a secret rotation is consented against. */
  readonly instances?: Pick<ChannelInstanceStore, "list">;
}

function operationDomainRevisions(
  deps: RequestDomainDeps,
  operation: PlainValue | undefined,
): Readonly<Record<string, number>> | undefined {
  if (operation !== null && typeof operation === "object" && !Array.isArray(operation)) {
    const contact = ContactOperation.safeParse(operation);
    if (contact.success) return contactDomainRevisions(deps.actors, contact.data);
    if (operation.op === "contact_add") return personDomainRevisions(deps, operation.args);
    if (operation.op === "secret_rotate") return secretRotateRevisions(deps, operation.args);
  }
}

function secretRotateRevisions(
  deps: RequestDomainDeps,
  args: PlainValue | undefined,
): Readonly<Record<string, number>> | undefined {
  if (args !== null && typeof args === "object" && !Array.isArray(args) && typeof args.secretId === "string")
    return secretRotateDomainRevisions(deps.instances, args.secretId);
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

function sendTargetRevisions(
  deps: RequestDomainDeps,
  to: PlainValue | undefined,
): Readonly<Record<string, number>> | undefined {
  if (to !== null && typeof to === "object" && !Array.isArray(to) && to.kind === "contact" && typeof to.id === "string")
    return { [to.id]: deps.persons.get(to.id)?.revision ?? -1 };
}

/** Product read-back injected into the generic request owner, including dormant answers. */
export function createRequestDomainRevisions(deps: RequestDomainDeps) {
  return (request: SessionTransition.Request): Readonly<Record<string, number>> => {
    if (Object.keys(request.domainRevisions).length === 0) return {};
    const input = request.parsedInput;
    if (input !== null && typeof input === "object" && !Array.isArray(input)) {
      const machine = MachineOperation.safeParse(input.operation);
      if (machine.success && (machine.data.op === "machine_add" || machine.data.op === "machine_grant" || machine.data.op === "machine_deny"))
        return machineDomainRevisions(deps.machineEnrollments, machine.data.args.machineId);
      const automation = AutomationOperation.safeParse(input.operation);
      if (automation.success)
        return automationDomainRevisions(deps.automations, automationId(automation.data, request));
      const revisions = operationDomainRevisions(deps, input.operation);
      if (revisions !== undefined) return revisions;
      // #1569 lane 8: a send_message consent is bound to the Person the letter goes to.
      const letter = sendTargetRevisions(deps, input.to);
      if (letter !== undefined) return letter;
    }
    throw new AppInvariantError(`unrecognized request domain preconditions: ${request.requestId}`);
  };
}
