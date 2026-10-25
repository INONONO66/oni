import { describe, expect, test } from "bun:test";
import type { LoginDeps } from "../src/cli/login";
import { login, parseLoginArgs } from "../src/cli/login";
import { telegramSignIn } from "../src/cli/telegram-login";
import { OwnerLogins } from "@oni/channels";
import { CliError } from "../src/cli/errors";

const apiHash = "a".repeat(32);
const environment = { apiId: "1234", apiHash, dataDir: "/service/.oni/telegram/owner", isTTY: true };
const signedOwner = async () => ({ userId: "owner-42" });

function refusedLogin(isTTY = true) {
  let starts = 0;
  const deps: LoginDeps = {
    logins: { ...OwnerLogins, telegram: async () => { starts += 1; return { userId: "1" }; } },
    declare: async () => { throw new Error("unexpected declaration"); },
    id: () => "req-1", telegram: { ...environment, isTTY },
  };
  return { deps, starts: () => starts };
}

function captureLogin(deps: LoginDeps) {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    run: () => login(["telegram"], deps, {
      ask: async () => { throw new Error("unexpected prompt"); },
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    }),
  };
}

describe("private Telegram login", () => {
  test("refuses every unsupported argv before a sign-in or declaration", async () => {
    for (const flags of [
      ["--print"], ["--phone", "123"], ["--code", "123"], ["--password", "secret"],
      ["--api-id", "123"], ["--api-hash", apiHash], ["extra"], ["--auto-reply"],
    ]) expect(() => parseLoginArgs(["telegram", ...flags])).toThrow();
    const { deps, starts } = refusedLogin(false);
    const out: string[] = [];
    const err: string[] = [];
    expect(await login(["telegram"], deps, {
      ask: async () => { throw new Error("unexpected prompt"); },
      stdout: (line) => out.push(line), stderr: (line) => err.push(line),
    })).toBe(1);
    expect(starts()).toBe(0);
    expect(out).toEqual([]);
    expect(err).toEqual(["Telegram login requires an interactive terminal"]);
  });

  test.each([
    [[`--api-hash=${apiHash}`], "unknown login flag: --api-hash"],
    [["--code=24680"], "unknown login flag: --code"],
    [["--password=hunter2-secret"], "unknown login flag: --password"],
    [["--code", "24680"], "unknown login flag: --code"],
    [["--password", "hunter2-secret"], "unknown login flag: --password"],
    [[apiHash], "unexpected login argument"],
    [["--0123456789abcdef"], "unexpected login argument"],
  ] as const)("a rejected argv %j never echoes its value", async (flags, first) => {
    const { deps, starts } = refusedLogin();
    const errors: string[] = [];
    expect(await login(["telegram", ...flags], deps, {
      ask: async () => { throw new Error("unexpected prompt"); },
      stdout: () => { throw new Error("unexpected output"); }, stderr: (line) => errors.push(line),
    })).toBe(1);
    expect(starts()).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.split("\n")[0]).toBe(first);
    for (const secret of [apiHash, "24680", "hunter2-secret", "0123456789abcdef"])
      expect(errors[0]).not.toContain(secret);
  });

  test.each([
    ["refused", "channel_add refused (owner_only): Denied"],
    ["unreachable", "daemon socket unavailable"],
  ] as const)("Telegram %s seal failure prints no credential", async (kind, expected) => {
    const deps: LoginDeps = {
      logins: { ...OwnerLogins, telegram: async ({ credentials, dataDir }) => {
        expect(dataDir).toBe(environment.dataDir);
        expect(credentials).toEqual({ apiId: "1234", apiHash });
        return { userId: "owner-42" };
      } },
      declare: async (request) => {
        expect(request.credential).toEqual({ apiId: "1234", apiHash });
        if (kind === "unreachable") throw new CliError("daemon socket unavailable");
        return { type: "channel_add_refused", requestId: request.requestId,
          reason: "owner_only" as const, detail: "Denied" };
      },
      id: () => "req-1", telegram: environment,
    };
    const { output, errors, run } = captureLogin(deps);
    expect(await run()).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toEqual([expected]);
    expect(JSON.stringify(errors)).not.toContain(apiHash);
  });

  test("a sealed Telegram declaration reports the verified account without its credential", async () => {
    const deps: LoginDeps = {
      logins: { ...OwnerLogins, telegram: signedOwner },
      declare: async (request) => ({
        type: "channel_declared", requestId: request.requestId, id: request.id,
        statuses: [{ id: request.id, surface: "telegram:owner", state: "mounted" }],
      }),
      id: () => "req-1", telegram: environment,
    };
    const { output, errors, run } = captureLogin(deps);
    expect(await run()).toBe(0);
    expect(errors).toEqual([]);
    expect(output).toEqual([
      "Signed in to Telegram as owner-42",
      "channel:telegram:owner [telegram:owner] → mounted",
    ]);
    expect(JSON.stringify(output)).not.toContain(apiHash);
  });

  test("prompts absent credentials and every sign-in action in secret mode", async () => {
    const asked: string[] = [];
    const actions = ["phone", "code", "password", "email", "email_code"] as const;
    const signed = await telegramSignIn(async ({ credentials, prompt }) => {
      expect(credentials).toEqual({ apiId: "1234", apiHash });
      for (const action of actions) await prompt(action);
      return { userId: "owner-42" };
    }, { dataDir: environment.dataDir, isTTY: true }, async (question, options) => {
      asked.push(`${question}:${options?.secret === true}`);
      return question === "Telegram API id" ? "1234" :
        question === "Telegram API hash" ? apiHash : "answer";
    });
    expect(signed.userId).toBe("owner-42");
    expect(asked).toEqual([
      "Telegram API id:false", "Telegram API hash:true", "Phone number:true",
      "Telegram code:true", "Telegram password:true", "Email address:true", "Email code:true",
    ]);
  });

  test("rejects malformed supplied environment without prompting or opening SDK", async () => {
    let opened = false;
    await expect(telegramSignIn(async () => { opened = true; return { userId: "1" }; },
      { ...environment, apiId: "0" }, async () => { throw new Error("should not prompt"); },
    )).rejects.toThrow("Invalid Telegram API credentials");
    expect(opened).toBe(false);
  });
});
