import type { BeforeSubagentSpawnEvent } from "@oh-my-pi/pi-coding-agent";

interface Permit {
  readonly callId: string;
  readonly actionId: string;
  readonly index: number;
  readonly agent: string;
  readonly name?: string;
  /** Already verified exact route, or the captured ordinary Architect role. */
  readonly model?: string;
  readonly constrained: boolean;
  claimed?: string;
}

/** Policy receipts for native task admission, never a job queue or cancellation owner. */
export class NativeSpawnAdmissions {
  private permits: Permit[] = [];
  private readonly claimed = new Map<string, Permit>();

  admit(
    callId: string,
    actionId: string,
    tasks: ReadonlyArray<{ agent: string; name?: string; model?: string; constrained: boolean }>,
  ) {
    if (this.permits.some((permit) => permit.callId === callId)) return;
    this.permits.push(...tasks.map((task, index) => ({ ...task, callId, actionId, index })));
  }
  reject(callId: string) {
    this.permits = this.permits.filter(
      (permit) => permit.callId !== callId || permit.claimed !== undefined,
    );
  }
  /** Session teardown only: stopping Auto must retain already accepted native work. */
  clear() {
    this.permits = [];
    this.claimed.clear();
  }

  resolve(event: BeforeSubagentSpawnEvent): { model?: string } | undefined {
    if (event.invocationKind !== "task") return;
    const key = event.spawnKey;
    if (key && this.claimed.has(key)) {
      const permit = this.claimed.get(key)!;
      return permit.agent === event.agent ? { model: permit.model } : undefined;
    }
    const candidates = this.permits.filter(
      (permit) =>
        !permit.claimed &&
        permit.agent === event.agent &&
        (!permit.constrained || event.patterns?.includes(permit.model!)),
    );
    const score = (permit: Permit) =>
      key && (permit.name === key || `${permit.callId}:${permit.index}` === key)
        ? 3
        : permit.constrained
          ? 2
          : 1;
    candidates.sort((a, b) => score(b) - score(a));
    const permit = candidates[0];
    if (!permit) return;
    // The SDK supplies a unique native spawn key. Without it this one event
    // consumes a permit; no synthetic persistent worker identity is invented.
    permit.claimed = key ?? `unkeyed:${permit.callId}:${permit.index}`;
    if (key) this.claimed.set(key, permit);
    return { model: permit.model };
  }
}
