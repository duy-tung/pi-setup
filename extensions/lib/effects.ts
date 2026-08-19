/**
 * Revertible-effect tracking for pi extensions, after the Cordis discipline
 * ("A Programming Paradigm for Spatiotemporal Composability", §5.1.1): every
 * side effect is created together with its inverse in one callback, and the
 * runtime — here, this helper — owns the bookkeeping.
 *
 *   const effect = effects(pi);
 *   effect(() => {
 *     const t = setInterval(poll, MS);
 *     return () => clearInterval(t);
 *   });
 *
 * What this buys over pairing by hand:
 *   - locality: the inverse lives next to the effect, so adding a fourth timer
 *     cannot forget its cleanup in a shutdown handler three screens away;
 *   - LIFO recovery: inverses run in reverse creation order on
 *     session_shutdown, so an effect built on top of another is torn down first;
 *   - at-most-once: each dispose is armed once; calling it early (dynamic
 *     stop/restart) removes it from the shutdown sweep instead of firing twice.
 *
 * The inverse actually reverting its effect is the author's obligation, not a
 * property this helper verifies (the paper's §6.1 boundary). Effects that
 * outlive the process — tmux sessions, lock files, shadow repos — cannot be
 * recovered by an in-process inverse at all; those need reconciliation on the
 * next run (see tree-rewind/reaper.ts), not this.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Dispose = () => void | Promise<void>;

/**
 * Returns an `effect` function bound to this extension instance. Call it once
 * per extension, at the top of the default export.
 */
export function effects(pi: ExtensionAPI) {
	let stack: Dispose[] = [];

	pi.on("session_shutdown", async () => {
		// Detach before running: an inverse that itself registers effects must
		// not grow the list being swept.
		const pending = stack;
		stack = [];
		for (let i = pending.length - 1; i >= 0; i--) {
			try {
				await pending[i]();
			} catch {
				// One failed inverse must not stop the rest of the teardown.
			}
		}
	});

	return function effect(callback: () => Dispose): Dispose {
		let armed = true;
		const inverse = callback();
		const dispose: Dispose = async () => {
			if (!armed) return;
			armed = false;
			const i = stack.indexOf(dispose);
			if (i >= 0) stack.splice(i, 1);
			await inverse();
		};
		stack.push(dispose);
		return dispose;
	};
}
