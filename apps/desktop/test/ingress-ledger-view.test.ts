import { expect, test } from "bun:test";
import { createElement } from "react";
import { z } from "zod";
import { Ingress } from "@openomni/protocol";
import { IngressLedgerView } from "../src/renderer/ingress-ledger/view";
import { LedgerRows } from "../src/renderer/ingress-ledger/rows";
import { automationRenderer } from "./helpers/automation-renderer";
import { createAutomationFixture, ledgerRows } from "./helpers/automation-wire";

test("stored superseded decision links to the winning prompt without a routing row", async () => {
  const fixtureUrl = new URL("../../../packages/channels/test/router/_router-fixture.ts", import.meta.url);
  const ledgerUrl = new URL("../../../packages/channels/test/helpers/ledger.ts", import.meta.url);
  const effectUrl = new URL("../../../packages/channels/test/helpers/effect.ts", import.meta.url);
  const protocolUrl = new URL("../../../packages/protocol/dist/index.js", import.meta.url);
  const producer = Bun.spawn([process.execPath, "-e", `
    import { makeRouter, ownerFacts, ownerSender, registerOwnerDm, resetRouterState } from "${fixtureUrl}";
    import { ledger } from "${ledgerUrl}";
    import { runEffect } from "${effectUrl}";
    import { Ingress } from "${protocolUrl}";
    resetRouterState();
    registerOwnerDm();
    ledger().stores.automations.add(Ingress.Automation.parse({
      id: "notify", name: "Notify", enabled: true, createdBy: "owner",
      triggers: [{ type: "message", surface: ownerFacts.surface, event: "message" }],
      target: "session:worker", kind: "action",
    }));
    const result = await runEffect(makeRouter().ingest(ownerSender, ownerFacts));
    if (result.status !== "executed") throw new Error("Expected prompt delivery");
    console.log(JSON.stringify({ target: result.handle.target, rows: ledger().stores.automations.ledger({ limit: 20 }) }));
  `], { cwd: new URL("../../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    producer.exited, new Response(producer.stdout).text(), new Response(producer.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  const { target, rows } = z.object({
    target: z.string(), rows: Ingress.Events.RoutingDecision.schema.array(),
  }).parse(JSON.parse(stdout));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ decision: "superseded", target: `session:${target}` });
  const ui = automationRenderer();
  const opened: string[] = [];
  try {
    await ui.render(createElement(LedgerRows, { rows, related: rows, now: 1000, onOpenSession: (id) => opened.push(id) }));
    await ui.click(`Winning prompt · ${target}`);
    expect(opened).toEqual([target]);
  } finally { await ui.close(); }
});

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
    expect(filtered?.textContent).toContain("channels");
    expect(filtered?.querySelector("button")).toBeNull();
    expect(ui.host.querySelector('[data-verdict="unknown"]')?.textContent).toContain("Indecisive");
    expect(ui.host.querySelector('[data-verdict="no"]')?.textContent).toContain("Rejected");
    const deduped = ui.host.querySelector('[data-decision="deduped"]');
    expect(deduped?.closest("tbody")?.querySelector('[data-decision="matched"]')).not.toBeNull();
    expect(ui.host.querySelector('[data-decision="grouped"] a')?.getAttribute("href")).toBe("#ingress-matched");
    expect(ui.host.querySelector('[data-decision="grouped"] a')?.textContent).toBe("matched");
    expect(ui.host.querySelector('[data-decision="grouped"]')?.textContent).toContain('["alerts","thread-1","grouped"]');
    expect(ui.host.querySelector('[data-decision="grouped"]')?.textContent).toContain("gateway-message-42");
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
    expect(ui.host.querySelectorAll("[data-decision]")).toHaveLength(6);
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

test("superseded evidence without a winning session offers no prompt link", async () => {
  const fixture = createAutomationFixture([], ledgerRows.map((row) =>
    row.stage === "automation" && row.decision === "superseded" ? { ...row, target: undefined } : row));
  const ui = automationRenderer();
  const opened: string[] = [];
  try {
    await ui.render(createElement(IngressLedgerView, { transport: fixture.transport, now: 1000, onOpenSession: (id) => opened.push(id) }));
    expect(ui.host.querySelector('[data-decision="superseded"] button')).toBeNull();
    expect(opened).toEqual([]);
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
    expect(ui.host.querySelectorAll("[data-decision]")).toHaveLength(6);
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
