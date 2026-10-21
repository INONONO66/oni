import { ledger } from "../../helpers/ledger";
import { runEffect } from "../../helpers/effect";
import { beforeEach, describe, expect, test } from "bun:test";
import type { Gateway } from "@oni/protocol";

import { createExistingAgentMessaging } from "../../../src/router/messaging/send.js";
import { evaluateSocialBudget } from "../../../src/router/messaging/social-budget.js";
import {
  expectDenied,
  buildGrant,
  buildSendInput,
  messagingNow,
} from "../../helpers/messaging.js";
import { resetStores } from "../_router-fixture";
import { registerSenderAndTarget, sendPorts } from "./_send-fixture";

const ZERO_STATE: Gateway.EgressDebitState = {
  countInWindow: 0,
  notifyInWindow: 0,
  converseInWindow: 0,
};

function inspectDebitState(senderId: string, targetActorId: string): Gateway.EgressDebitState {
  let observed: Gateway.EgressDebitState | undefined;
  ledger().stores.egressBudgets.claim(
    {
      id: "test:inspection-never-recorded",
      senderId,
      targetActorId,
      class: "notify",
      at: messagingNow,
    },
    0,
    (state: Gateway.EgressDebitState) => {
      observed = state;
      return "inspect" as const;
    },
  );
  if (observed === undefined) throw new Error("egress claim evaluator was not called");
  return observed;
}

const budget = (overrides: Partial<Gateway.SocialBudget> = {}): Gateway.SocialBudget => ({
  id: "budget:target",
  targetActorId: "actor:target",
  maxPerWindow: 2,
  windowMs: 60_000,
  cooldownMs: 0,
  ...overrides,
});

describe("evaluateSocialBudget (pure fold, #219)", () => {
  test("fail-safe default: no Owner-declared budget suppresses cold proactive at zero", () => {
    expect(
      evaluateSocialBudget(undefined, ZERO_STATE, { class: "notify", at: messagingNow }),
    ).toEqual({ suppress: "budget_exhausted" });
  });

  test("do-not-contact is a hard kill switch, ahead of any count", () => {
    expect(
      evaluateSocialBudget(budget({ doNotContact: true }), ZERO_STATE, {
        class: "notify",
        at: messagingNow,
      }),
    ).toEqual({ suppress: "dnc_denied" });
  });

  test("a lapsed allowance re-applies the fail-safe (suppressed, not admitted)", () => {
    expect(
      evaluateSocialBudget(budget({ expiresAt: messagingNow - 1 }), ZERO_STATE, {
        class: "notify",
        at: messagingNow,
      }),
    ).toEqual({ suppress: "budget_exhausted" });
  });

  test("window cap: at the cap, the next send is budget_exhausted", () => {
    expect(
      evaluateSocialBudget(
        budget({ maxPerWindow: 2 }),
        { ...ZERO_STATE, countInWindow: 2 },
        {
          class: "notify",
          at: messagingNow,
        },
      ),
    ).toEqual({ suppress: "budget_exhausted" });
    expect(
      evaluateSocialBudget(
        budget({ maxPerWindow: 2 }),
        { ...ZERO_STATE, countInWindow: 1 },
        {
          class: "notify",
          at: messagingNow,
        },
      ),
    ).toBe("allow");
  });

  test("cooldown: a send within cooldownMs of the last is cooldown_suppressed", () => {
    const b = budget({ cooldownMs: 10_000 });
    expect(
      evaluateSocialBudget(
        b,
        { ...ZERO_STATE, lastSendAt: messagingNow - 5_000 },
        {
          class: "notify",
          at: messagingNow,
        },
      ),
    ).toEqual({ suppress: "cooldown_suppressed" });
    expect(
      evaluateSocialBudget(
        b,
        { ...ZERO_STATE, lastSendAt: messagingNow - 20_000 },
        {
          class: "notify",
          at: messagingNow,
        },
      ),
    ).toBe("allow");
  });

  test("class caps bound one class without capping the other", () => {
    const b = budget({ maxPerWindow: 10, classCaps: { notify: 1 } });
    expect(
      evaluateSocialBudget(
        b,
        { ...ZERO_STATE, countInWindow: 1, notifyInWindow: 1 },
        {
          class: "notify",
          at: messagingNow,
        },
      ),
    ).toEqual({ suppress: "budget_exhausted" });
    // converse is uncapped by classCaps.notify.
    expect(
      evaluateSocialBudget(
        b,
        { ...ZERO_STATE, countInWindow: 1, notifyInWindow: 1 },
        {
          class: "converse",
          at: messagingNow,
        },
      ),
    ).toBe("allow");
  });

  test("quiet hours blackout suppresses; same-day and overnight-wrap windows both hold", () => {
    // messagingNow = 5_000_000_000_000 → minute-of-day UTC.
    const minute = Math.floor(messagingNow / 60_000) % 1440;
    const sameDay = budget({
      quietHours: { startMinuteUtc: minute, endMinuteUtc: (minute + 5) % 1440 },
    });
    expect(
      evaluateSocialBudget(sameDay, ZERO_STATE, { class: "notify", at: messagingNow }),
    ).toEqual({ suppress: "cooldown_suppressed" });
    // A window that does not contain `minute` admits.
    const elsewhere = budget({
      quietHours: { startMinuteUtc: (minute + 10) % 1440, endMinuteUtc: (minute + 20) % 1440 },
    });
    expect(evaluateSocialBudget(elsewhere, ZERO_STATE, { class: "notify", at: messagingNow })).toBe(
      "allow",
    );
  });
});

describe("send kernel active-egress gate (#219 seam)", () => {
  let deliveries: string[];
  let grants: Gateway.SenderTargetGrant[];
  let budgets: Gateway.SocialBudget[];

  function expectWithoutDebit(receipt: Gateway.SendReceipt) {
    expect(receipt.kind).toBe("sent");
    expect(deliveries).toEqual(["message:test"]);
    expect(inspectDebitState("actor:sender", "actor:target").countInWindow).toBe(0);
  }

  function messaging(withGate = true) {
    return createExistingAgentMessaging({
      ...sendPorts(),
      deliver: (message: Parameters<Parameters<typeof createExistingAgentMessaging>[0]["deliver"]>[0]) => {
        deliveries.push(message.messageId);
        return { value: "accepted" as const };
      },
      grants: () => grants,
      ...(withGate ? { budgets: () => budgets } : {}),
    });
  }

  beforeEach(() => {
    resetStores();
    deliveries = [];
    grants = [buildGrant("grant:sender->target")];
    budgets = [];
    registerSenderAndTarget();
  });

  test("backward-compat: with NO budget source injected, a cold proactive send is unaffected", async () => {
    expectWithoutDebit(await runEffect(messaging(false).send(buildSendInput())));
  });

  test("fail-safe default: gate wired but no budget entry → cold proactive is the Owner's to approve, denied approval_required (#1569 lane 8)", async () => {
    const receipt = await runEffect(messaging().send(buildSendInput()));
    expectDenied(receipt, "approval_required");
    expect(deliveries).toHaveLength(0);
    expect(inspectDebitState("actor:sender", "actor:target").countInWindow).toBe(0);
  });

  test("preflight names the consent: approval_required without an active budget, nothing with one or with consent; a lapsed budget is no budget (#1569 lane 8)", () => {
    const input = buildSendInput();
    expect(messaging().preflight(input)).toBe("approval_required");
    expect(messaging().preflight({ ...input, consented: true })).toBeUndefined();
    expect(messaging(false).preflight(input)).toBeUndefined();
    budgets = [budget({ expiresAt: messagingNow - 1 })];
    expect(messaging().preflight(input)).toBe("approval_required");
    budgets = [budget({ expiresAt: messagingNow + 1 })];
    expect(messaging().preflight(input)).toBeUndefined();
  });

  test("a consented send to a target without a budget is admitted once, with no debit; consent never widens a declared budget (#1569 lane 8)", async () => {
    expectWithoutDebit(await runEffect(messaging().send(buildSendInput({ consented: true }))));
    budgets = [budget({ maxPerWindow: 1 })];
    expect((await runEffect(messaging().send(buildSendInput({ messageId: "message:budgeted", consented: true })))).kind).toBe("sent");
    expectDenied(await runEffect(messaging().send(buildSendInput({ messageId: "message:over", consented: true }))), "budget_exhausted");
  });

  test("an admitted send records a debit (record-before-act)", async () => {
    budgets = [budget()];
    const receipt = await runEffect(messaging().send(buildSendInput()));
    expect(receipt.kind).toBe("sent");
    expect(deliveries).toEqual(["message:test"]);
    const state = inspectDebitState("actor:sender", "actor:target");
    expect(state.countInWindow).toBe(1);
    expect(state.notifyInWindow).toBe(1);
    expect(state.lastSendAt).toBe(messagingNow);
  });

  test("split-evasion: the cap survives across separate send calls (debit is durable)", async () => {
    budgets = [budget({ maxPerWindow: 1 })];
    const first = await runEffect(messaging().send(buildSendInput({ messageId: "message:1" })));
    const second = await runEffect(messaging().send(buildSendInput({ messageId: "message:2" })));
    expect(first.kind).toBe("sent");
    expectDenied(second, "budget_exhausted");
    expect(deliveries).toEqual(["message:1"]);
  });

  test("cooldown-block: a second send within cooldownMs is cooldown_suppressed", async () => {
    budgets = [budget({ maxPerWindow: 10, cooldownMs: 30_000 })];
    const first = await runEffect(messaging().send(
      buildSendInput({ messageId: "message:1", at: messagingNow }),
    ));
    const second = await runEffect(messaging().send(
      buildSendInput({ messageId: "message:2", at: messagingNow + 5_000 }),
    ));
    expect(first.kind).toBe("sent");
    expectDenied(second, "cooldown_suppressed");
    // A send past the cooldown is admitted again.
    const third = await runEffect(messaging().send(
      buildSendInput({ messageId: "message:3", at: messagingNow + 40_000 }),
    ));
    expect(third.kind).toBe("sent");
    expect(deliveries).toEqual(["message:1", "message:3"]);
  });

  test("#1600 lane R2: a letter to the owner-tier Person is never outreach — no budget declared asks no consent and debits nothing; a budget the Owner declared for themselves still governs", async () => {
    const actors = ledger().stores.actors;
    actors.registerIdentity({ id: "actor:owner", kind: "human", trustTier: "owner", createdAt: messagingNow, updatedAt: messagingNow });
    actors.registerEndpoint({ id: "endpoint:owner", actorId: "actor:owner", channel: "qa", externalId: "owner-1", createdAt: messagingNow, updatedAt: messagingNow });
    grants = [buildGrant("grant:sender->owner", { targetActorId: "actor:owner" })];
    const toOwner = buildSendInput({ target: { actorId: "actor:owner" } });
    expect(messaging().preflight(toOwner)).toBeUndefined();
    expect((await runEffect(messaging().send(toOwner))).kind).toBe("sent");
    expect(deliveries).toEqual(["message:test"]);
    expect(inspectDebitState("actor:sender", "actor:owner").countInWindow).toBe(0);
    budgets = [budget({ id: "budget:owner", targetActorId: "actor:owner", doNotContact: true })];
    expectDenied(await runEffect(messaging().send(buildSendInput({ messageId: "message:owner-2", target: { actorId: "actor:owner" } }))), "dnc_denied");
    expect(deliveries).toEqual(["message:test"]);
  });

  test("DNC-deny: a do-not-contact target is denied dnc_denied with nothing delivered", async () => {
    budgets = [budget({ doNotContact: true })];
    const receipt = await runEffect(messaging().send(buildSendInput()));
    expectDenied(receipt, "dnc_denied");
    expect(deliveries).toHaveLength(0);
  });
});
