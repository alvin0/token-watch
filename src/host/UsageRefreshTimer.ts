type TimerHandle = ReturnType<typeof setTimeout>;

interface TimerRuntime {
  now(): number;
  setTimeout(callback: () => void, delay: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const defaultRuntime: TimerRuntime = {
  now: Date.now,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle),
};

export class UsageRefreshTimer {
  private handle: TimerHandle | undefined;

  constructor(
    private readonly callback: () => void,
    private readonly runtime: TimerRuntime = defaultRuntime,
  ) {}

  schedule(retryAtUtc?: number): void {
    this.clear();
    if (typeof retryAtUtc !== "number" || !Number.isFinite(retryAtUtc)) {
      return;
    }
    const delay = Math.max(0, retryAtUtc - this.runtime.now());
    this.handle = this.runtime.setTimeout(() => {
      this.handle = undefined;
      this.callback();
    }, delay);
  }

  clear(): void {
    if (this.handle !== undefined) {
      this.runtime.clearTimeout(this.handle);
      this.handle = undefined;
    }
  }
}
