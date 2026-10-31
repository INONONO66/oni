import type { Machine } from "@oni/protocol";

type Entry = {
  readonly machineId: string;
  readonly target: string;
  readonly requestId: Machine.InputRequestId;
  readonly generation: number;
};

export class Reservations {
  private readonly entries = new Map<string, Map<string, Entry>>();
  private readonly sequences = new Map<string, number>();

  nextSequence(machineId: string): number {
    // The sequence resets only with a new host, which CAS-advances persisted generations
    // before accepting input; same-host reconnects retain the sequence, so IDs never repeat.
    const seq = (this.sequences.get(machineId) ?? 0) + 1;
    this.sequences.set(machineId, seq);
    return seq;
  }

  mint(machineId: string, generation: number): Machine.InputRequestId {
    return `${generation}-${this.nextSequence(machineId)}`;
  }

  reserve(machineId: string, generation: number, target: string, requestId = this.mint(machineId, generation)): Entry | "window_busy" {
    const entries = this.entries.get(machineId) ?? new Map<string, Entry>();
    for (const entry of entries.values()) {
      if (target === "*" || entry.target === "*" || entry.target === target) return "window_busy";
    }
    const entry: Entry = { machineId, target, generation, requestId };
    entries.set(requestId, entry);
    this.entries.set(machineId, entries);
    return entry;
  }

  pending(machineId: string): readonly Entry[] {
    return [...(this.entries.get(machineId)?.values() ?? [])];
  }

  release(machineId: string, requestId: string): void {
    this.entries.get(machineId)?.delete(requestId);
  }
}

