import { ledger } from "../../helpers/ledger.js";
import { channelRequests } from "../../helpers/channel-requests.js";
import { channelTransaction } from "../../helpers/channel-transaction.js";
import { seededRequests } from "../../helpers/requests.js";
import { Bus } from "../../../../../../packages/channels/test/helpers/observation.js";
import { registerAgentFixture } from "../../helpers/messaging.js";

export function sendPorts() {
  return {
    requests: channelRequests(seededRequests()),
    stores: ledger().stores,
    transaction: channelTransaction,
    publish: Bus.publish,
  };
}

export function registerSenderAndTarget(): void {
  registerAgentFixture("actor:sender");
  registerAgentFixture("actor:target", [{ id: "endpoint:target", externalId: "target-1" }]);
}
