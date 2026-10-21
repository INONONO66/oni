import { Actor, PlainValueSchema } from "@oni/protocol";
import { z } from "zod";

// Actor metadata crosses a JSON persistence boundary; arbitrary JS values cannot round-trip.
const metadata = z.record(z.string(), PlainValueSchema).optional();
export const StoredIdentity = Actor.Identity.extend({ metadata });
export const StoredEndpoint = Actor.Endpoint.extend({ metadata });
