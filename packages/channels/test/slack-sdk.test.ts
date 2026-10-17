import { describe, expect, test } from "bun:test";
import { SlackBotClient, SlackBotListener } from "agent-messenger/slackbot";
import {
  classifySlackFailure,
  isSettledState,
  isSlackTerminal,
  singleAttempt,
  SlackBotError,
  slackSdk,
} from "../src/provider/slack/sdk";
import { SlackApiError } from "../src/errors";
import { CustodySlackBotClient, type InnerWebClient, type SlackBotApi } from "../src/provider/slack/sdk";
import { FakeSlackClient } from "./helpers/slack-sdk";

/** The runtime shape of the SDK client's private `@slack/web-api` instance, as the tests reach it. */
interface Inner {
  retryConfig: { readonly retries?: number };
  rejectRateLimitedCalls: boolean;
  chat: { postMessage: (args: object) => Promise<object> };
  conversations: { open: (args: object) => Promise<object> };
  apps: { connections: { open: (args: object) => Promise<object> } };
}
function innerOf(client: object): Inner {
  return (client as { client: Inner }).client;
}

/** The seam's client is the real SDK class; the test reaches the SDK's own members through it. */
function sdkClientOf(client: SlackBotApi): SlackBotApi & SlackBotClient {
  if (!(client instanceof SlackBotClient)) throw new Error("the seam builds the SDK client");
  return client;
}

/** The rejection of a call the test expects to fail. */
async function rejection<T>(call: Promise<T>): Promise<Error> {
  try {
    await call;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected a rejection");
}

/**
 * Pins the SDK facts this surface relies on (#1569): the real client exposes
 * the inner web client `singleAttempt` reconfigures, the seam's extra calls
 * ride that same pinned client, the real listener is constructible without
 * I/O and reports a fatal code, and the failure classification reads the
 * `@slack/web-api` codes the SDK forwards.
 */
describe("agent-messenger slack bot SDK seam", () => {
  test("the real SDK client is pinned to one attempt after login (no I/O)", async () => {
    const client = new SlackBotClient();
    await client.login({ token: "xoxb-offline" });
    singleAttempt(client);
    const inner = innerOf(client);
    expect(inner.retryConfig).toEqual({ retries: 0 });
    expect(inner.rejectRateLimitedCalls).toBe(true);
  });

  test("pinning before login is a typed refusal", () => {
    expect(() => singleAttempt(new SlackBotClient())).toThrow(SlackApiError);
  });

  test("the default seam builds the real client and listener", () => {
    const sdk = slackSdk();
    const client = sdk.client();
    expect(client).toBeInstanceOf(SlackBotClient);
    expect(sdk.listener(client, { appToken: "xapp-offline" })).toBeInstanceOf(SlackBotListener);
  });

  test("the seam's listener takes only the client the seam built", () => {
    expect(() => slackSdk().listener(new FakeSlackClient(), { appToken: "xapp-offline" })).toThrow(
      SlackApiError,
    );
  });

  test("the seam's socket-url fetch builds the app token its own pinned web client — the bot client's Authorization header answered invalid_auth on the first live run (#1600)", async () => {
    const client = slackSdk().client();
    await client.login({ token: "xoxb-offline" });
    singleAttempt(client);
    if (!(client instanceof CustodySlackBotClient)) throw new Error("the seam builds the custody client");
    const inner = innerOf(client);
    // The default seam: the same `@slack/web-api` class as the bot client, the app token as its own token, pinned alike.
    const app = client.appClient("xapp-offline");
    expect(app).not.toBe(inner);
    expect(app).toBeInstanceOf(inner.constructor);
    expect(app.token).toBe("xapp-offline");
    expect(app.retryConfig).toEqual({ retries: 0 });
    expect(app.rejectRateLimitedCalls).toBe(true);
    expect(inner.retryConfig).toEqual({ retries: 0 });
  });

  test("the seam's socket-url fetch rides the app token's client, and its refusals carry the Slack error string", async () => {
    const client = slackSdk().client();
    await client.login({ token: "xoxb-offline" });
    singleAttempt(client);
    if (!(client instanceof CustodySlackBotClient)) throw new Error("the seam builds the custody client");
    const inner = innerOf(client);
    const built: string[] = [];
    const opens: number[] = [];
    const app: InnerWebClient = {
      conversations: { open: async () => ({ ok: false, error: "never" }) },
      apps: {
        connections: {
          open: async () => {
            opens.push(opens.length + 1);
            return { ok: true, url: "wss://socket.example/one" };
          },
        },
      },
    };
    client.appClient = (appToken) => {
      built.push(appToken);
      return app;
    };
    // The bot client's own `apps.connections.open` is never the one called.
    inner.apps.connections.open = async () => {
      throw new Error("the bot client must not fetch the socket url");
    };
    const sdkClient = sdkClientOf(client);
    expect(await sdkClient.appsConnectionsOpen("xapp-offline")).toEqual({
      url: "wss://socket.example/one",
    });
    expect(built).toEqual(["xapp-offline"]);
    expect(opens).toEqual([1]);
    // `@slack/web-api` throws a platform refusal (it never resolves `ok: false`);
    // the seam forwards the Slack error string as the code the SDK's fatal set reads.
    app.apps.connections.open = async () => {
      throw Object.assign(new Error("An API error occurred: invalid_auth"), {
        code: "slack_webapi_platform_error",
        data: { ok: false, error: "invalid_auth" },
      });
    };
    const refused = await rejection(sdkClient.appsConnectionsOpen("xapp-offline"));
    expect(refused).toBeInstanceOf(SlackBotError);
    expect(refused).toMatchObject({
      code: "invalid_auth",
      message: "An API error occurred: invalid_auth",
    });
    expect(isSlackTerminal(refused)).toBe(true);
    // A network failure keeps its web-api code: not fatal, the SDK reopens.
    app.apps.connections.open = async () => {
      throw Object.assign(new Error("A request error occurred: getaddrinfo ENOTFOUND"), {
        code: "slack_webapi_request_error",
      });
    };
    const offline = await rejection(sdkClient.appsConnectionsOpen("xapp-offline"));
    expect(offline).toMatchObject({ code: "slack_webapi_request_error" });
    expect(isSlackTerminal(offline)).toBe(false);
    // The defensive arm for a resolved refusal.
    app.apps.connections.open = async () => ({ ok: false, error: "invalid_auth" });
    await expect(sdkClient.appsConnectionsOpen("xapp-offline")).rejects.toMatchObject({
      code: "invalid_auth",
    });
  });

  test("the seam opens the bot's direct channel through the pinned inner client", async () => {
    const client = slackSdk().client();
    await client.login({ token: "xoxb-offline" });
    const inner = innerOf(client);
    const opens: object[] = [];
    inner.conversations.open = async (args) => {
      opens.push(args);
      return { ok: true, channel: { id: "D-real" } };
    };
    expect(await client.openDm("U5")).toBe("D-real");
    expect(opens).toEqual([{ users: "U5" }]);
    inner.conversations.open = async () => {
      throw Object.assign(new Error("An API error occurred: user_not_found"), {
        code: "slack_webapi_platform_error",
        data: { ok: false, error: "user_not_found" },
      });
    };
    const refused = await rejection(client.openDm("U5"));
    expect(refused).toBeInstanceOf(SlackBotError);
    expect(refused).toMatchObject({
      code: "slack_webapi_platform_error",
      message: "An API error occurred: user_not_found",
    });
    expect(classifySlackFailure(refused)).toBe("rejected");
    inner.conversations.open = async () => {
      throw Object.assign(new Error("A request error occurred: read ECONNRESET"), {
        code: "slack_webapi_request_error",
      });
    };
    expect(classifySlackFailure(await rejection(client.openDm("U5")))).toBe("uncertain");
    // Whatever `@slack/web-api` could throw lands as the SDK's own error class.
    inner.conversations.open = () => Promise.reject("not even an Error");
    await expect(client.openDm("U5")).rejects.toMatchObject({
      code: "unknown_error",
      message: "not even an Error",
    });
    inner.conversations.open = async () => ({ ok: false, error: "user_not_found" });
    await expect(client.openDm("U5")).rejects.toMatchObject({
      code: "slack_webapi_platform_error",
      message: "An API error occurred: user_not_found",
    });
  });

  test.each([
    [
      new SlackBotError(
        "Slack closed the Socket Mode session: link_disabled",
        "disconnect_terminal",
      ),
      true,
    ],
    [new SlackBotError("An API error occurred: invalid_auth", "invalid_auth"), true],
    [new SlackBotError("An API error occurred: invalid_auth", "slack_webapi_platform_error"), true],
    [new SlackBotError("An API error occurred: ratelimited", "slack_webapi_platform_error"), false],
    [
      new SlackBotError("A request error occurred: ECONNRESET", "slack_webapi_request_error"),
      false,
    ],
    [new Error("invalid_auth"), false],
  ])("isSlackTerminal reads the SDK code or the platform error name: %p → %p", (error, expected) => {
    expect(isSlackTerminal(error)).toBe(expected);
  });

  test("a rate-limited post is retried by the SDK three times, then forwarded as a typed refusal", async () => {
    const client = slackSdk().client();
    await client.login({ token: "xoxb-offline" });
    singleAttempt(client);
    let attempts = 0;
    // The SDK sleeps retryAfter × (attempt + 1) seconds between its three retries, ambient
    // and outside the injected clock; a millisecond keeps the pin fast and the shape real.
    innerOf(client).chat.postMessage = async () => {
      attempts += 1;
      throw Object.assign(new Error("A rate limit was exceeded"), {
        code: "slack_webapi_rate_limited_error",
        retryAfter: 0.001,
      });
    };
    const failure = await rejection(client.postMessage("C1", "hi"));
    expect(attempts).toBe(4);
    expect(failure).toBeInstanceOf(SlackBotError);
    expect((failure as SlackBotError).code).toBe("slack_webapi_rate_limited_error");
    expect((failure as SlackBotError).retryAfter).toBe(0.001);
    expect(classifySlackFailure(failure)).toBe("rejected");
  });

  test("the real listener reports a fatal auth code as an error event during start (no socket)", async () => {
    // The surface's start settles on `connected` or rejects on the first
    // `error`; this pins that the real SDK class emits that error when the
    // Socket Mode URL fetch is refused, instead of swallowing it.
    const refusing = Object.assign(new SlackBotClient(), {
      appsConnectionsOpen: async (): Promise<{ url: string }> => {
        throw new SlackBotError("invalid app token", "invalid_app_token_type");
      },
    });
    const listener = new SlackBotListener(refusing, { appToken: "xapp-offline" });
    const errors: string[] = [];
    listener.on("error", (error) => {
      errors.push("code" in error && typeof error.code === "string" ? error.code : error.message);
    });
    await listener.start();
    listener.stop();
    expect(errors).toEqual(["invalid_app_token_type"]);
  });

  test.each([
    ["slack_webapi_platform_error", "An API error occurred: channel_not_found", "rejected"],
    ["slack_webapi_rate_limited_error", "rate limited", "rejected"],
    ["missing_token", "Token is required", "rejected"],
    ["invalid_token_type", "Token must be a bot token (xoxb-)", "rejected"],
    ["not_authenticated", "Not authenticated. Call .login() first.", "rejected"],
    ["missing_app_token", "App-level token (xapp-) is required for Socket Mode", "rejected"],
    ["invalid_app_token_type", "invalid app token", "rejected"],
    ["slack_webapi_http_error", "An HTTP protocol error occurred: statusCode = 503", "uncertain"],
    [
      "slack_webapi_request_error",
      "A request error occurred: getaddrinfo ENOTFOUND slack.com",
      "not_connected",
    ],
    ["slack_webapi_request_error", "A request error occurred: read ECONNRESET", "uncertain"],
    // Raised after the upload completed and shared: the file may already be in the channel.
    ["file_not_found", "No file returned in upload response", "uncertain"],
    // The SDK's wrapper for any uncoded throw, including after a 200.
    ["unknown_error", "Cannot read properties of undefined", "uncertain"],
  ] as const)("code %s classifies as %s", (code, message, expected) => {
    expect(classifySlackFailure(new SlackBotError(message, code))).toBe(expected);
  });

  test("a non-SDK error is uncertain", () => {
    expect(classifySlackFailure(new Error("boom"))).toBe("uncertain");
  });

  test("a settled state is read from the platform error name only", () => {
    const already = new SlackBotError(
      "An API error occurred: already_reacted",
      "slack_webapi_platform_error",
    );
    expect(isSettledState(already, ["already_reacted"])).toBe(true);
    expect(isSettledState(already, ["no_reaction"])).toBe(false);
    expect(
      isSettledState(new SlackBotError("already_reacted", "slack_webapi_http_error"), [
        "already_reacted",
      ]),
    ).toBe(false);
  });
});
