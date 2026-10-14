import { readFileSync } from "node:fs";
import { Effect, Fiber } from "effect";
import {
  attachMachineDaemon,
  MachinesFailure,
  type ReconnectOptions,
} from "@openomni/machines";
import { createCodemode } from "@openomni/codemode";
import { Machine } from "@openomni/protocol";
import { z } from "zod";
import { foreignFailure } from "../composition/failure";

/**
 * Two ways to reach a host, named explicitly: same-box over the unix socket,
 * or across the network — the daemon verifies the host's CERTIFICATE through
 * the TLS chain (its key fingerprint is the pin), the host pins the daemon's
 * key via its enrollment. The TLS fields and `hostCertificate` are PEM file
 * PATHS (read at attach time), so key material never sits in the JSON.
 */
const UnixConfiguration = z
  .object({ socketPath: z.string().min(1), offer: Machine.Offer })
  .strict();
const TcpConfiguration = z
  .object({
    tcp: z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535) }).strict(),
    hostCertificate: z.string().min(1),
    tlsCertificate: z.string().min(1),
    tlsPrivateKey: z.string().min(1),
    offer: Machine.Offer,
  })
  .strict();
const Configuration = z.union([UnixConfiguration, TcpConfiguration]);

/**
 * Real time and real entropy; tests inject their own through the daemon API.
 * Only TCP attachments reconnect: a network between daemon and host blips, a
 * same-box unix host that went away is a shutdown and the daemon exits with it.
 */
/** Production composition of the existing daemon wire, not a second daemon implementation. */
export function attachConfiguredMachine(configPath: string, id: () => string) {
  return Effect.gen(function* () {
    const context = yield* Effect.context();
    const reconnect: ReconnectOptions = {
      scheduler: {
        schedule(delayMs, task) {
          const fiber = Effect.runForkWith(context)(
            Effect.sleep(delayMs).pipe(Effect.tap(() => Effect.sync(task))),
          );
          return () => { void Effect.runPromiseWith(context)(Fiber.interrupt(fiber)); };
        },
      },
      random: Math.random,
    };
    const contents = yield* Effect.tryPromise({ try: () => Bun.file(configPath).text(), catch: foreignFailure((fields) => new MachinesFailure(fields), "configuration.read") });
    const config = yield* Effect.try({ try: () => Configuration.parse(JSON.parse(contents)), catch: foreignFailure((fields) => new MachinesFailure(fields), "configuration.decode") });
    const mode = yield* createCodemode({ id });
    const common = {
      id,
      // #1312: injected IPC callback bound for the remote machine daemon.
      dispatcherBound: 256,
      offer: config.offer,
      fsExports: new Map((config.offer.exports ?? []).map((entry) => [entry.name, entry.path])),
      runner: mode.runner,
    };
    if ("socketPath" in config) {
      return yield* attachMachineDaemon({ ...common, socketPath: config.socketPath });
    }
    const identity = yield* Effect.try({
      try: () => ({
        hostCertificate: readFileSync(config.hostCertificate, "utf8"),
        tlsCertificate: readFileSync(config.tlsCertificate, "utf8"),
        tlsPrivateKey: readFileSync(config.tlsPrivateKey, "utf8"),
      }),
      catch: foreignFailure((fields) => new MachinesFailure(fields), "configuration.tls"),
    });
    return yield* attachMachineDaemon({
      ...common,
      reconnect,
      tcp: config.tcp,
      ...identity,
    });
  });
}
