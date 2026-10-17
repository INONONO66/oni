import { expect, test } from "bun:test";
import type { PlainValue } from "@openomni/protocol";
import { approvalRequest } from "./helpers/approval-request";
import { createRequestDomainRevisions } from "../src/composition/request-domain-revisions";
import { testPlane } from "./helpers/ledger";

const plane = testPlane();
const requestDomainRevisions = createRequestDomainRevisions(plane.stores);

const manifest = {
  id: "person:sunwoo",
  kind: "human" as const,
  trustTier: "manager" as const,
  endpoints: [] as { channel: string; externalId: string }[],
};

test("contact_add reads back the live Person revision, absent as -1", () => {
  const declare = approvalRequest(
    { operation: { op: "contact_add", args: { manifest } } },
    { [manifest.id]: -1 },
  );
  expect(requestDomainRevisions(declare)).toEqual({ [manifest.id]: -1 });
  plane.stores.persons.put({
    ...manifest,
    displayName: "Sunwoo",
    revision: 4,
    createdBy: "resident",
    updatedAt: 1,
  });
  expect(requestDomainRevisions(declare)).toEqual({ [manifest.id]: 4 });
});

test("#1600 lane R1: secret_rotate reads back the revision of every Owner instance the secret speaks as; a bot consumer is nobody's precondition", () => {
  const row = {
    provider: "slack",
    enabled: true,
    settings: {},
    credentialRef: "secret:channel-slack-owner",
    createdBy: "owner",
    updatedAt: 1,
  };
  plane.stores.instances.put({ ...row, id: "channel:slack:owner", identity: "owner", revision: 3 });
  plane.stores.instances.put({ ...row, id: "channel:slack:main", identity: "bot", revision: 7 });
  const rotate = approvalRequest(
    { operation: { op: "secret_rotate", args: { secretId: "secret:channel-slack-owner", credential: { token: "xoxc-new", cookie: "d-new" } } } },
    { "channel:slack:owner": 0 },
  );
  expect(requestDomainRevisions(rotate)).toEqual({ "channel:slack:owner": 3 });
  plane.stores.instances.put({ ...row, id: "channel:slack:owner", identity: "owner", revision: 4 });
  expect(requestDomainRevisions(rotate)).toEqual({ "channel:slack:owner": 4 });
  // A secret no Owner instance speaks as has no rows to read back; one without a secretId is not a rotation at all.
  expect(
    requestDomainRevisions(
      approvalRequest({ operation: { op: "secret_rotate", args: { secretId: "secret:channel-slack-main", credential: {} } } }, { "x": 0 }),
    ),
  ).toEqual({});
  expect(() =>
    requestDomainRevisions(approvalRequest({ operation: { op: "secret_rotate", args: { credential: {} } } }, { "x": 0 })),
  ).toThrow("unrecognized request domain preconditions: request");
});

test("a request without domain preconditions reads back nothing", () => {
  expect(
    requestDomainRevisions(approvalRequest({ operation: { op: "status", args: {} } }, {})),
  ).toEqual({});
});

test("domain preconditions on an unrecognized operation fail closed", () => {
  const inputs: PlainValue[] = [
    { operation: { op: "channel_declare", args: {} } },
    { operation: { op: "contact_add", args: { manifest: "not-a-manifest" } } },
    "not-an-input",
  ];
  for (const parsedInput of inputs) {
    expect(() => requestDomainRevisions(approvalRequest(parsedInput, { persons: 1 }))).toThrow(
      "unrecognized request domain preconditions: request",
    );
  }
});
