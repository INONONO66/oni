const SILENCE_MS = 15_000;

/** Each attachment owns its own liveness deadline and at most one outstanding probe. */
export class PingLiveness {
  private readonly peers = new Map<string, { lastAccepted: number; probing: boolean }>();

  attach(key: string, at: number): void {
    this.peers.set(key, { lastAccepted: at, probing: false });
  }

  detach(key: string): void {
    this.peers.delete(key);
  }

  expired(key: string, at: number): boolean {
    const peer = this.peers.get(key);
    return peer !== undefined && at - peer.lastAccepted >= SILENCE_MS;
  }

  begin(key: string): boolean {
    const peer = this.peers.get(key);
    if (peer === undefined || peer.probing) return false;
    peer.probing = true;
    return true;
  }

  finish(key: string, at: number, accepted: boolean): void {
    const peer = this.peers.get(key);
    if (peer === undefined) return;
    peer.probing = false;
    if (accepted && at - peer.lastAccepted < SILENCE_MS) peer.lastAccepted = at;
  }
}
