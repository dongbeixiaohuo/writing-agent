import type { ModelError } from "./types.js";

/** Per-phase transport deadlines. Headers and heartbeats are not content progress. */
export class TransportDeadline {
  private readonly controller = new AbortController();
  private readonly startedAt = Date.now();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstResponseMs: number | null = null;
  private lastActivityMs: number | null = null;
  private expiredPhase: "first_response" | "stream_idle" | null = null;
  private readonly onUserAbort = (): void => this.controller.abort();

  readonly signal = this.controller.signal;

  constructor(
    private readonly firstResponseTimeoutMs: number,
    private readonly streamIdleTimeoutMs: number,
    userSignal?: AbortSignal,
  ) {
    if (userSignal?.aborted) this.controller.abort();
    else userSignal?.addEventListener("abort", this.onUserAbort, { once: true });
    this.userSignal = userSignal;
    if (!this.signal.aborted) this.arm("first_response");
  }

  private readonly userSignal: AbortSignal | undefined;

  content(): void {
    if (this.signal.aborted) return;
    const elapsed = Date.now() - this.startedAt;
    if (this.firstResponseMs === null) this.firstResponseMs = elapsed;
    this.lastActivityMs = elapsed;
    this.arm("stream_idle");
  }

  error(providerRequestId?: string): ModelError | undefined {
    if (this.expiredPhase === null) return undefined;
    return {
      code: "TIMEOUT",
      message: this.expiredPhase === "first_response"
        ? "模型服务未及时返回有效内容"
        : "模型服务流式输出已停顿",
      retryable: true,
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
      transport: {
        phase: this.expiredPhase,
        timeoutMs: this.expiredPhase === "first_response"
          ? this.firstResponseTimeoutMs
          : this.streamIdleTimeoutMs,
        elapsedMs: Date.now() - this.startedAt,
        firstResponseMs: this.firstResponseMs,
        lastActivityMs: this.lastActivityMs,
      },
    };
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.userSignal?.removeEventListener("abort", this.onUserAbort);
    // Also close an unread or partially read response when the caller ends iteration.
    if (!this.signal.aborted) this.controller.abort();
  }

  private arm(phase: "first_response" | "stream_idle"): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    const delay = phase === "first_response"
      ? this.firstResponseTimeoutMs
      : this.streamIdleTimeoutMs;
    this.timer = setTimeout(() => {
      this.expiredPhase = phase;
      this.controller.abort();
    }, delay);
  }
}
