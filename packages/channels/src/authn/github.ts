import type { Policy } from "@oni/protocol";
import { evaluateChannelPermission, recordDecision } from "./decision";
import type { ChannelAuthnDecisionObserver } from "./types";
import { verifyGitHubSignature } from "./github-signature";

interface GitHubAuthResult {
  readonly verdict: Policy.PolicyDecision;
  readonly body?: string;
  readonly response?: Response;
}

interface GitHubAuthState {
  readonly request: Request;
  readonly secret: string;
  body?: string;
  response?: Response;
}

function hmacVerdict(allowed: boolean, denyReason: string): Policy.PolicyDecision {
  return evaluateChannelPermission({
    action: "channel.authn.github-hmac",
    resource: "github.webhook",
    field: "authenticated",
    allowed,
    allowReason: "github signature verified",
    denyReason,
  });
}

async function evaluateGitHubHmac(state: GitHubAuthState): Promise<Policy.PolicyDecision> {
  const signature = state.request.headers.get("x-hub-signature-256");
  if (!signature) {
    state.response = new Response("Missing signature", { status: 401 });
    return hmacVerdict(false, "github signature missing");
  }

  const body = await state.request.text();
  state.body = body;
  if (!(await verifyGitHubSignature(body, signature, state.secret))) {
    state.response = new Response("Invalid signature", { status: 401 });
    return hmacVerdict(false, "github signature invalid");
  }

  return hmacVerdict(true, "github signature invalid");
}

export async function authenticateGitHubWebhook(input: {
  readonly request: Request;
  readonly secret: string;
  readonly now: () => number;
  readonly onDecision?: ChannelAuthnDecisionObserver;
}): Promise<GitHubAuthResult> {
  const startedAt = input.now();
  const state: GitHubAuthState = {
    request: input.request,
    secret: input.secret,
  };
  const verdict = await evaluateGitHubHmac(state);
  await recordDecision(
    "channel-authn:github-hmac",
    verdict,
    input.now() - startedAt,
    input.onDecision,
  );

  return {
    verdict,
    ...(state.body !== undefined ? { body: state.body } : {}),
    ...(state.response !== undefined ? { response: state.response } : {}),
  };
}
