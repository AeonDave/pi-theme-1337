/**
 * A minimal writable surface for observing out-of-band terminal diagnostics.
 * The guard never changes, suppresses, buffers, or duplicates the bytes written.
 */
export interface RedrawWritable {
	write: (this: RedrawWritable, ...args: unknown[]) => boolean;
}

export interface FullRedrawTarget {
	requestRender(force?: boolean): void;
}

export type RedrawScheduler = (task: () => void) => void;

const requestAfterBurst: RedrawScheduler = (task) => queueMicrotask(task);

/** Reset Pi TUI's cached lines/cursor and repaint the complete screen. */
export function forceFullRedraw(target: FullRedrawTarget | undefined): void {
	target?.requestRender(true);
}

/**
 * Observe a stream that writes outside Pi TUI's renderer and request a repair
 * after the original synchronous write burst. The original is called first, with the
 * exact receiver, arguments and return value; only a redraw side effect follows.
 * The default microtask scheduler coalesces adjacent chunks before Pi's next render.
 *
 * Disposal is ownership-safe: if another extension wrapped the stream after us,
 * its writer is left installed and this inactive wrapper becomes pass-through.
 */
export function installOutOfBandRedrawGuard(
	target: RedrawWritable,
	requestFullRedraw: () => void,
	schedule: RedrawScheduler = requestAfterBurst,
): () => void {
	const original = target.write;
	let active = true;
	let queued = false;

	const flush = (): void => {
		queued = false;
		if (!active) return;
		try {
			requestFullRedraw();
		} catch {
			// Cosmetic recovery must never turn a foreign diagnostic into a failure.
		}
	};

	const guarded = function (this: RedrawWritable, ...args: unknown[]): boolean {
		const result = Reflect.apply(original, this, args) as boolean;
		if (active && !queued) {
			queued = true;
			try {
				schedule(flush);
			} catch {
				queued = false;
			}
		}
		return result;
	};

	target.write = guarded;
	return () => {
		active = false;
		queued = false;
		if (target.write === guarded) target.write = original;
	};
}
