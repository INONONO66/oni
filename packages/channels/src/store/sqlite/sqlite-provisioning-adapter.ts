import type { Database } from "bun:sqlite";
import { Provisioning, type Storage as ProtocolStorage } from "@oni/protocol";
import { z } from "zod";
import { sqliteJsonData } from "./json";

const PersonRow = sqliteJsonData(Provisioning.Person);
const ChannelInstanceRow = sqliteJsonData(Provisioning.ChannelInstance);

/**
 * Provisioning rows (migration 0029). Person and ChannelInstance persist as
 * schema-validated JSON `data` with the queryable columns lifted out; Secret
 * persists its envelope blobs as real BLOB columns — there is no JSON path a
 * plaintext could ride, and no plaintext column exists (§8.2).
 */

const SecretRowSchema = z.object({
  id: z.string(),
  ciphertext: z.instanceof(Uint8Array),
  wrapped_dek: z.instanceof(Uint8Array),
  kek_id: z.string(),
  purpose: z.string(),
  time_created: z.number(),
  rotated_at: z.number().nullable(),
});

function secretOfRow(row: z.infer<typeof SecretRowSchema>): Provisioning.Secret {
  return Provisioning.Secret.parse({
    id: row.id,
    ciphertext: row.ciphertext,
    wrappedDek: row.wrapped_dek,
    kekId: row.kek_id,
    purpose: row.purpose,
    createdAt: row.time_created,
    ...(row.rotated_at === null ? {} : { rotatedAt: row.rotated_at }),
  });
}

export function createSqliteProvisioningAdapter(
  db: Database,
  now: () => number,
): ProtocolStorage.ProvisioningSubAdapter {
  return {
    getPerson(id) {
      return (
        PersonRow.nullable().parse(db.query("SELECT data FROM person WHERE id = ?").get(id)) ??
        undefined
      );
    },
    setPerson(person) {
      const at = now();
      db.query(
        `INSERT INTO person (id, trust_tier, data, revision, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           trust_tier = excluded.trust_tier,
           data = excluded.data,
           revision = excluded.revision,
           time_updated = excluded.time_updated`,
      ).run(person.id, person.trustTier, JSON.stringify(person), person.revision, at, at);
    },
    listPersons() {
      return PersonRow.array().parse(
        db.query("SELECT data FROM person ORDER BY time_created ASC, id ASC").all(),
      );
    },
    removePerson(id) {
      return db.query("DELETE FROM person WHERE id = ?").run(id).changes > 0;
    },
    getChannelInstance(id) {
      return (
        ChannelInstanceRow.nullable().parse(
          db.query("SELECT data FROM channel_instance WHERE id = ?").get(id),
        ) ?? undefined
      );
    },
    setChannelInstance(instance) {
      const at = now();
      db.query(
        `INSERT INTO channel_instance (id, provider, enabled, data, revision, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           enabled = excluded.enabled,
           data = excluded.data,
           revision = excluded.revision,
           time_updated = excluded.time_updated`,
      ).run(
        instance.id,
        instance.provider,
        instance.enabled ? 1 : 0,
        JSON.stringify(instance),
        instance.revision,
        at,
        at,
      );
    },
    listChannelInstances() {
      return ChannelInstanceRow.array().parse(
        db.query("SELECT data FROM channel_instance ORDER BY time_created ASC, id ASC").all(),
      );
    },
    removeChannelInstance(id) {
      return db.query("DELETE FROM channel_instance WHERE id = ?").run(id).changes > 0;
    },
    getSecret(id) {
      const row = SecretRowSchema.nullable().parse(
        db
          .query(
            "SELECT id, ciphertext, wrapped_dek, kek_id, purpose, time_created, rotated_at FROM secret WHERE id = ?",
          )
          .get(id),
      );
      return row ? secretOfRow(row) : undefined;
    },
    setSecret(secret) {
      db.query(
        `INSERT INTO secret (id, ciphertext, wrapped_dek, kek_id, purpose, time_created, rotated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           wrapped_dek = excluded.wrapped_dek,
           kek_id = excluded.kek_id,
           purpose = excluded.purpose,
           rotated_at = excluded.rotated_at`,
      ).run(
        secret.id,
        secret.ciphertext,
        secret.wrappedDek,
        secret.kekId,
        secret.purpose,
        secret.createdAt,
        secret.rotatedAt ?? null,
      );
    },
    listSecrets() {
      const rows = z
        .array(SecretRowSchema)
        .parse(
          db
            .query(
              "SELECT id, ciphertext, wrapped_dek, kek_id, purpose, time_created, rotated_at FROM secret ORDER BY time_created ASC, id ASC",
            )
            .all(),
        );
      return rows.map(secretOfRow);
    },
    removeSecret(id) {
      return db.query("DELETE FROM secret WHERE id = ?").run(id).changes > 0;
    },
  };
}
