import { expect, test } from "bun:test";
import { createElement } from "react";
import { IngressLedgerView } from "../src/renderer/ingress-ledger/view";
import { automationRenderer } from "./helpers/automation-renderer";
import { createAutomationFixture, ledgerRows } from "./helpers/automation-wire";

test("renders six decisions, evidence, distinct judge verdicts and related event links", async () => {
  const fixture = createAutomationFixture();
  const ui = automationRenderer();
  const opened: string[] = [];
  try {
    await ui.render(createElement(IngressLedgerView, { transport: fixture.transport, now: 1000, onOpenSession: (id) => opened.push(id) }));
    for (const decision of ["matched", "filtered", "refused", "deduped", "grouped", "superseded"]) {
      expect(ui.host.querySelector(`[data-decision="${decision}"]`)).not.toBeNull();
    }
    const filtered = ui.host.querySelector('[data-decision="filtered"]');
    expect(filtered?.textContent).toContain("filtered:fixture");
    expect(filtered?.textContent).toContain("channels:alerts");
    expect(filtered?.querySelector("button")).toBeNull();
    expect(ui.host.querySelector('[data-verdict="unknown"]')?.textContent).toContain("Indecisive");
    expect(ui.host.querySelector('[data-verdict="no"]')?.textContent).toContain("Rejected");
    const deduped = ui.host.querySelector('[data-decision="deduped"]');
    expect(deduped?.closest("tbody")?.querySelector('[data-decision="matched"]')).not.toBeNull();
    expect(ui.host.querySelector('[data-decision="grouped"] a')?.getAttribute("href")).toBe("#ingress-matched");
    expect(ui.host.querySelector('[data-decision="grouped"]')?.textContent).toContain("thread-1:window-600");
    await ui.click("Winning prompt · prompt-winner");
    await ui.click("Open session · action 4 · action-session");
    expect(opened).toEqual(["prompt-winner", "action-session"]);
  } finally { await ui.close(); }
});

test("filters through wire queries rather than evaluating records locally", async () => {
  const fixture = createAutomationFixture();
  const ui = automationRenderer();
  try {
    await ui.render(createElement(IngressLedgerView, { transport: fixture.transport, now: 1000, onOpenSession: () => undefined }));
    await ui.field("Surface", "discord");
    await ui.field("Record ID", "alerts");
    await ui.field("Decision", "filtered");
    await ui.submit();
    expect(fixture.requests.at(-2)).toMatchObject({ type: "automation_ledger", surface: "discord", recordId: "alerts", decision: "filtered" });
    expect(fixture.requests.at(-1)).toMatchObject({ type: "automation_ledger", surface: "discord" });
    expect(ui.host.querySelectorAll("[data-decision]")).toHaveLength(1);
    await ui.click("Clear");
    expect(ui.host.querySelectorAll("[data-decision]")).toHaveLength(7);
  } finally { await ui.close(); }
});

test("filtered relationship views retain original events and winning sessions", async () => {
  const fixture = createAutomationFixture();
  const ui = automationRenderer();
  const opened: string[] = [];
  try {
    await ui.render(createElement(IngressLedgerView, { transport: fixture.transport, now: 1000, onOpenSession: (id) => opened.push(id) }));
    await ui.field("Decision", "superseded");
    await ui.submit();
    expect(ui.host.querySelectorAll("[data-decision]")).toHaveLength(1);
    await ui.click("Winning prompt · prompt-winner");
    await ui.field("Decision", "deduped");
    await ui.submit();
    const duplicate = ui.host.querySelector('[data-decision="deduped"]');
    expect(duplicate?.closest("tbody")?.querySelector('[data-decision="matched"]')).not.toBeNull();
    await ui.field("Decision", "grouped");
    await ui.submit();
    expect(ui.host.querySelector('a[href="#ingress-matched"]')).toBeNull();
    await ui.click("Open session · action 4 · action-session");
    expect(opened).toEqual(["prompt-winner", "action-session"]);
  } finally { await ui.close(); }
});

test("superseded evidence never labels a blocked route as the winning prompt", async () => {
  const fixture = createAutomationFixture([], [
    { traceId: "blocked", inboundId: "conversation", time: 700, surface: "discord", mode: "direct", stage: "channel_ceiling", outcome: "block", sessionId: "wrong-session", reason: "blocked", factsUsed: [] },
    ...ledgerRows,
  ]);
  const ui = automationRenderer();
  const opened: string[] = [];
  try {
    await ui.render(createElement(IngressLedgerView, { transport: fixture.transport, now: 1000, onOpenSession: (id) => opened.push(id) }));
    await ui.click("Winning prompt · prompt-winner");
    expect(opened).toEqual(["prompt-winner"]);
  } finally { await ui.close(); }
});

test("disconnected and refused ledger reads expose no fabricated rows and can retry", async () => {
  const fixture = createAutomationFixture();
  const ui = automationRenderer();
  try {
    await ui.render(createElement(IngressLedgerView, { transport: null, now: 1000, onOpenSession: () => undefined }));
    expect(ui.host.querySelector('button[type="submit"]')?.hasAttribute("disabled")).toBe(true);
    expect(ui.host.querySelector("table")).toBeNull();
    fixture.refuse("store_unconfigured");
    await ui.render(createElement(IngressLedgerView, { transport: fixture.transport, now: 1000, onOpenSession: () => undefined }));
    expect(ui.host.querySelector('[role="alert"]')?.textContent).toContain("store_unconfigured");
    fixture.refuse(null);
    await ui.click("Retry");
    expect(ui.host.querySelectorAll("[data-decision]")).toHaveLength(7);
  } finally { await ui.close(); }
});

test("invalid time range issues no query and a valid empty range renders an empty state", async () => {
  const fixture = createAutomationFixture();
  const ui = automationRenderer();
  try {
    await ui.render(createElement(IngressLedgerView, { transport: fixture.transport, now: 1000, onOpenSession: () => undefined }));
    await ui.field("Since", "2026-10-13T12:00");
    await ui.field("Until", "2026-10-12T12:00");
    await ui.submit();
    expect(fixture.requests).toHaveLength(1);
    expect(ui.host.querySelector('[role="alert"]')).not.toBeNull();
    await ui.field("Until", "2026-10-14T12:00");
    await ui.submit();
    expect(ui.host.querySelector("table")).toBeNull();
    expect(ui.host.querySelector('[role="status"]')).not.toBeNull();
    expect(fixture.requests.at(-1)).toMatchObject({ since: new Date("2026-10-13T12:00").getTime(), until: new Date("2026-10-14T12:00").getTime() });
  } finally { await ui.close(); }
});
