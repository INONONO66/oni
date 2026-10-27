import { createHash, X509Certificate } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { MachinesFailure } from "@oni/machines";
import { Machine } from "@oni/protocol";
import { z } from "zod";
import { foreignFailure } from "../composition/failure";
import { spawnMclient, writeMclientSettings } from "../composition/mclient";

/**
 * Two ways to reach a host, named explicitly: same-box over the unix socket,
 * or across the network — the daemon verifies the host's CERTIFICATE through
 * the TLS chain (its key fingerprint is the pin), the host pins the daemon's
 * key via its enrollment. The TLS fields and `hostCertificate` are PEM file
 * PATHS (read at attach time), so key material never sits in the JSON.
 */
const DaemonOffer = Machine.Offer.omit({ peer: true, generation: true });
const UnixConfiguration = z
  .object({ socketPath: z.string().min(1), offer: DaemonOffer })
  .strict();
const TcpConfiguration = z
  .object({
    tcp: z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535) }).strict(),
    hostCertificate: z.string().min(1),
    tlsCertificate: z.string().min(1),
    tlsPrivateKey: z.string().min(1),
    offer: DaemonOffer,
  })
  .strict();
const Configuration = z.union([UnixConfiguration, TcpConfiguration]);

/** Translate the CLI's PEM-path config into the Rust client's persisted settings. */
export function attachConfiguredMachine(configPath: string) {
  return Effect.gen(function* () {
    const contents = yield* Effect.tryPromise({ try: () => Bun.file(configPath).text(), catch: foreignFailure((fields) => new MachinesFailure(fields), "configuration.read") });
    const config = yield* Effect.try({ try: () => Configuration.parse(JSON.parse(contents)), catch: foreignFailure((fields) => new MachinesFailure(fields), "configuration.decode") });
    const directory = join(dirname(configPath), `.mclient-${config.offer.machineId}`);
    const path = join(directory, "client.json");
    yield* Effect.try({
      try: () => {
        const unix = "socketPath" in config;
        writeMclientSettings(path, {
          machineId: config.offer.machineId, name: config.offer.machineId,
          host: unix ? "localhost" : `${config.tcp.host.includes(":") ? `[${config.tcp.host}]` : config.tcp.host}:${config.tcp.port}`,
          unix: unix ? config.socketPath : null,
          exports: config.offer.exports ?? [], tags: [], memoryBudgetMb: 96,
        });
        if (unix) return;
        const certificate = new X509Certificate(readFileSync(config.hostCertificate));
        const pin = createHash("sha256").update(certificate.publicKey.export({ type: "spki", format: "der" })).digest("hex");
        for (const [name, value] of [
          ["host-pin", pin],
          ["client-cert.pem", readFileSync(config.tlsCertificate, "utf8")],
          ["client-key.pem", readFileSync(config.tlsPrivateKey, "utf8")],
        ] as const) {
          const target = join(directory, name);
          writeFileSync(target, value, { mode: 0o600 });
          chmodSync(target, 0o600);
        }
      },
      catch: foreignFailure((fields) => new MachinesFailure(fields), "configuration.settings"),
    });
    return yield* spawnMclient(path);
  });
}
