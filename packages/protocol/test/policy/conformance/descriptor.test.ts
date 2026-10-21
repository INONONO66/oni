import { describe, expect, test } from "bun:test";
import { Policy } from "../../../src/policy/index.js";
import type { JsonShapedValue } from "../../../src/json.js";

function canonicalize(value: JsonShapedValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));

    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function digestDescriptor(descriptor: Policy.Resource.Descriptor): string {
  const { digest: _digest, ...content } = descriptor;
  let hash = 0x811c9dc5;

  for (const char of canonicalize(content)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }

  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function withDigest(descriptor: Policy.Resource.Descriptor): Policy.Resource.Descriptor {
  return Policy.Resource.Descriptor.parse({
    ...descriptor,
    digest: digestDescriptor(descriptor),
  });
}

function redactDescriptor(descriptor: Policy.Resource.Descriptor): Policy.Resource.Descriptor {
  if (descriptor.source?.type !== "file") return descriptor;

  return Policy.Resource.Descriptor.parse({
    ...descriptor,
    source: {
      ...descriptor.source,
      ...(descriptor.source.path === undefined ? {} : { path: "[REDACTED]" }),
      ...(descriptor.source.filePath === undefined ? {} : { filePath: "[REDACTED]" }),
    },
  });
}

function serializeForAudit(descriptor: Policy.Resource.Descriptor): string {
  return JSON.stringify(redactDescriptor(descriptor));
}

const descriptorFixtures: Policy.Resource.Descriptor[] = [
  Policy.Resource.Descriptor.parse({
    id: "tool:system:bash",
    kind: "tool",
    labels: ["source:system", "tool.shell"],
    capabilities: ["shell.exec"],
    effects: ["workspace.mutate"],
    source: { type: "system" },
    risk: 3,
  }),
  Policy.Resource.Descriptor.parse({
    id: "tool:mcp:filesystem-read",
    kind: "tool",
    labels: ["source:mcp", "mcp.filesystem"],
    capabilities: ["file.read"],
    effects: ["workspace.read"],
    source: { type: "mcp", serverId: "filesystem", remoteName: "read_file" },
  }),
  Policy.Resource.Descriptor.parse({
    id: "tool:skill-mcp:publish",
    kind: "tool",
    labels: ["source:skill-mcp", "skill.github-workflow"],
    capabilities: ["github.write"],
    effects: ["network.write"],
    source: {
      type: "skill-mcp",
      serverId: "github",
      remoteName: "create_pull_request",
      skillId: "github-workflow",
    },
  }),
  Policy.Resource.Descriptor.parse({
    id: "tool:agent:sendMessage",
    kind: "tool",
    labels: ["source:agent", "message.session"],
    capabilities: ["child.spawn"],
    effects: ["session.create"],
    source: { type: "agent", agentId: "main-persona", agentProfileRef: "agent-profile:main" },
  }),
  Policy.Resource.Descriptor.parse({
    id: "tool:server:telegram-send",
    kind: "tool",
    labels: ["source:server", "surface.telegram"],
    capabilities: ["message.send"],
    effects: ["network.write"],
    source: { type: "server", serverId: "server-main", remoteName: "telegram.send" },
  }),
  Policy.Resource.Descriptor.parse({
    id: "skill:project:git-master",
    kind: "skill",
    labels: ["source:project", "skill.git"],
    capabilities: ["behavior.inject"],
    effects: ["prompt.modify"],
    source: { type: "project", projectId: "oni", path: ".opencode/skill/git-master" },
  }),
  Policy.Resource.Descriptor.parse({
    id: "mcpSource:server:filesystem",
    kind: "mcpSource",
    labels: ["source:server", "mcp.filesystem"],
    capabilities: ["tool.catalog"],
    effects: ["tool.expose"],
    source: { type: "server", serverId: "filesystem" },
  }),
  Policy.Resource.Descriptor.parse({
    id: "credential:anthropic:api-key",
    kind: "credential",
    labels: ["source:file", "credential.anthropic"],
    capabilities: [],
    effects: [],
    source: { type: "file", path: "/var/oni/secrets/anthropic.json" },
  }),
  Policy.Resource.Descriptor.parse({
    id: "policy:operator:default",
    kind: "policy",
    labels: ["source:user", "policy.default"],
    capabilities: ["policy.evaluate"],
    effects: ["runtime.govern"],
    source: { type: "user", userId: "operator" },
  }),
];

function firstFixture(): Policy.Resource.Descriptor {
  const [descriptor] = descriptorFixtures;
  if (descriptor === undefined) throw new Error("descriptor fixture missing");
  return descriptor;
}

describe("Policy.Resource.Descriptor conformance", () => {
  test("roundtrip serializes and validates every descriptor kind", () => {
    for (const descriptor of descriptorFixtures) {
      const parsed = Policy.Resource.Descriptor.parse(descriptor);
      const serialized = JSON.stringify(parsed);
      const restored = Policy.Resource.Descriptor.parse(JSON.parse(serialized));

      expect(restored).toEqual(parsed);
    }
  });

  test("digest is stable for the same content and changes with descriptor content", () => {
    const base = firstFixture();
    const sameContent = withDigest(Policy.Resource.Descriptor.parse({ ...base }));
    const repeated = withDigest(Policy.Resource.Descriptor.parse({ ...base }));
    const changedContent = withDigest(
      Policy.Resource.Descriptor.parse({
        ...base,
        labels: [...base.labels, "risk.shell"],
      }),
    );

    expect(sameContent.digest).toBe(repeated.digest);
    expect(changedContent.digest).not.toBe(sameContent.digest);
    expect(Policy.Resource.Descriptor.parse(sameContent).digest).toBe(sameContent.digest);
  });

  test("redact removes credential source paths from serialized descriptors", () => {
    const secretPath = "/var/oni/secrets/anthropic.json";
    const credential = Policy.Resource.Descriptor.parse({
      id: "credential:anthropic:api-key",
      kind: "credential",
      labels: ["source:file", "credential.anthropic"],
      capabilities: [],
      effects: [],
      source: { type: "file", path: secretPath },
    });
    const serialized = serializeForAudit(credential);

    expect(serialized.includes("[REDACTED]")).toBe(true);
    expect(serialized.includes(secretPath)).toBe(false);
    expect(Policy.Resource.Descriptor.parse(JSON.parse(serialized)).source).toMatchObject({
      type: "file",
      path: "[REDACTED]",
    });
  });
});
