import { z } from "zod";
import { EpochMs } from "../time.js";
import { SessionTransition } from "../ledger/session-transition.js";
import { MediaPart } from "../gateway/media.js";

const Id = z.string().min(1);

const Author = z.object({ externalId: Id, isBot: z.boolean() }).strict();

/** Platform facts and router-derived addressing share one message contract. */
export const Message = z
  .object({
    eventId: Id,
    surface: Id,
    /** Declared channel instance; non-channel sources keep their own surface id. */
    instance: Id.optional(),
    event: z.enum(["message", "reaction", "postback", "mention", "webhook", "github", "linear", "schedule", "call"]).optional(),
    secretRef: Id.optional(),
    githubEvent: Id.optional(),
    author: Author.optional(),
    workspaceId: Id.optional(),
    channelId: Id,
    addressees: z.array(z.object({ externalId: Id }).strict()),
    dm: z.boolean(),
    /** The receiving account's platform id, in the same namespace as addressees. */
    account: Id.optional(),
    /** Platform id of the quoted message's author, independent of its display label. */
    quotes: Id.optional(),
    /** Derived at routing, never trusted from a provider. */
    addressed: z.boolean().optional(),
    from: Id.optional(),
    receivedAt: EpochMs.optional(),
    threadId: Id.optional(),
    /**
     * #1569: the account identity that observed this message —
     * `Channel.Identity`; absent means the bot. Through the Owner's own
     * account a mention of the Owner addresses the Resident.
     */
    receivedBy: z.enum(["bot", "owner"]).optional(),
    reply: SessionTransition.Correlation.omit({ endpointId: true, channelId: true })
      .extend({ chain: z.array(Id) })
      .strict()
      .optional(),
    payload: z.json(),
    render: z.string(),
    postback: z.object({
      id: Id,
      label: z.string().min(1),
      messageRef: Id.optional(),
    }).strict().optional(),
    attachments: z.array(MediaPart).readonly().optional(),
    // What the person could see that the model has not: the thread's earlier
    // messages (shown once, when the thread's session starts) and the message
    // this one quotes (shown with every such message).
    context: z
      .object({
        thread: z.array(z.object({ author: Id, text: z.string() }).strict()).optional(),
        quoted: z.object({ author: Id, text: z.string() }).strict().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type Message = z.infer<typeof Message>;
