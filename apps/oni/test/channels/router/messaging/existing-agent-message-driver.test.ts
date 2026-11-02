import { describe, expect, spyOn, test } from "bun:test";

import { z } from "zod";
import { runExistingAgentMessageDriver } from "../../harness/existing-agent-message-driver.js";

/**
 * Manual QA driver scenarios via direct invocation (#215). The driver runs
 * under its own Bus/Storage isolation, so these tests assert the exact JSON
 * receipt contract the issue pins.
 */

describe("existing-agent-message-driver", () => {
  test("restart-quorum resolves a persisted 2-of-3 request for the original owner without allocation", async () => {
    const result = await runExistingAgentMessageDriver(["--scenario", "restart-quorum", "--json"]);

    expect(result.exitCode).toBe(0);
    const receipt = z
      .object({
        resultCode: z.string(),
        allocationDelta: z.number(),
        sessionId: z.string(),
        requestState: z.string(),
        resolutionActions: z.array(z.object({ requestId: z.string(), sessionId: z.string() })),
        fireAndForget: z.object({ outcome: z.string(), requestCountAfterSend: z.number() }),
        restart: z.object({
          storageReopened: z.boolean(),
          stateAtRestart: z.string(),
          repliesPersistedAcrossRestart: z.number(),
        }),
        deliveries: z.array(
          z.object({ messageId: z.string(), operation: z.string(), endpointId: z.string() }),
        ),
      })
      .parse(JSON.parse(result.stdout));
    expect(receipt.resultCode).toBe("restart_quorum_resolved");
    expect(receipt.allocationDelta).toBe(0);
    expect(receipt.sessionId).toBe("session:qa-owner");
    expect(receipt.requestState).toBe("resolved");
    expect(receipt.resolutionActions).toHaveLength(1);
    expect(receipt.resolutionActions[0]).toMatchObject({
      requestId: "request:qa:briefing",
      sessionId: "session:qa-owner",
    });
    expect(receipt.fireAndForget).toEqual({ outcome: "sent", requestCountAfterSend: 0 });
    expect(receipt.restart).toEqual({
      storageReopened: true,
      stateAtRestart: "open",
      repliesPersistedAcrossRestart: 1,
    });
    expect(receipt.deliveries).toHaveLength(2);
  });

  test("duplicate-ambiguous observes both typed denials with unchanged quorum and no Child", async () => {
    const result = await runExistingAgentMessageDriver([
      "--scenario",
      "duplicate-ambiguous",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const receipt = z
      .object({
        resultCode: z.string(),
        allocationDelta: z.number(),
        childAllocated: z.boolean(),
        denials: z.array(z.object({ plane: z.string(), code: z.string() })),
        quorum: z.object({
          unchanged: z.boolean(),
          after: z.object({
            state: z.string(),
            replies: z.number(),
            responders: z.number(),
            threshold: z.number(),
          }),
        }),
      })
      .parse(JSON.parse(result.stdout));
    expect(receipt.resultCode).toBe("duplicate_and_ambiguous_denied");
    expect(receipt.denials).toEqual([
      { plane: "reply", code: "duplicate" },
      { plane: "correlation", code: "ambiguous" },
      { plane: "messaging", code: "target_ambiguous" },
    ]);
    expect(receipt.quorum.unchanged).toBe(true);
    expect(receipt.quorum.after).toEqual({
      state: "open",
      replies: 1,
      responders: 1,
      threshold: 2,
    });
    expect(receipt.childAllocated).toBe(false);
    expect(receipt.allocationDelta).toBe(0);
  });

  test("scenario runs are deterministic — identical receipts on repeat invocation", async () => {
    const first = await runExistingAgentMessageDriver([
      "--scenario",
      "duplicate-ambiguous",
      "--json",
    ]);
    const second = await runExistingAgentMessageDriver([
      "--scenario",
      "duplicate-ambiguous",
      "--json",
    ]);

    expect(first.stdout).toBe(second.stdout);
  });

  test("help exits successfully without running a scenario", async () => {
    const result = await runExistingAgentMessageDriver(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  test.each([
    [new Error("serialization fault"), "Error"],
    ["serialization fault", "NonError"],
  ] as const)("converts an unexpected %s into the driver error receipt", async (fault: Error | string, errorType: "Error" | "NonError") => {
    const stringify = spyOn(JSON, "stringify").mockImplementationOnce(() => {
      throw fault;
    });

    try {
      const result = await runExistingAgentMessageDriver(["invalid"]);

      expect(result.exitCode).toBe(1);
      expect(
        z
          .object({ mode: z.string(), resultCode: z.string(), errorType: z.string() })
          .parse(JSON.parse(result.stdout)),
      ).toMatchObject({
        mode: "driver_error",
        resultCode: "driver_threw",
        errorType,
      });
    } finally {
      stringify.mockRestore();
    }
  });

  test("invalid arguments exit nonzero with the typed invalid_arguments result", async () => {
    const result = await runExistingAgentMessageDriver(["--scenario", "unknown", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(z.object({ resultCode: z.string() }).parse(JSON.parse(result.stdout)).resultCode).toBe(
      "invalid_arguments",
    );
  });
});
