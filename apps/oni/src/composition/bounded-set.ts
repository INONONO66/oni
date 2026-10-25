export function addBounded(set: Set<string>, key: string, capacity: number): void {
  set.add(key);
  for (const oldest of set) {
    if (set.size <= capacity) break;
    set.delete(oldest);
  }
}
