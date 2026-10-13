// "Fencing is atomic or checked against catalog at commit": the session file
// is the ONE fence authority. The catalog only
// allocates fence numbers; authority transfers when the winner's `adoptFence`
// CAS lands in the session file, serialized in the same file lock as every
// fenced commit. Proven here with the real catalog + session stores: an
// old-fence commit before adoption is accepted AND visible to the successor,
// one after adoption is refused typed-stale with nothing appended, and one
// alarm occurrence is consumed exactly once across rotate/adopt in either
// order (the losing attempt refused by fence or folded away by the chain
// guard).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  alarmDisposition,
  armAction,
  firedAction,
  type AlarmChainReads,
} from "../../src/core/alarm";
import { createSessionKernel, type SessionKernel } from "../../src/core/store/fence";
import { openCatalogStore } from "../../src/core/store/catalog";
import { openSessionStore } from "../../src/core/store/session-file";
import { runLedgerSync } from "./helpers/effect";
import { TEST_NOW, testNow } from "./helpers/storage";

const SESSION_ID = "h1";
const OLD_WRITER = "runner:old";
const SUCCESSOR = "runner:new";

function armedOccurrence(parentId: string | null) {
  return armAction({
    parentId,
    sessionId: SESSION_ID,
    purpose: "qa",
    at: TEST_NOW + 60_000,
    supersedes: null,
    alarmId: "a",
    sourceKey: "qa",
    payload: {},
    armSeq: 1,
    ts: TEST_NOW,
  });
}

function deliveredFiring(occurrenceId: string) {
  return firedAction({
    parentId: null,
    sessionId: SESSION_ID,
    purpose: "qa",
    alarmId: "a",
    occurrenceId,
    outcome: "delivered",
    ts: TEST_NOW,
  });
}

function commitWith(
  kernel: SessionKernel,
  owner: string,
  fence: number,
  actions: Parameters<SessionKernel["commit"]>[0]["actions"],
) {
  const row = kernel.row(SESSION_ID);
  return kernel.commit({
    sessionId: SESSION_ID,
    owner,
    fence,
    now: TEST_NOW,
    expectedRevision: row.revision,
    actions,
    state: row.state,
  });
}

/** The chain guard's reads, exactly as the entity wires them (entity.ts `armedChainReads`). */
function chainReads(kernel: SessionKernel): AlarmChainReads {
  return {
    latestArm: (alarmId) => {
      const row = kernel.armedAlarms().find((armed) => armed.alarmId === alarmId);
      return row === undefined ? undefined : { occurrenceId: row.occurrenceId, at: row.fireAt };
    },
    settled: (occurrenceId) =>
      kernel.actionById(`${occurrenceId}:delivered`) !== undefined ||
      kernel.actionById(`${occurrenceId}:exhausted`) !== undefined,
  };
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "fence-catalog-commit-"));
  const catalog = openCatalogStore(join(directory, "catalog.sqlite"), { now: testNow });
  const session = openSessionStore(join(directory, `${SESSION_ID}.sqlite`), { now: testNow });
  const kernel = createSessionKernel(session, catalog);
  runLedgerSync(
    kernel.materialize({
      id: SESSION_ID,
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 0,
      actionId: `${SESSION_ID}:configure`,
      at: 1,
    }),
  );
  catalog.indexSession({ id: SESSION_ID, parentId: null, role: "resident", createdAt: 1 });
  expect(catalog.rotateFence(SESSION_ID)).toBe(1);
  runLedgerSync(kernel.adoptFence({ sessionId: SESSION_ID, owner: OLD_WRITER, fence: 1 }));
  const close = () => {
    session.close();
    catalog.close();
    rmSync(directory, { recursive: true });
  };
  return { catalog, kernel, close };
}

test("rotation allocated but not adopted: the old writer's commit lands and the successor reads it after adopting", () => {
  const world = setup();
  try {
    const { catalog, kernel } = world;
    // The successor has only ALLOCATED fence 2; authority is still the file's fence 1.
    expect(catalog.rotateFence(SESSION_ID)).toBe(2);
    const before = kernel.row(SESSION_ID);
    const { action, occurrenceId } = armedOccurrence(null);
    const receipt = runLedgerSync(commitWith(kernel, OLD_WRITER, 1, [action]));
    expect(receipt.ok).toBe(true);
    // Authority transfers only now, strictly after the accepted commit.
    runLedgerSync(kernel.adoptFence({ sessionId: SESSION_ID, owner: SUCCESSOR, fence: 2 }));
    // The successor READS the accepted row: chain row, revision, armed index.
    const adopted = kernel.row(SESSION_ID);
    expect(adopted).toMatchObject({ fence: 2, fenceOwner: SUCCESSOR, revision: before.revision + 1 });
    expect(kernel.actionById(action.id)).toMatchObject({ id: action.id, kind: "alarm" });
    expect(kernel.armedAlarms()).toMatchObject([{ alarmId: "a", occurrenceId }]);
  } finally {
    world.close();
  }
});

test("rotation adopted: the old-fence commit is refused typed-stale and appends nothing", () => {
  const world = setup();
  try {
    const { catalog, kernel } = world;
    expect(catalog.rotateFence(SESSION_ID)).toBe(2);
    runLedgerSync(kernel.adoptFence({ sessionId: SESSION_ID, owner: SUCCESSOR, fence: 2 }));
    const before = kernel.row(SESSION_ID);
    const { action } = armedOccurrence(null);
    const refused = runLedgerSync(Effect.flip(commitWith(kernel, OLD_WRITER, 1, [action])));
    expect(refused).toMatchObject({
      _tag: "CommitRefused",
      reason: "fence",
      fence: 1,
      currentFence: 2,
    });
    expect(kernel.actionById(action.id)).toBeUndefined();
    expect(kernel.row(SESSION_ID)).toMatchObject({
      revision: before.revision,
      fence: 2,
      fenceOwner: SUCCESSOR,
    });
  } finally {
    world.close();
  }
});

test("exactly-one consumption, old writer first: the successor's attempt folds to skip at the chain guard", () => {
  const world = setup();
  try {
    const { catalog, kernel } = world;
    const { action, occurrenceId } = armedOccurrence(null);
    runLedgerSync(commitWith(kernel, OLD_WRITER, 1, [action]));
    // Old writer consumes while still the file's authority.
    expect(alarmDisposition(chainReads(kernel), { alarmId: "a", occurrenceId })).toEqual({
      op: "run",
    });
    runLedgerSync(commitWith(kernel, OLD_WRITER, 1, [deliveredFiring(occurrenceId)]));
    const consumedAt = kernel.row(SESSION_ID).revision;
    expect(catalog.rotateFence(SESSION_ID)).toBe(2);
    runLedgerSync(kernel.adoptFence({ sessionId: SESSION_ID, owner: SUCCESSOR, fence: 2 }));
    // The successor sees the consumption and the guard refuses a second one.
    expect(kernel.actionById(`${occurrenceId}:delivered`)).toBeDefined();
    expect(
      alarmDisposition(chainReads(kernel), { alarmId: "a", occurrenceId }).op,
    ).toBe("skip");
    expect(kernel.row(SESSION_ID).revision).toBe(consumedAt);
  } finally {
    world.close();
  }
});

test("exactly-one consumption, successor first: the old writer's attempt is refused by the file fence", () => {
  const world = setup();
  try {
    const { catalog, kernel } = world;
    const { action, occurrenceId } = armedOccurrence(null);
    runLedgerSync(commitWith(kernel, OLD_WRITER, 1, [action]));
    expect(catalog.rotateFence(SESSION_ID)).toBe(2);
    runLedgerSync(kernel.adoptFence({ sessionId: SESSION_ID, owner: SUCCESSOR, fence: 2 }));
    expect(alarmDisposition(chainReads(kernel), { alarmId: "a", occurrenceId })).toEqual({
      op: "run",
    });
    runLedgerSync(commitWith(kernel, SUCCESSOR, 2, [deliveredFiring(occurrenceId)]));
    const consumedAt = kernel.row(SESSION_ID).revision;
    // The fenced-out writer retries the same consumption; the file refuses it.
    const refused = runLedgerSync(
      Effect.flip(commitWith(kernel, OLD_WRITER, 1, [deliveredFiring(occurrenceId)])),
    );
    expect(refused).toMatchObject({ _tag: "CommitRefused", reason: "fence", currentFence: 2 });
    expect(kernel.actionById(`${occurrenceId}:delivered`)).toBeDefined();
    expect(kernel.row(SESSION_ID).revision).toBe(consumedAt);
  } finally {
    world.close();
  }
});
