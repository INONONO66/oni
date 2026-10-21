import { DeliveryNotSent } from "../../errors";
import { Operational } from "@oni/protocol";
import { z } from "zod";
import { fetchWithRetry } from "../../support/fetch-retry";
import type { EffectRunner, PublishPort } from "../../types";
import type { DeliveryReceipt } from "../../support/deliver";

/** One comment page from the list endpoint — only `body` is read, extra keys pass. */
const CommentsPageSchema = z.array(z.object({ body: z.string().optional() }));

export class GitHubClient {
  constructor(
    private readonly publish: PublishPort,
    private readonly now: () => number,
    private readonly run: EffectRunner,
    private readonly token?: string,
  ) {}

  async postComment(
    repo: string,
    issueNumber: number,
    body: string,
    traceId: string,
    deliveryId: string,
  ): Promise<DeliveryReceipt> {
    if (!this.token) {
      // Loud absence (#606 audit): a deployment with a webhook secret but no
      // token would receive events, spend a full run, then silently never
      // reply. The run's work must not vanish without a record.
      this.publish(Operational.Events.Warn, {
        traceId,
        time: this.now(),
        component: "server",
        msg: "github token missing — reply not posted",
        context: { repo, issueNumber },
      });
      return { value: "not_sent" };
    }

    const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`;
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      "User-Agent": "oni-server",
    };
    const marker = `<!-- oni-delivery:${encodeURIComponent(deliveryId)} -->`;
    const posted = await this.hasComment(url, headers, marker, traceId).catch((error) => {
      if (error instanceof DeliveryNotSent) throw error;
      throw new DeliveryNotSent({ operation: "github.listComments", cause: String(error) });
    });
    if (posted) {
      this.publish(Operational.Events.Debug, {
        traceId,
        time: this.now(),
        component: "server",
        msg: "github comment already posted",
        context: { repo, issueNumber, deliveryId },
      });
      return { value: "sent" };
    }

    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ body: `${body}\n\n${marker}` }),
      },
      {
        traceId,
        run: this.run,
        publish: this.publish,
        label: "github/postComment",
      },
    );

    if (!response.ok) {
      const text = await response.text();
      this.publish(Operational.Events.Warn, {
        traceId,
        time: this.now(),
        component: "github",
        msg: "GitHub rejected comment delivery",
        context: { status: response.status, detail: text },
      });
      return { value: response.status < 500 ? "not_sent" : "unknown" };
    }
    const result = z.object({ id: z.number().optional() }).parse(await response.json());

    this.publish(Operational.Events.Debug, {
      traceId,
      time: this.now(),
      component: "server",
      msg: "github comment posted",
      context: { repo, issueNumber },
    });
    return {
      value: "sent",
      ...(result.id === undefined ? {} : { externalMessageId: String(result.id) }),
    };
  }

  private async hasComment(
    url: string,
    headers: Record<string, string>,
    marker: string,
    traceId: string,
  ): Promise<boolean> {
    const perPage = 100;
    for (let page = 1; ; page += 1) {
      const response = await fetchWithRetry(
        `${url}?per_page=${perPage}&page=${page}`,
        { method: "GET", headers },
        {
          traceId,
          run: this.run,
          publish: this.publish,
          label: "github/listComments",
        },
      );
      if (!response.ok) {
        const text = await response.text();
        throw new DeliveryNotSent({
          operation: "github.listComments",
          cause: `GitHub API failed (${response.status}): ${text}`,
        });
      }

      const listing = CommentsPageSchema.safeParse(await response.json());
      if (!listing.success)
        throw new DeliveryNotSent({
          operation: "github.listComments",
          cause: "GitHub API returned invalid comments",
        });
      if (listing.data.some((comment) => comment.body?.includes(marker))) return true;
      if (listing.data.length < perPage) return false;
    }
  }
}
