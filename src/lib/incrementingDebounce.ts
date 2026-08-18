export interface IncrementingDebounceSnapshot<T> {
	readonly pending: boolean;
	readonly delayMs: number;
	readonly value: T | null;
}

export interface IncrementingDebounceOptions<T> {
	minDelayMs?: number;
	maxDelayMs?: number;
	stepMs?: number;
	/** After this much quiet time following a fired call, the delay returns to min. */
	quietResetMs?: number;
	onStateChange?: (snapshot: IncrementingDebounceSnapshot<T>) => void;
}

/**
 * Trailing-edge debounce for user-triggered network work.
 *
 * First click waits `minDelayMs`. Every extra click while that request is
 * pending cancels the previous timer, keeps only the newest value, and adds
 * `stepMs` up to `maxDelayMs`. A burst therefore produces ONE call, never N
 * calls, and increasingly bored clicking makes the caller wait longer rather
 * than hammering the upstream service.
 *
 * The elevated delay survives the fired call until a quiet period elapses, so
 * repeated bursts cannot trivially bypass the backoff by waiting for each
 * request to start. `cancel()` is the hard reset used when the underlying
 * resource changes or the owning component is destroyed.
 */
export class IncrementingDebouncer<T> {
	private readonly minDelayMs: number;
	private readonly maxDelayMs: number;
	private readonly stepMs: number;
	private readonly quietResetMs: number;
	private readonly run: (value: T) => void;
	private readonly onStateChange?: (snapshot: IncrementingDebounceSnapshot<T>) => void;

	private delayMs: number;
	private pending = false;
	private value: T | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private quietResetTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(run: (value: T) => void, options: IncrementingDebounceOptions<T> = {}) {
		this.minDelayMs = options.minDelayMs ?? 2000;
		this.maxDelayMs = options.maxDelayMs ?? 5000;
		this.stepMs = options.stepMs ?? 1000;
		this.quietResetMs = options.quietResetMs ?? 10000;
		this.onStateChange = options.onStateChange;
		this.run = run;
		if (
			![this.minDelayMs, this.maxDelayMs, this.stepMs, this.quietResetMs].every(Number.isFinite) ||
			this.minDelayMs < 0 ||
			this.maxDelayMs < this.minDelayMs ||
			this.stepMs < 0 ||
			this.quietResetMs < 0
		) {
			throw new Error('IncrementingDebouncer requires non-negative finite delays and maxDelayMs >= minDelayMs.');
		}
		this.delayMs = this.minDelayMs;
		this.emit();
	}

	snapshot(): IncrementingDebounceSnapshot<T> {
		return { pending: this.pending, delayMs: this.delayMs, value: this.value };
	}

	schedule(value: T): void {
		if (this.quietResetTimer !== null) {
			clearTimeout(this.quietResetTimer);
			this.quietResetTimer = null;
		}
		if (this.pending) {
			this.delayMs = Math.min(this.maxDelayMs, this.delayMs + this.stepMs);
		}
		this.pending = true;
		this.value = value;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = setTimeout(() => this.fire(), this.delayMs);
		this.emit();
	}

	cancel(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		if (this.quietResetTimer !== null) clearTimeout(this.quietResetTimer);
		this.timer = null;
		this.quietResetTimer = null;
		this.pending = false;
		this.value = null;
		this.delayMs = this.minDelayMs;
		this.emit();
	}

	private fire(): void {
		this.timer = null;
		const value = this.value;
		this.pending = false;
		this.value = null;
		this.emit();
		if (value !== null) this.run(value);
		if (this.quietResetMs === 0) {
			this.resetDelayIfQuiet();
			return;
		}
		this.quietResetTimer = setTimeout(() => this.resetDelayIfQuiet(), this.quietResetMs);
	}

	private resetDelayIfQuiet(): void {
		this.quietResetTimer = null;
		if (this.pending) return;
		if (this.delayMs === this.minDelayMs) return;
		this.delayMs = this.minDelayMs;
		this.emit();
	}

	private emit(): void {
		this.onStateChange?.(this.snapshot());
	}
}
