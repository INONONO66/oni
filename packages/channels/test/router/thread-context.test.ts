import { runEffect } from "../helpers/effect";
import { beforeEach, expect, test } from "bun:test";
import { commits, kernelRouter, ownerFacts, ownerSender, registerOwnerDm, resetRouterState } from "./_router-fixture";

beforeEach(() => {
  resetRouterState();
  registerOwnerDm();
});

const thread = [
  { author: "<@U1>", text: "deploy is red" },
  { author: "assistant", text: "looking" },
];

test("thread history seeds the first prompt of a thread session and no later one (#1490)", async () => {
  const router = kernelRouter();
  const inThread = { ...ownerFacts, reply: { chain: ["root"], threadId: "root" }, context: { thread } };
  await runEffect(router.ingest(ownerSender, { ...inThread, eventId: "first", render: "still red?" }));
  await runEffect(router.ingest(ownerSender, { ...inThread, eventId: "second", render: "any news?" }));
  expect(commits.map((commit) => commit.content)).toEqual([
    "[earlier in this thread]\n<@U1>: deploy is red\nassistant: looking\n[end of thread]\n\nstill red?",
    "any news?",
  ]);
  expect(new Set(commits.map((commit) => commit.sessionId)).size).toBe(1);
});

test("a quoted message is shown with every prompt that answers one (#1490)", async () => {
  const router = kernelRouter();
  const quoted = { author: "@seller", text: "shipped\ntoday" };
  await runEffect(router.ingest(ownerSender, { ...ownerFacts, eventId: "q1", render: "tracking?", context: { quoted } }));
  await runEffect(router.ingest(ownerSender, { ...ownerFacts, eventId: "q2", render: "and eta?", context: { quoted } }));
  expect(commits.map((commit) => commit.content)).toEqual([
    "[replying to @seller]\n> shipped\n> today\n\ntracking?",
    "[replying to @seller]\n> shipped\n> today\n\nand eta?",
  ]);
});
