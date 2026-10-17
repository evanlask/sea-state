// Fixed-size voice allocation for one-shot sounds. Pure bookkeeping: the audio side owns the actual
// nodes per slot and asks the pool which slot to (re)use. Free slots go first; when all are busy
// the lowest-priority, then oldest, voice is stolen, and a sound less important than every playing
// voice is dropped rather than cutting something that matters more.

export class VoicePool {
  readonly size: number;
  private readonly busyUntil: Float64Array;
  private readonly startedAt: Float64Array;
  private readonly priority: Float64Array;
  // Whether the last successful acquire() took a slot that was still sounding.
  lastStolen = false;

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 1) throw new Error(`VoicePool size must be ≥ 1, got ${size}`);
    this.size = size;
    this.busyUntil = new Float64Array(size).fill(-Infinity);
    this.startedAt = new Float64Array(size).fill(-Infinity);
    this.priority = new Float64Array(size);
  }

  // Returns the slot index to play in, or -1 when the sound should be dropped.
  acquire(now: number, endTime: number, priority = 0): number {
    let best = -1;
    let bestPriority = Infinity;
    let bestStart = Infinity;
    for (let i = 0; i < this.size; i++) {
      if ((this.busyUntil[i] ?? 0) <= now) {
        this.claim(i, now, endTime, priority, false);
        return i;
      }
      const p = this.priority[i] ?? 0;
      const s = this.startedAt[i] ?? 0;
      if (p < bestPriority || (p === bestPriority && s < bestStart)) {
        best = i;
        bestPriority = p;
        bestStart = s;
      }
    }
    if (best < 0 || bestPriority > priority) return -1;
    this.claim(best, now, endTime, priority, true);
    return best;
  }

  release(index: number): void {
    if (index >= 0 && index < this.size) this.busyUntil[index] = -Infinity;
  }

  isBusy(index: number, now: number): boolean {
    return (this.busyUntil[index] ?? -Infinity) > now;
  }

  activeCount(now: number): number {
    let n = 0;
    for (let i = 0; i < this.size; i++) if ((this.busyUntil[i] ?? 0) > now) n++;
    return n;
  }

  private claim(i: number, now: number, endTime: number, priority: number, stolen: boolean): void {
    this.busyUntil[i] = Math.max(endTime, now);
    this.startedAt[i] = now;
    this.priority[i] = priority;
    this.lastStolen = stolen;
  }
}
