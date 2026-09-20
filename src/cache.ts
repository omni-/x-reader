import { randomUUID } from "node:crypto";
import { ReaderError } from "./errors.js";

/** In-memory snapshots only: cursors never encode credentials, paths or queries. */
export class ExpiringStore<T> {
  private readonly items = new Map<
    string,
    { key: string; value: T; expires: number }
  >();
  constructor(
    private readonly ttlMs: number,
    private readonly capacity: number,
    private readonly now = Date.now,
  ) {}
  prune(): void {
    for (const [id, entry] of this.items)
      if (entry.expires <= this.now()) this.items.delete(id);
  }
  put(
    key: string,
    value: T,
    expires = this.now() + this.ttlMs,
  ): { id: string; expires: number } {
    this.prune();
    while (this.items.size >= this.capacity)
      this.items.delete(this.items.keys().next().value!);
    const id = randomUUID();
    this.items.set(id, { key, value, expires });
    return { id, expires };
  }
  get(id: string, key?: string): { value: T; expires: number } {
    this.prune();
    const entry = this.items.get(id);
    if (!entry)
      throw new ReaderError(
        "cursor_expired",
        "Cursor or media reference expired, was consumed, was cleared, or belongs to another server. Start a new retrieval.",
      );
    if (key !== undefined && entry.key !== key)
      throw new ReaderError(
        "cursor_mismatch",
        "Cursor does not match this tool and its original arguments.",
      );
    return { value: entry.value, expires: entry.expires };
  }
  take(id: string, key: string): { value: T; expires: number } {
    const entry = this.get(id, key);
    this.items.delete(id);
    return entry;
  }
  clear(): void {
    this.items.clear();
  }
  get size(): number {
    this.prune();
    return this.items.size;
  }
}
