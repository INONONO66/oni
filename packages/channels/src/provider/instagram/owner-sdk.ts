import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InstagramClient,
  InstagramCredentialManager,
  InstagramError,
  InstagramHybridListener,
} from "agent-messenger/instagram";
import type { InstagramHybridListenerEventMap, InstagramMessageSummary } from "agent-messenger/instagram";

/**
 * The slice of the agent-messenger Instagram SDK the Owner instance speaks
 * (#1569 lane 7): the account session the Owner's login produced, restored
 * from the vault; the inbox listener (realtime with a polling fallback);
 * sends into a thread or to a user. The SDK persists a session only where a
 * session path is set, so the surface restores through a file it removes
 * at once and then clears the path (`setSessionPath("")`): the vault stays
 * the one copy. The SDK classes satisfy these shapes structurally; tests
 * pass scripted fakes.
 */
export interface InstagramOwnerApi {
  loadSession(path: string): Promise<void>;
  setSessionPath(path: string): void;
  /** The account the restored session speaks as; `null` until a session is loaded. */
  getUserId(): string | null;
  sendMessage(threadId: string, text: string): Promise<{ id: string }>;
  /** Opens (or reuses) the direct thread with a user and posts into it. */
  sendMessageToUser(userPk: string, text: string): Promise<{ id: string }>;
}

/** One inbox message as the SDK summarizes it. */
export type InstagramMessage = InstagramMessageSummary;

/** The SDK's hybrid listener event map, re-exported so the surface never imports the SDK itself. */
export type InstagramOwnerEventMap = InstagramHybridListenerEventMap;

export interface InstagramOwnerEvents {
  on<K extends keyof InstagramHybridListenerEventMap>(
    event: K,
    listener: (...args: InstagramHybridListenerEventMap[K]) => void,
  ): this;
  start(): Promise<void>;
  stop(): void;
}

/** Construction seams: the real SDK in production, scripted fakes in tests. */
export interface InstagramOwnerSdk {
  client(): InstagramOwnerApi;
  listener(client: InstagramOwnerApi, options: { readonly pollInterval: number }): InstagramOwnerEvents;
  /** The sign-in client over a credential directory of the login's own (the SDK's device file goes there). */
  loginClient(scratchDir: string): InstagramLoginApi;
}

export function instagramOwnerSdk(): InstagramOwnerSdk {
  return {
    client: () => new InstagramClient(),
    // The listener only ever receives the client this same factory built.
    listener: (client, options) =>
      new InstagramHybridListener(client as InstagramClient, { pollInterval: options.pollInterval }),
    loginClient: (scratchDir) => new InstagramClient(new InstagramCredentialManager(scratchDir)),
  };
}

/** The SDK's error class: `code` names the platform refusal (`rate_limited`, `send_failed`, `not_authenticated`, …). */
export { InstagramError as InstagramOwnerError };

/** The SDK calls a password sign-in walks; the real client in production, a scripted fake in tests. */
export interface InstagramLoginApi {
  authenticate(
    username: string,
    password: string,
  ): Promise<{
    userId: string;
    requiresTwoFactor?: boolean;
    twoFactorInfo?: object;
    challengeRequired?: boolean;
    challengePath?: string;
  }>;
  twoFactorLogin(username: string, code: string, identifier: string): Promise<{ userId: string }>;
  challengeSendCode(apiPath: string, method?: "email" | "sms"): Promise<{ contactPoint: string; stepName: string }>;
  challengeSubmitCode(apiPath: string, code: string): Promise<{ userId: string }>;
  getSessionState(): object;
}

/**
 * The Owner's own sign-in (#1569 lane 5b): username and password, then the
 * platform's two-factor code or security challenge through the prompts.
 * The SDK keeps the device identity it minted under `scratchDir` (the
 * caller removes it); the session state is returned for the vault and
 * never written by the SDK, which has no session path here.
 */
export interface InstagramOwnerLoginInput {
  readonly username: string;
  readonly password: string;
  readonly twoFactorCode: () => Promise<string>;
  readonly challengeCode: (challenge: { readonly contactPoint: string }) => Promise<string>;
}

/**
 * The SDK's client wants a credential directory for its device file; the
 * login gives it a scratch directory of its own and removes it before
 * returning, so the returned session state is the only copy.
 */
export async function instagramOwnerLogin(
  input: InstagramOwnerLoginInput,
  client: (scratchDir: string) => InstagramLoginApi = instagramOwnerSdk().loginClient,
): Promise<{ session: string }> {
  const scratchDir = await mkdtemp(join(tmpdir(), "oni-instagram-login-"));
  try {
    const api = client(scratchDir);
    await completeLogin(api, input);
    return { session: JSON.stringify(api.getSessionState()) };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

/**
 * Password, then whichever second step Instagram asks for through the
 * prompts. The login ends on a logged-in user or not at all: a checkpoint
 * that closes without one only clears the way, so the password login runs
 * once more; a session naming no account is never returned for the vault.
 */
async function completeLogin(api: InstagramLoginApi, input: InstagramOwnerLoginInput): Promise<void> {
  const result = await api.authenticate(input.username, input.password);
  let userId = result.userId;
  if (result.requiresTwoFactor) {
    const info = result.twoFactorInfo as { readonly two_factor_identifier?: string } | undefined;
    const identifier = info?.two_factor_identifier;
    if (typeof identifier !== "string")
      throw new InstagramError("Two-factor login offered no identifier", "two_factor_required");
    userId = (await api.twoFactorLogin(input.username, await input.twoFactorCode(), identifier)).userId;
  } else if (result.challengeRequired) {
    const path = result.challengePath;
    if (path === undefined || path === "")
      throw new InstagramError("Security challenge named no path", "challenge_required");
    const sent = await api.challengeSendCode(path);
    const cleared = await api.challengeSubmitCode(path, await input.challengeCode({ contactPoint: sent.contactPoint }));
    userId = cleared.userId === "" ? (await api.authenticate(input.username, input.password)).userId : cleared.userId;
  }
  if (userId === "") throw new InstagramError("Login did not complete.", "login_incomplete");
}
