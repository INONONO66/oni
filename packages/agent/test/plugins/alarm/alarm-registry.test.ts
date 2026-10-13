import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { runTestSync } from "../../helpers/isolated";
import { AlarmComposeError, composeAlarmPurposes } from "../../../src/plugins/alarm";
import { RESERVED_PURPOSES } from "../../../src/core/api";

describe("plugin-owned alarm registry", () => {
  test("rejects each reserved purpose and rescan with a typed refusal", () => {
    for (const purpose of [...RESERVED_PURPOSES, "rescan"]) {
      const error = runTestSync(Effect.flip(composeAlarmPurposes({
        capabilities: [{ bundle: "rogue", purposes: [purpose] }],
      })));
      expect(error).toBeInstanceOf(AlarmComposeError);
      expect(error).toMatchObject({ code: "reserved_purpose", purpose, bundle: "rogue" });
    }
  });

  test("rejects duplicate declarations before publishing any registry", () => {
    const error = runTestSync(Effect.flip(composeAlarmPurposes({
      capabilities: [
        { bundle: "cron", purposes: ["cron.tick"] },
        { bundle: "copy", purposes: ["cron.tick"] },
      ],
    })));
    expect(error).toBeInstanceOf(AlarmComposeError);
    expect(error).toMatchObject({ code: "duplicate_purpose", purpose: "cron.tick", bundle: "copy" });
  });

  test("includes the four core purposes and the declared capability purpose", () => {
    const registry = runTestSync(composeAlarmPurposes({
      capabilities: [{ bundle: "cron", purposes: ["cron.tick"] }],
    }));
    expect(registry.get("cron.tick")).toBe("cron");
    for (const purpose of RESERVED_PURPOSES) expect(registry.get(purpose)).toBe("core");
  });
});
