import { z } from "zod";

const GitHubUserSchema = z.object({ login: z.string(), type: z.string() });

const GitHubIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullish(),
  pull_request: z.object({}).optional(),
  user: GitHubUserSchema,
});

const GitHubRepositorySchema = z.object({
  full_name: z.string(),
  owner: z.object({ login: z.string() }),
  name: z.string(),
});

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
} as const;
