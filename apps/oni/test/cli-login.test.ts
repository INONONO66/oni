import { describe, expect, test } from "bun:test";
import type { Provisioning } from "@oni/protocol";
import { CliError } from "../src/cli/errors";
import { LOGIN_USAGE, type LoginDeps, login, parseLoginArgs, signIn } from "../src/cli/login";
import type { AskOptions } from "../src/cli/onboard";

/** Scripted answers by prompt substring, each prompt recorded (secret ones marked); an unknown prompt is a test failure. */
function asking(answers: Readonly<Record<string, string>>, asked: string[] = []) {
  return async (question: string, options?: AskOptions): Promise<string> => {
    asked.push(options?.secret === true ? `${question} [secret]` : question);
    const match = Object.entries(answers).find(([key]) => question.includes(key));
    if (match === undefined) throw new Error(`unexpected prompt: ${question}`);
    return match[1];
  };
}

function deps(overrides: Partial<LoginDeps> = {}, declared: Provisioning.ChannelDeclareRequest[] = []): LoginDeps {
  return {
    logins: {
      slack: async ({ qrImage, confirm }) => {
        const code = await confirm?.({ email: "owner@example.com", type: "email" });
        return { token: `xoxc-${qrImage}`, cookie: `d-${code ?? "none"}`, workspace: "acme" };
      },
      discord: async ({ showQr }) => {
        await showQr("https://discord.com/ra/qr");
        return { token: "user-token", userId: "U1", username: "ino" };
      },
      instagram: async ({ username, twoFactorCode, challengeCode }) => ({
        session: JSON.stringify({ user: username, code: await twoFactorCode(), challenge: await challengeCode({ contactPoint: "o***" }) }),
      }),
      kakaotalk: async ({ email, onPasscode }) => {
        onPasscode("4821");
        return { oauthToken: `oauth-${email}`, userId: "1001", deviceUuid: "dev-1", deviceType: "tablet" };
      },
    },
    declare: async (request) => {
      declared.push(request);
      return { type: "channel_declared", requestId: request.requestId, id: request.id, statuses: [{ id: request.id, surface: `${request.provider}:owner`, state: "mounted" }] };
    },
    id: () => "request-1",
    ...overrides,
  };
}

describe("oni login (#1569 lane 5b)", () => {
  test("parses the platform and its flags; anything else names the usage", () => {
    expect(parseLoginArgs(["slack"])).toEqual({
      platform: "slack", instanceId: "channel:slack:owner", intake: "mentions_and_dms", outbound: false, autoReply: false, print: false,
    });
    expect(parseLoginArgs(["kakaotalk", "--id", "channel:kakaotalk:me", "--intake", "all", "--outbound", "--auto-reply", "--print"])).toEqual({
      platform: "kakaotalk", instanceId: "channel:kakaotalk:me", intake: "all", outbound: true, autoReply: true, print: true,
    });
    for (const args of [[], ["telegram"], ["slack", "--intake", "loud"], ["slack", "--id"], ["slack", "--bogus"], ["slack", "--auto-reply"]]) {
      expect(() => parseLoginArgs(args)).toThrow(CliError);
    }
    expect(() => parseLoginArgs(["telegram"])).toThrow(LOGIN_USAGE);
  });

  test("each platform's sign-in asks only what it needs and returns the Owner arm's credential payload", async () => {
    const out: string[] = [];
    const asked: string[] = [];
    const io = {
      ask: asking({ "Copy Image Address": "data:image/png;base64,QR", "Confirmation code": "123456", "Instagram username": "ino", "Instagram password": "pw", "two-factor": "222333", "Code Instagram sent": "777", "account email": "ino@example.com", "KakaoTalk password": "kpw" }, asked),
      stdout: (line: string) => out.push(line),
    };
    expect(await signIn("slack", deps(), io)).toEqual({ token: "xoxc-data:image/png;base64,QR", cookie: "d-123456" });
    expect(await signIn("discord", deps(), io)).toEqual({ token: "user-token" });
    expect(await signIn("instagram", deps(), io)).toEqual({ session: JSON.stringify({ user: "ino", code: "222333", challenge: "777" }) });
    expect(await signIn("kakaotalk", deps(), io)).toEqual({ oauthToken: "oauth-ino@example.com", userId: "1001", deviceUuid: "dev-1", deviceType: "tablet" });
    expect(out).toEqual([
      "Signed in to Slack workspace acme",
      "Open Discord on your phone and scan: https://discord.com/ra/qr",
      "Signed in to Discord as ino",
      "Signed in to Instagram as ino",
      "Enter this passcode in KakaoTalk on your phone: 4821",
      "Signed in to KakaoTalk as user 1001",
    ]);
    // Secrets never echo: the QR image address and the passwords are asked for as secrets.
    expect(asked.filter((question) => question.endsWith("[secret]"))).toEqual([
      "In Slack: your name (top-left) → Sign in on mobile → right-click the QR → Copy Image Address; paste it here [secret]",
      "Instagram password [secret]",
      "KakaoTalk password [secret]",
    ]);
  });

  test("a declaration the daemon cannot take after the sign-in shows the payload instead of losing it; a failed sign-in declares nothing", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { ask: asking({}), stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) };
    const unreachable = deps({ declare: () => Promise.reject(new CliError("no daemon answered at ws://127.0.0.1:1/ws")) });
    expect(await login(["discord"], unreachable, io)).toBe(1);
    expect(err).toEqual([
      "no daemon answered at ws://127.0.0.1:1/ws",
      "the sign-in completed but nothing was sealed; start the daemon and run login again, or declare this payload through the Resident:",
    ]);
    expect(JSON.parse(out.at(-1) ?? "{}")).toEqual({ provider: "discord", identity: "owner", credential: { token: "user-token" } });
    const declared: Provisioning.ChannelDeclareRequest[] = [];
    const failing = deps({ logins: { ...deps().logins, discord: () => Promise.reject(new Error("remote auth timed out")) } }, declared);
    err.length = 0;
    expect(await login(["discord"], failing, io)).toBe(1);
    expect(err).toEqual(["sign-in failed: remote auth timed out"]);
    expect(declared).toEqual([]);
  });

  test("the declared instance's own status decides the exit; the daemon's other instances are not reported", async () => {
    const out: string[] = [];
    const io = { ask: asking({}), stdout: (line: string) => out.push(line), stderr: () => undefined };
    const answering = (own: { readonly state: string; readonly detail?: string }) =>
      deps({
        declare: async (request) => ({
          type: "channel_declared",
          requestId: request.requestId,
          id: request.id,
          statuses: [
            { id: "channel:telegram:main", surface: "telegram", state: "mounted" },
            { id: request.id, surface: `${request.provider}:owner`, ...own },
          ],
        }),
      });
    expect(await login(["discord"], answering({ state: "mounted" }), io)).toBe(0);
    expect(out).toEqual([
      "Open Discord on your phone and scan: https://discord.com/ra/qr",
      "Signed in to Discord as ino",
      "channel:discord:owner [discord:owner] → mounted",
    ]);
    out.length = 0;
    expect(await login(["discord"], answering({ state: "start_failed", detail: "RTM refused" }), io)).toBe(1);
    expect(out.at(-1)).toBe("channel:discord:owner [discord:owner] → start_failed (RTM refused)");
    // A daemon that answers without the declared instance's own line has not mounted it: nonzero, named.
    const err: string[] = [];
    const silent = deps({
      declare: async (request) => ({
        type: "channel_declared",
        requestId: request.requestId,
        id: request.id,
        statuses: [{ id: "channel:telegram:main", surface: "telegram", state: "mounted" }],
      }),
    });
    expect(await login(["discord"], silent, { ...io, stderr: (line: string) => err.push(line) })).toBe(1);
    expect(err).toEqual(["the daemon reported no status for channel:discord:owner"]);
  });

  test("declares the Owner instance over the Owner's socket with the posture the flags name, and reports every status", async () => {
    const declared: Provisioning.ChannelDeclareRequest[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const io = { ask: asking({ "account email": "ino@example.com", "KakaoTalk password": "kpw" }), stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) };
    expect(await login(["kakaotalk", "--outbound", "--auto-reply", "--intake", "all"], deps({}, declared), io)).toBe(0);
    expect(declared).toEqual([
      {
        type: "channel_add",
        requestId: "request-1",
        id: "channel:kakaotalk:owner",
        provider: "kakaotalk",
        identity: "owner",
        settings: { intake: "all", autoReply: true },
        outbound: true,
        credential: { oauthToken: "oauth-ino@example.com", userId: "1001", deviceUuid: "dev-1", deviceType: "tablet" },
      },
    ]);
    expect(out.at(-1)).toBe("channel:kakaotalk:owner [kakaotalk:owner] → mounted");
    expect(err).toEqual([]);
  });

  test("a refused declaration is reported on stderr with its reason, and exits nonzero", async () => {
    const err: string[] = [];
    const io = { ask: asking({ "Copy Image Address": "data:image/png;base64,QR", "Confirmation code": "1" }), stdout: () => undefined, stderr: (line: string) => err.push(line) };
    const refusing = deps({
      declare: async (request) => ({ type: "channel_add_refused", requestId: request.requestId, reason: "owner_only", detail: "only the Owner's socket declares a channel" }),
    });
    expect(await login(["slack"], refusing, io)).toBe(1);
    expect(err).toEqual(["channel_add refused (owner_only): only the Owner's socket declares a channel"]);
  });

  test("--print shows the payload for an Owner declaring through the Resident, and declares nothing", async () => {
    const declared: Provisioning.ChannelDeclareRequest[] = [];
    const out: string[] = [];
    const io = { ask: asking({}), stdout: (line: string) => out.push(line), stderr: () => undefined };
    expect(await login(["discord", "--print"], deps({}, declared), io)).toBe(0);
    expect(declared).toEqual([]);
    expect(JSON.parse(out.at(-1) ?? "{}")).toEqual({ provider: "discord", identity: "owner", credential: { token: "user-token" } });
  });
});
