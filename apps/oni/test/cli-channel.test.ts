import { describe, expect, test } from "bun:test";
import type { Provisioning } from "@oni/protocol";
import { askCredential, CHANNEL_ADD_USAGE, channelAdd, channelDeclaration, parseChannelAddArgs } from "../src/cli/channel";
import { CliError } from "../src/cli/errors";
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

function io(answers: Readonly<Record<string, string>>) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  return { out, err, asked, io: { ask: asking(answers, asked), stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) } };
}

function declaring(declared: Provisioning.ChannelDeclareRequest[], state = "mounted") {
  return {
    declare: async (request: Provisioning.ChannelDeclareRequest): Promise<Provisioning.ChannelDeclareResponse> => {
      declared.push(request);
      return { type: "channel_declared", requestId: request.requestId, id: request.id, statuses: [{ id: request.id, surface: `${request.provider}:${request.identity ?? "bot"}`, state }] };
    },
    id: () => "request-1",
  };
}

describe("oni channel add (#1600 lane R4)", () => {
  test("parses the platform and its flags; the Owner-account flags belong to Linear alone; anything else names the usage", () => {
    expect(parseChannelAddArgs(["slack"])).toEqual({
      provider: "slack", instanceId: "channel:slack:main", identity: "bot", mentionOnly: false, outbound: false, autoReply: false, print: false,
    });
    expect(parseChannelAddArgs(["slack", "--id", "channel:slack:work", "--tier", "manager", "--allow", "T1:U1, T1:U2", "--mention-only", "--print"])).toEqual({
      provider: "slack", instanceId: "channel:slack:work", identity: "bot", tier: "manager", allow: ["T1:U1", "T1:U2"], mentionOnly: true, outbound: false, autoReply: false, print: true,
    });
    expect(parseChannelAddArgs(["linear", "--intake", "all", "--outbound", "--auto-reply"])).toEqual({
      provider: "linear", instanceId: "channel:linear:owner", identity: "owner", intake: "all", mentionOnly: false, outbound: true, autoReply: true, print: false,
    });
    for (const args of [[], ["matrix"], ["slack", "--tier", "god"], ["slack", "--allow", " , "], ["slack", "--id"], ["slack", "--bogus"], ["slack", "--outbound"], ["slack", "--intake", "all"], ["linear", "--auto-reply"], ["linear", "--intake", "loud"], ["a2a", "--tier", "manager"], ["a2a", "--allow", "x"], ["a2a", "--mention-only"]]) {
      expect(() => parseChannelAddArgs(args)).toThrow(CliError);
    }
    expect(() => parseChannelAddArgs(["matrix"])).toThrow(CHANNEL_ADD_USAGE);
    expect(() => parseChannelAddArgs(["a2a", "--tier", "manager"])).toThrow("a peer row takes no grant block");
    expect(parseChannelAddArgs(["a2a", "--id", "channel:a2a:scout"])).toMatchObject({ provider: "a2a", instanceId: "channel:a2a:scout", identity: "bot" });
  });

  test("asks for each credential the arm admits, tokens and secrets never echoed, an optional one left blank not sent", async () => {
    const asked: string[] = [];
    expect(await askCredential("github", asking({ "github secret": "hook-secret", "github token": "", "github botUsername": "omni-bot" }, asked))).toEqual({ secret: "hook-secret", botUsername: "omni-bot" });
    expect(asked).toEqual(["github secret [secret]", "github token (optional) [secret]", "github botUsername (optional)"]);
    expect(await askCredential("slack", asking({ botToken: "xoxb-1", appToken: "xapp-1" }))).toEqual({ botToken: "xoxb-1", appToken: "xapp-1" });
    expect(await askCredential("webhook", asking({ "webhook id": "hooky", "webhook secret": "s", "webhook url": "https://example.test/hook" }))).toEqual({ id: "hooky", secret: "s", url: "https://example.test/hook" });
    expect(await askCredential("nowhere", asking({}))).toEqual({});
  });

  test("the declaration carries the grant block only when a field was given, and Linear's Owner posture", () => {
    expect(channelDeclaration(parseChannelAddArgs(["telegram"]), { token: "t" }, "r-1")).toEqual({
      type: "channel_add", requestId: "r-1", id: "channel:telegram:main", provider: "telegram", identity: "bot", credential: { token: "t" },
    });
    expect(channelDeclaration(parseChannelAddArgs(["discord", "--tier", "collaborator", "--mention-only"]), { token: "t" }, "r-2")).toMatchObject({
      grant: { defaultTier: "collaborator", mentionOnly: true },
    });
    expect(channelDeclaration(parseChannelAddArgs(["linear", "--outbound"]), { secret: "s", token: "lin" }, "r-3")).toEqual({
      type: "channel_add", requestId: "r-3", id: "channel:linear:owner", provider: "linear", identity: "owner", settings: { intake: "mentions_and_dms", autoReply: false }, outbound: true, credential: { secret: "s", token: "lin" },
    });
  });

  test("declares over the Owner's socket and reports the row's own status; --print shows the declaration instead; a refusal and a bad command line exit 1", async () => {
    const declared: Provisioning.ChannelDeclareRequest[] = [];
    const mounted = io({ botToken: "xoxb-1", appToken: "xapp-1" });
    expect(await channelAdd(["slack", "--tier", "manager", "--allow", "T1:U1"], declaring(declared), mounted.io)).toBe(0);
    expect(declared).toEqual([{
      type: "channel_add", requestId: "request-1", id: "channel:slack:main", provider: "slack", identity: "bot",
      grant: { defaultTier: "manager", allowedSenders: ["T1:U1"] }, credential: { botToken: "xoxb-1", appToken: "xapp-1" },
    }]);
    expect(mounted.out).toEqual(["channel:slack:main [slack:bot] → mounted"]);
    expect(mounted.asked).toEqual(["slack botToken [secret]", "slack appToken [secret]"]);

    const printed = io({ token: "tg-token" });
    expect(await channelAdd(["telegram", "--print"], declaring([]), printed.io)).toBe(0);
    expect(printed.out).toEqual([JSON.stringify({ id: "channel:telegram:main", provider: "telegram", identity: "bot", credential: { token: "tg-token" } })]);

    const failed = io({ token: "tg-token" });
    expect(await channelAdd(["telegram"], declaring([], "credential_invalid"), failed.io)).toBe(1);
    expect(failed.out).toEqual(["channel:telegram:main [telegram:bot] → credential_invalid"]);

    const refused = io({ token: "tg-token" });
    expect(await channelAdd(["telegram"], {
      declare: async (request) => ({ type: "channel_add_refused", requestId: request.requestId, reason: "refused", detail: "channel_add refused: tier takes consent" }),
      id: () => "request-2",
    }, refused.io)).toBe(1);
    expect(refused.err).toEqual(["channel_add refused (refused): channel_add refused: tier takes consent"]);

    const unreachable = io({ token: "tg-token" });
    expect(await channelAdd(["telegram"], { declare: () => Promise.reject(new CliError("no daemon at ws://127.0.0.1:3000/ws")), id: () => "r" }, unreachable.io)).toBe(1);
    expect(unreachable.err).toEqual(["no daemon at ws://127.0.0.1:3000/ws", "nothing was sealed; start the daemon and run channel add again"]);

    const usage = io({});
    expect(await channelAdd(["slack", "--outbound"], declaring([]), usage.io)).toBe(1);
    expect(usage.err[0]).toContain("describe the Owner's own account");
  });
});
