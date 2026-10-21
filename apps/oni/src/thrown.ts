/**
 * Typed views of caught values. zod is the narrowing layer for anything a
 * throw site can produce, so no `catch` binding or mapper parameter in this
 * app carries `unknown`: `Result.try`/`Effect.try`/promise rejection seams
 * pass `.parse` by reference and receive schema-typed values back.
 */

import { z } from "zod";

/** The channel-visible text of a thrown value: an Error's message, anything else stringified. */
export const CauseText = z.union([z.instanceof(Error).transform((error) => error.message), z.coerce.string()]);

/** The thrown value as an Error: preserved when it already is one, wrapped otherwise. */
export const ThrownError = z.union([z.instanceof(Error), z.coerce.string().transform((text) => new Error(text))]);
