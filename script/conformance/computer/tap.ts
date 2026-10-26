/**
 * A transparent Unix-socket tap between the built client and the host: it
 * forwards every byte unchanged in both directions and decodes the client's
 * newline-framed `machine.report` requests, so a receipt can wait for the
 * next heartbeat that carries stream observations the host's report event
 * does not republish.
 */
import { z } from "zod";
import { Machine } from "../../../packages/protocol/src/index.js";

const ReportFrame = z.object({ method: z.literal("machine.report"), params: Machine.Report });

/** One direction's bytes not yet accepted by its socket; flushed on drain. */
interface Outbox {
  socket: Bun.Socket<Side> | undefined;
  queued: Buffer;
}

interface Side {
  readonly out: Outbox;
  readonly back: Outbox;
  line: string;
}

interface Waiter {
  readonly accept: (report: Machine.Report) => boolean;
  readonly resolve: (report: Machine.Report) => void;
}

export interface ReportTap {
  readonly socket: string;
  next(accept: (report: Machine.Report) => boolean): Promise<Machine.Report>;
  stop(): void;
}

function flush(box: Outbox): void {
  if (box.socket === undefined || box.queued.length === 0) return;
  const written = box.socket.write(box.queued);
  box.queued = box.queued.subarray(Math.max(written, 0));
}

function send(box: Outbox, chunk: Buffer): void {
  box.queued = Buffer.concat([box.queued, chunk]);
  flush(box);
}

export function startReportTap(socket: string, host: string): ReportTap {
  const waiters: Waiter[] = [];
  function observe(line: string): void {
    if (!line.includes('"machine.report"')) return;
    const frame = ReportFrame.safeParse(JSON.parse(line));
    if (!frame.success) return;
    for (const waiter of waiters.filter((entry) => entry.accept(frame.data.params))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frame.data.params);
    }
  }
  const listener = Bun.listen<Side>({
    unix: socket,
    socket: {
      async open(client) {
        const toHost: Outbox = { socket: undefined, queued: Buffer.alloc(0) };
        const toClient: Outbox = { socket: client, queued: Buffer.alloc(0) };
        client.data = { out: toHost, back: toClient, line: "" };
        toHost.socket = await Bun.connect<Side>({
          unix: host,
          data: { out: toClient, back: toHost, line: "" },
          socket: {
            data(_, chunk) {
              send(toClient, chunk);
            },
            drain(upstream) {
              flush(upstream.data.back);
            },
            close() {
              client.end();
            },
          },
        });
        flush(toHost);
      },
      data(client, chunk) {
        const lines = (client.data.line + chunk.toString("utf8")).split("\n");
        client.data.line = lines.pop() ?? "";
        for (const line of lines) observe(line);
        send(client.data.out, chunk);
      },
      drain(client) {
        flush(client.data.back);
      },
      close(client) {
        client.data.out.socket?.end();
      },
    },
  });
  return {
    socket,
    next: (accept) => new Promise((resolve) => waiters.push({ accept, resolve })),
    stop: () => listener.stop(true),
  };
}
