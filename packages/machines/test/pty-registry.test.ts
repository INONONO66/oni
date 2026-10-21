import { describe, expect, test } from "bun:test";
import { Machine } from "@oni/protocol";
import { createPtyRegistry, PTY_LIVE_RETAIN_MAX_BYTES } from "../src/pty-registry";

function opened(generation = "gen-a") {
  const registry = createPtyRegistry(generation);
  const record = registry.register("qa");
  record.replay = Buffer.from("replayed\n");
  record.attached = true;
  return { registry, record };
}

describe("pty session registry", () => {
  test("a fresh cursor replays the snapshot, then live output, exactly once", () => {
    const { registry, record } = opened();
    registry.append(record, Buffer.from("live-1\n"));
    const first = registry.read(record, undefined);
    expect(first.data.toString("utf8")).toBe("replayed\nlive-1\n");
    expect(first.truncated).toBe(false);
    registry.append(record, Buffer.from("live-2\n"));
    const second = registry.read(record, first.cursor);
    expect(second.data.toString("utf8")).toBe("live-2\n");
    const third = registry.read(record, second.cursor);
    expect(third.data.toString("utf8")).toBe("");
    expect(third.cursor).toBe(second.cursor);
  });

  test("the open cursor token is the start of the retained stream", () => {
    const { registry, record } = opened();
    expect(registry.read(record, registry.startCursor()).data.toString("utf8")).toBe("replayed\n");
  });

  test("over-cap output returns the bounded suffix and a cursor past everything", () => {
    const { registry, record } = opened();
    registry.append(record, Buffer.alloc(Machine.PTY_READ_MAX_BYTES, 0x61));
    registry.append(record, Buffer.from("tail"));
    const view = registry.read(record, undefined);
    expect(view.truncated).toBe(true);
    expect(view.data.length).toBe(Machine.PTY_READ_MAX_BYTES);
    expect(view.data.subarray(view.data.length - 4).toString("utf8")).toBe("tail");
    // The cursor advanced past ALL observed output: the next read is empty.
    expect(registry.read(record, view.cursor).data.length).toBe(0);
  });

  test("bytes beyond the retention bound surface as truncation, never a loop", () => {
    const { registry, record } = opened();
    const consumed = registry.read(record, undefined);
    registry.append(record, Buffer.alloc(PTY_LIVE_RETAIN_MAX_BYTES, 0x62));
    registry.append(record, Buffer.alloc(PTY_LIVE_RETAIN_MAX_BYTES, 0x63));
    const view = registry.read(record, consumed.cursor);
    expect(view.truncated).toBe(true);
    expect(registry.read(record, view.cursor).truncated).toBe(false);
  });

  test("a cursor minted by an earlier daemon generation resumes after the snapshot", () => {
    const { registry, record } = opened("gen-b");
    registry.append(record, Buffer.from("fresh\n"));
    const view = registry.read(record, "p1:gen-a:12345");
    expect(view.data.toString("utf8")).toBe("fresh\n");
    expect(view.truncated).toBe(false);
  });

  test("an unparseable cursor token reads like a foreign generation", () => {
    const { registry, record } = opened();
    registry.append(record, Buffer.from("fresh\n"));
    expect(registry.read(record, "garbage").data.toString("utf8")).toBe("fresh\n");
    expect(registry.read(record, "p1:gen-a:-4").data.toString("utf8")).toBe("fresh\n");
  });

  test("waiters wake on append, removal, and loss; cancel detaches them", () => {
    const { registry, record } = opened();
    const woke: string[] = [];
    registry.awaitOutput(record, () => woke.push("append"));
    registry.append(record, Buffer.from("x"));
    expect(woke).toEqual(["append"]);
    const cancel = registry.awaitOutput(record, () => woke.push("cancelled"));
    cancel();
    registry.awaitOutput(record, () => woke.push("lost"));
    registry.markAllLost();
    expect(record.lost).toBe(true);
    expect(woke).toEqual(["append", "lost"]);
    const other = registry.register("qb");
    registry.awaitOutput(other, () => woke.push("removed"));
    registry.remove("qb");
    expect(other.closed).toBe(true);
    expect(woke).toEqual(["append", "lost", "removed"]);
    expect(registry.names()).toEqual(["qa"]);
  });
});
