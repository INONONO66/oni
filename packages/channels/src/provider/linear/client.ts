import { createHash } from "node:crypto";
import { Operational, type PlainValue } from "@openomni/protocol";
import { z } from "zod";
import { DeliveryNotSent } from "../../errors";
import type { DeliveryReceipt } from "../../support/deliver";
import { fetchWithRetry } from "../../support/fetch-retry";
import type { EffectRunner, PublishPort } from "../../types";
import type { LinearViewer } from "./types";

/** Linear's one GraphQL endpoint; a personal API key rides `Authorization` bare, without a Bearer prefix. */
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

/** The platform's refusals of the request itself: nothing was created. Anything else may have. */
const REFUSED_CODES = new Set([
  "RATELIMITED",
  "INVALID_INPUT",
  "ENTITY_NOT_FOUND",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "AUTHENTICATION_ERROR",
  "USER_ERROR",
  "FEATURE_NOT_ACCESSIBLE",
  "GRAPHQL_VALIDATION_FAILED",
]);

const GraphQLErrors = z
  .array(
    z.object({
      message: z.string(),
      extensions: z.object({ code: z.string().optional(), userError: z.boolean().optional() }).optional(),
    }),
  )
  .optional();
const CommentCreateResponse = z.object({
  data: z
    .object({
      commentCreate: z.object({ success: z.boolean(), comment: z.object({ id: z.string() }).nullish() }).nullish(),
    })
    .nullish(),
  errors: GraphQLErrors,
});
const CommentLookupResponse = z.object({
  data: z.object({ comment: z.object({ id: z.string() }).nullish() }).nullish(),
  errors: GraphQLErrors,
});
const ViewerResponse = z.object({
  data: z
    .object({
      viewer: z.object({ id: z.string(), name: z.string().nullish(), displayName: z.string().nullish() }).nullish(),
    })
    .nullish(),
  errors: GraphQLErrors,
});

/**
 * The comment's own id, derived from the idempotency key: Linear refuses a
 * second entity with an id it already holds, so a re-run after a crash can
 * never post the same letter twice — the retrying transport underneath is
 * safe for the same reason; and the comment can be looked up by it before
 * posting, so the re-run reports `sent`. UUID v4 shape, as Linear
 * validates it.
 */
function commentIdFor(idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  const version = `4${digest.slice(13, 16)}`;
  const variant = `${((Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${digest.slice(17, 20)}`;
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${version}-${variant}-${digest.slice(20, 32)}`;
}

function codesOf(errors: z.infer<typeof GraphQLErrors>): string[] {
  return (errors ?? []).map((error) => error.extensions?.code ?? "OTHER");
}

/** Linear attributes an error to the request itself (`userError`) or by one of its refusal codes: the mutation never ran. */
function refusedAll(errors: z.infer<typeof GraphQLErrors>): boolean {
  const listed = errors ?? [];
  return (
    listed.length > 0 &&
    listed.every((error) => error.extensions?.userError === true || REFUSED_CODES.has(error.extensions?.code ?? ""))
  );
}

export class LinearClient {
  constructor(
    private readonly publish: PublishPort,
    private readonly now: () => number,
    private readonly run: EffectRunner,
    private readonly token?: string,
  ) {}

  /** The account the key belongs to, or undefined when there is no key or Linear will not say. */
  async viewer(traceId: string): Promise<LinearViewer | undefined> {
    if (!this.token) return undefined;
    const response = await this.query("{ viewer { id name displayName } }", {}, traceId, "linear/viewer");
    if (!response.ok) return undefined;
    const parsed = ViewerResponse.safeParse(await this.json(response));
    const viewer = parsed.success ? parsed.data.data?.viewer : undefined;
    if (viewer === undefined || viewer === null) return undefined;
    return {
      id: viewer.id,
      ...(viewer.name === undefined || viewer.name === null ? {} : { name: viewer.name }),
      ...(viewer.displayName === undefined || viewer.displayName === null ? {} : { displayName: viewer.displayName }),
    };
  }

  async createComment(issueId: string, body: string, traceId: string, idempotencyKey: string): Promise<DeliveryReceipt> {
    if (!this.token) {
      // Loud absence: a deployment with a webhook secret but no key would
      // receive events, spend a full run, then silently never reply.
      this.publish(Operational.Events.Warn, {
        traceId,
        time: this.now(),
        component: "server",
        msg: "linear api key missing — reply not posted",
        context: { issueId },
      });
      return { value: "not_sent" };
    }
    const id = commentIdFor(idempotencyKey);
    if (await this.hasComment(id, traceId)) {
      this.publish(Operational.Events.Debug, {
        traceId,
        time: this.now(),
        component: "server",
        msg: "linear comment already posted",
        context: { issueId, idempotencyKey },
      });
      return { value: "sent", externalMessageId: id };
    }
    const response = await this.query(
      "mutation ($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
      { input: { id, issueId, body } },
      traceId,
      "linear/commentCreate",
    );
    if (!response.ok) {
      const text = await response.text();
      this.publish(Operational.Events.Warn, {
        traceId,
        time: this.now(),
        component: "linear",
        msg: "Linear rejected comment delivery",
        context: { status: response.status, detail: text },
      });
      return { value: response.status < 500 ? "not_sent" : "unknown" };
    }
    const parsed = CommentCreateResponse.safeParse(await this.json(response));
    if (!parsed.success) return this.unreadable(traceId, issueId);
    const created = parsed.data.data?.commentCreate;
    if (created?.success === true) return { value: "sent", externalMessageId: created.comment?.id ?? id };
    // The platform's own word on the request: a refusal created nothing; anything else may have.
    const codes = codesOf(parsed.data.errors);
    const refused = refusedAll(parsed.data.errors);
    this.publish(Operational.Events.Warn, {
      traceId,
      time: this.now(),
      component: "linear",
      msg: refused ? "Linear refused the comment" : "Linear did not confirm the comment",
      context: {
        issueId,
        codes: codes.join(","),
        detail: (parsed.data.errors ?? []).map((error) => error.message).join("; ") || "commentCreate did not succeed",
      },
    });
    return { value: refused ? "not_sent" : "unknown" };
  }

  /** Whether the comment this key names already stands: a re-run after a crash finds it here and posts nothing. */
  private async hasComment(id: string, traceId: string): Promise<boolean> {
    const response = await this.query("query ($id: String!) { comment(id: $id) { id } }", { id }, traceId, "linear/comment");
    if (!response.ok) {
      const text = await response.text();
      throw new DeliveryNotSent({ operation: "linear.comment", cause: `Linear API failed (${response.status}): ${text}` });
    }
    const parsed = CommentLookupResponse.safeParse(await this.json(response));
    if (!parsed.success) throw new DeliveryNotSent({ operation: "linear.comment", cause: "Linear API returned an unreadable answer" });
    if (parsed.data.data?.comment?.id === id) return true;
    const codes = codesOf(parsed.data.errors);
    if (codes.length === 0 || codes.every((code) => code === "ENTITY_NOT_FOUND")) return false;
    throw new DeliveryNotSent({ operation: "linear.comment", cause: `Linear API refused the lookup (${codes.join(",")})` });
  }

  private unreadable(traceId: string, issueId: string): DeliveryReceipt {
    this.publish(Operational.Events.Warn, {
      traceId,
      time: this.now(),
      component: "linear",
      msg: "Linear answered the comment with a shape this client does not read",
      context: { issueId },
    });
    return { value: "unknown" };
  }

  private async json(response: Response): Promise<PlainValue | undefined> {
    try {
      const parsed: PlainValue = JSON.parse(await response.text());
      return parsed;
    } catch {
      return undefined;
    }
  }

  private query(query: string, variables: Record<string, object | string>, traceId: string, label: string): Promise<Response> {
    if (!this.token) throw new DeliveryNotSent({ operation: label, cause: "linear api key missing" });
    return fetchWithRetry(
      LINEAR_GRAPHQL_URL,
      {
        method: "POST",
        headers: {
          Authorization: this.token,
          "Content-Type": "application/json",
          "User-Agent": "openomni-server",
        },
        body: JSON.stringify({ query, variables }),
      },
      { traceId, run: this.run, publish: this.publish, label },
    );
  }
}
