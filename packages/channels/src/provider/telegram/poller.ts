import { Deferred, Effect, Exit } from "effect";
import { newTraceId } from "../../support/trace";
import { listenForAbort, Operational } from "@openomni/protocol";
import { reconnectSchedule } from "../../support/schedule";
import { ThrownError } from "../../support/thrown";
import type { EffectRunner, PublishPort } from "../../types";
import type { TelegramClient } from "./client";
import type { TelegramCallback, TelegramMessage, TelegramReaction } from "./types";

interface PollerCallbacks {
  onMessage: (message: TelegramMessage | TelegramReaction | TelegramCallback) => void | Promise<void>;
}

/**
 * Telegram long-poll loop on Effect (#1248): `Effect.forever` drives the
 * cycles, poll errors retry under the shared jittered schedule (exponential
 * from 1s, 60s cap) with a fresh schedule after every successful cycle, and
 * every delay runs on the injected clock. `stop()` settles the halt Deferred
 * — interrupting a sleeping loop through `Effect.raceFirst` — and aborts the
 * in-flight request; a response that outlives its abort is dropped by the
 * cycle's own AbortController custody, never checkpointed.
 */
export class TelegramPoller {
  private offset = 0;
  private halt: Deferred.Deferred<void> | null = null;
  private pollController: AbortController | null = null;

  constructor(
    private readonly client: Pick<TelegramClient, "getUpdates" | "answerCallbackQuery">,
    private readonly callbacks: PollerCallbacks,
    private readonly publish: PublishPort,
    private readonly options: {
      readonly now: () => number;
      readonly id: () => string;
      readonly run: EffectRunner;
    },
    /** Poll-error retry policy — the shared jittered schedule unless a test injects a faster one. */
    private readonly schedule: typeof reconnectSchedule = reconnectSchedule,
  ) {}

  start(): Promise<void> {
    this.stop();
    const halt = Deferred.makeUnsafe<void>();
    this.halt = halt;
    const cycle = Effect.suspend(() => {
      // Origin: one long-poll cycle is one logical request — its getUpdates
      // call (retries included) and any poll-error warn share this ONE id.
      const pollTraceId = newTraceId(this.options.id);
      return Effect.tryPromise({
        try: (signal) => this.pollOnce(pollTraceId, signal),
        catch: (cause) => {
          const error = ThrownError.parse(cause);
          this.publish(Operational.Events.Warn, {
            traceId: pollTraceId,
            time: this.options.now(),
            component: "server",
            msg: "telegram poll error",
            context: { err: String(error) },
          });
          return error;
        },
      });
    });
    const loop = cycle.pipe(Effect.retry({ schedule: this.schedule }), Effect.forever);
    return this.options.run(Effect.raceFirst(loop, Deferred.await(halt)));
  }

  stop(): void {
    if (this.halt !== null) {
      Deferred.doneUnsafe(this.halt, Exit.void);
      this.halt = null;
    }
    this.pollController?.abort();
  }

  async pollOnce(pollTraceId: string, signal?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    this.pollController = controller;
    // `listenForAbort` owns the abort subscription (#1312): an already-aborted
    // caller signal aborts the controller at once, and the guard below then
    // refuses the cycle before a single getUpdates call leaves the process.
    const detach =
      signal === undefined ? () => undefined : listenForAbort(signal, () => controller.abort());
    try {
      if (controller.signal.aborted) return;
      const updates = await this.client.getUpdates(this.offset, pollTraceId, controller.signal);

      // Telegram returns updates in update_id order. Process the batch in that
      // order and stop at the first failed handoff, leaving it and every later
      // update eligible for the next request. Updates without supported content do
      // not require a handoff and are checkpointed at their position in the batch.
      // The controller, not a generation counter, owns custody: a response that
      // arrives after stop()/interruption finds its own signal aborted.
      for (const update of updates) {
        if (controller.signal.aborted) return;
        if (update.message) await this.callbacks.onMessage(update.message);
        if (update.message_reaction) await this.callbacks.onMessage(update.message_reaction);
        if (update.callback_query) {
          const callback = update.callback_query;
          try {
            await this.client.answerCallbackQuery(callback.id, pollTraceId);
          } catch (error) {
            this.publish(Operational.Events.Warn, {
              traceId: pollTraceId, time: this.options.now(), component: "server",
              msg: "telegram callback acknowledgment failed; dropped",
              context: { err: String(error) },
            });
            this.offset = update.update_id + 1;
            continue;
          }
          if (controller.signal.aborted) return;
          await this.callbacks.onMessage(callback);
        }
        if (controller.signal.aborted) return;
        this.offset = update.update_id + 1;
      }
    } finally {
      detach();
    }
  }
}
