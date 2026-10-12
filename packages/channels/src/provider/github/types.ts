import { z } from "zod";

const GitHubUserSchema = z.object({ login: z.string(), type: z.string() });
const GitHubIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  // GitHub sends both null and empty-string bodies.
  body: z.string().nullish(),
  // Presence flag only — an issue payload carrying `pull_request` is a PR.
  pull_request: z.object({}).optional(),
  user: GitHubUserSchema,
});
const GitHubRepositorySchema = z.object({
  full_name: z.string(),
  owner: z.object({ login: z.string() }),
  name: z.string(),
});
/**
 * Wire schemas for the two webhook payloads the surface consumes — THE typed
 * boundary where a signature-verified body becomes data. A payload that does
 * not parse is an unsupported event, never a duck-typed walk.
 */
export const GitHubWebhookPayloadSchemas = {
  issue_comment: z.object({
    action: z.string(),
    issue: GitHubIssueSchema,
    comment: z.object({ id: z.number(), body: z.string(), user: GitHubUserSchema }),
    sender: GitHubUserSchema.optional(),
    repository: GitHubRepositorySchema,
  }),
  issues: z.object({
    action: z.string(),
    issue: GitHubIssueSchema,
    sender: GitHubUserSchema.optional(),
    repository: GitHubRepositorySchema,
  }),
  pull_request: z.object({
    action: z.string(),
    pull_request: z.object({
      number: z.number(),
      title: z.string(),
      body: z.string().nullish(),
      user: GitHubUserSchema,
    }),
    sender: GitHubUserSchema.optional(),
    repository: GitHubRepositorySchema,
  }),
} as const;
