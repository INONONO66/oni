import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { discordOwnerLogin } from "../src/provider/discord/owner-sdk";
import { type InstagramLoginApi, instagramOwnerLogin } from "../src/provider/instagram/owner-sdk";
import { kakaoTalkOwnerLogin } from "../src/provider/kakaotalk/owner-sdk";
import { OwnerLogins } from "../src/provider/owner-login";
import { slackOwnerLogin } from "../src/provider/slack/owner-sdk";

/**
 * The Owner's own sign-ins (#1569 lane 5b) ride the SDK's flows through
 * each platform's seam and return exactly the credential payload the
 * platform's Owner arm admits; the SDK's store is never touched.
 */
describe("Owner sign-ins", () => {
  test("slack: the QR data URL walks the magic login; a mailed confirmation code is asked for through the prompt", async () => {
    const seen: { dataUrl: string; asked: string[] } = { dataUrl: "", asked: [] };
    const session = await slackOwnerLogin(
      {
        qrImage: "data:image/png;base64,QR",
        confirm: async ({ email }) => {
          seen.asked.push(email);
          return "123456";
        },
      },
      async (dataUrl, options = {}) => {
        seen.dataUrl = dataUrl;
        const code = await options.requestConfirmationCode?.({ email: "owner@example.com", type: "email" });
        expect(code).toBe("123456");
        return { token: "xoxc-1", cookie: "d-1", workspace: "acme" };
      },
    );
    expect(session).toEqual({ token: "xoxc-1", cookie: "d-1", workspace: "acme" });
    expect(seen).toEqual({ dataUrl: "data:image/png;base64,QR", asked: ["owner@example.com"] });
    // Without a prompt the SDK gets no confirmation hook at all.
    await slackOwnerLogin({ qrImage: "data:image/png;base64,QR" }, async (_dataUrl, options = {}) => {
      expect(options.requestConfirmationCode).toBeUndefined();
      return { token: "t", cookie: "c", workspace: "w" };
    });
  });

  test("discord: the remote-auth QR is shown through the prompt and the account token comes back with the user when known", async () => {
    const shown: string[] = [];
    const session = await discordOwnerLogin(
      {
        showQr: (url) => {
          shown.push(url);
        },
        timeoutMs: 5,
      },
      async (options = {}) => {
      await options.onQrUrl?.("https://discord.com/ra/abc");
      expect(options.timeoutMs).toBe(5);
      return { token: "user-token", user: { id: "U1", username: "ino", discriminator: "0", avatar: null } };
    },
    );
    expect(shown).toEqual(["https://discord.com/ra/abc"]);
    expect(session).toEqual({ token: "user-token", userId: "U1", username: "ino" });
    expect(await discordOwnerLogin({ showQr: () => undefined }, async () => ({ token: "t", user: null }))).toEqual({
      token: "t",
    });
  });

  function instagramApi(script: {
    readonly authenticate: Awaited<ReturnType<InstagramLoginApi["authenticate"]>>;
    readonly calls: string[];
    /** What the password login answers the second time round (after a closed checkpoint). */
    readonly authenticateAgain?: Awaited<ReturnType<InstagramLoginApi["authenticate"]>>;
    /** What the second step (two-factor or challenge code) ends on. */
    readonly secondStep?: { readonly userId: string };
  }): InstagramLoginApi {
    let logins = 0;
    return {
      authenticate: async (username, password) => {
        logins += 1;
        script.calls.push(`authenticate:${username}:${password}`);
        return logins > 1 && script.authenticateAgain !== undefined ? script.authenticateAgain : script.authenticate;
      },
      twoFactorLogin: async (username, code, identifier) => {
        script.calls.push(`twoFactor:${username}:${code}:${identifier}`);
        return script.secondStep ?? { userId: "17841400000001" };
      },
      challengeSendCode: async (apiPath) => {
        script.calls.push(`challengeSend:${apiPath}`);
        return { contactPoint: "o***@example.com", stepName: "verify_email" };
      },
      challengeSubmitCode: async (apiPath, code) => {
        script.calls.push(`challengeSubmit:${apiPath}:${code}`);
        return script.secondStep ?? { userId: "17841400000001" };
      },
      getSessionState: () => ({ cookies: "sessionid=abc", device: { uuid: "u" }, user_id: "17841400000001" }),
    };
  }

  test("instagram: password, then the two-factor code or the challenge code through the prompts; the session state is the credential", async () => {
    const plain = { calls: [] as string[], authenticate: { userId: "17841400000001" } };
    const prompts = {
      twoFactorCode: async () => "222333",
      challengeCode: async ({ contactPoint }: { contactPoint: string }) => `code-for-${contactPoint}`,
    };
    // The SDK's device file lives in a scratch directory of the login's own, gone before the session is returned.
    let scratch = "";
    const direct = await instagramOwnerLogin({ username: "ino", password: "pw", ...prompts }, (scratchDir) => {
      scratch = scratchDir;
      expect(existsSync(scratchDir)).toBe(true);
      return instagramApi(plain);
    });
    expect(scratch).not.toBe("");
    expect(existsSync(scratch)).toBe(false);
    expect(JSON.parse(direct.session)).toMatchObject({ cookies: "sessionid=abc", user_id: "17841400000001" });
    expect(plain.calls).toEqual(["authenticate:ino:pw"]);

    const twoFactor = {
      calls: [] as string[],
      authenticate: { userId: "", requiresTwoFactor: true, twoFactorInfo: { two_factor_identifier: "tfi-1" } },
    };
    await instagramOwnerLogin({ username: "ino", password: "pw", ...prompts }, () => instagramApi(twoFactor));
    expect(twoFactor.calls).toEqual(["authenticate:ino:pw", "twoFactor:ino:222333:tfi-1"]);

    const challenge = {
      calls: [] as string[],
      authenticate: { userId: "", challengeRequired: true, challengePath: "/challenge/1/" },
    };
    await instagramOwnerLogin({ username: "ino", password: "pw", ...prompts }, () => instagramApi(challenge));
    expect(challenge.calls).toEqual([
      "authenticate:ino:pw",
      "challengeSend:/challenge/1/",
      "challengeSubmit:/challenge/1/:code-for-o***@example.com",
    ]);

    const incomplete = { calls: [] as string[], authenticate: { userId: "" } };
    await expect(
      instagramOwnerLogin({ username: "ino", password: "pw", ...prompts }, () => instagramApi(incomplete)),
    ).rejects.toMatchObject({ code: "login_incomplete" });
    const noIdentifier = { calls: [] as string[], authenticate: { userId: "", requiresTwoFactor: true } };
    await expect(
      instagramOwnerLogin({ username: "ino", password: "pw", ...prompts }, () => instagramApi(noIdentifier)),
    ).rejects.toMatchObject({ code: "two_factor_required" });
    const noPath = { calls: [] as string[], authenticate: { userId: "", challengeRequired: true, challengePath: "" } };
    await expect(
      instagramOwnerLogin({ username: "ino", password: "pw", ...prompts }, () => instagramApi(noPath)),
    ).rejects.toMatchObject({ code: "challenge_required" });
    // A checkpoint that closes without a logged-in user only clears the way: the password login runs once more.
    const cleared = {
      calls: [] as string[],
      authenticate: { userId: "", challengeRequired: true, challengePath: "/challenge/1/" },
      secondStep: { userId: "" },
      authenticateAgain: { userId: "17841400000001" },
    };
    await instagramOwnerLogin({ username: "ino", password: "pw", ...prompts }, () => instagramApi(cleared));
    expect(cleared.calls).toEqual([
      "authenticate:ino:pw",
      "challengeSend:/challenge/1/",
      "challengeSubmit:/challenge/1/:code-for-o***@example.com",
      "authenticate:ino:pw",
    ]);
    // Still no account after that, or after the two-factor step: nothing is returned for the vault.
    const never = { ...cleared, calls: [] as string[], authenticateAgain: { userId: "" } };
    await expect(
      instagramOwnerLogin({ username: "ino", password: "pw", ...prompts }, () => instagramApi(never)),
    ).rejects.toMatchObject({ code: "login_incomplete" });
    const twoFactorEmpty = {
      calls: [] as string[],
      authenticate: { userId: "", requiresTwoFactor: true, twoFactorInfo: { two_factor_identifier: "tfi-1" } },
      secondStep: { userId: "" },
    };
    await expect(
      instagramOwnerLogin({ username: "ino", password: "pw", ...prompts }, () => instagramApi(twoFactorEmpty)),
    ).rejects.toMatchObject({ code: "login_incomplete" });
  });

  test("kakaotalk: email and password, the passcode shown through the prompt, the registered device's session as the credential", async () => {
    const shown: string[] = [];
    const session = await kakaoTalkOwnerLogin(
      { email: "ino@example.com", password: "pw", onPasscode: (code) => shown.push(code) },
      async (options) => {
        expect(options.deviceType).toBe("tablet");
        options.onPasscodeDisplay?.("4821");
        return {
          authenticated: true,
          account_id: "1001",
          user_id: "1001",
          device_type: "tablet",
          credentials: { access_token: "oauth-1", refresh_token: "r", user_id: "1001", device_uuid: "dev-1", device_type: "tablet" },
        } as never;
      },
    );
    expect(shown).toEqual(["4821"]);
    expect(session).toEqual({ oauthToken: "oauth-1", userId: "1001", deviceUuid: "dev-1", deviceType: "tablet" });
    // The SDK's own verdict decides, with its reason: a failed passcode request still carries (empty) credentials.
    const refusals = [
      [
        {
          authenticated: false,
          error: "passcode_request_failed",
          message: "HTTP 500 from passcode endpoint",
          credentials: { access_token: "", refresh_token: "", user_id: "", device_uuid: "dev-1", device_type: "tablet" },
        },
        { code: "passcode_request_failed", message: "HTTP 500 from passcode endpoint" },
      ],
      [
        { authenticated: false, error: "bad_credentials", message: "Login failed: incorrect email or password." },
        { code: "bad_credentials", message: "Login failed: incorrect email or password." },
      ],
      [
        { authenticated: false, next_action: "choose_device", message: "tablet slot may be occupied." },
        { code: "choose_device", message: "tablet slot may be occupied." },
      ],
      [{ authenticated: false }, { code: "login_incomplete", message: "Login did not register this device" }],
    ] as const;
    for (const [result, expected] of refusals) {
      await expect(
        kakaoTalkOwnerLogin({ email: "e", password: "p", onPasscode: () => undefined }, async () => result as never),
      ).rejects.toMatchObject(expected);
    }
  });

  test("the shipped sign-ins are the four platforms' flows", () => {
    expect(Object.keys(OwnerLogins).sort()).toEqual(["discord", "instagram", "kakaotalk", "slack", "telegram"]);
  });
});
