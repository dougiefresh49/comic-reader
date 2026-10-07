/**
 * Loudness goes through Web Audio, never `el.volume`: iOS WebKit ignores
 * writes to `HTMLMediaElement.volume` (it reads back 1), so a slider that
 * set it did nothing on an iPad (#609 for the music, effects and ambience
 * layers, #611 for the dialogue voices). Every browser takes this path.
 *
 * The graph lives at module level and outlives any effect cleanup: an
 * element connected to a MediaElementAudioSourceNode stays bound to it for
 * life, so a StrictMode double pass or remount must find the existing gain
 * rather than connect the element again (which throws). One context for the
 * app, created on first play, never closed; the WeakMap lets an unmounted
 * element and its nodes be collected.
 */
let sharedCtx: AudioContext | null = null;
const gains = new WeakMap<HTMLAudioElement, GainNode>();

/** The app's one context, or null before anything has played. */
export function sharedContext(): AudioContext | null {
  return sharedCtx;
}

/**
 * WebKit lets a context resume only inside a gesture's activation window,
 * so call this on the task that follows a tap or slider move, never from a
 * later timer. A rejection is swallowed; the next gesture tries again.
 */
function resumeIfSuspended() {
  if (sharedCtx?.state === "suspended") {
    void sharedCtx.resume().catch(() => undefined);
  }
}

/**
 * Routes `el` through its own GainNode on first use. The context is created
 * here, the first time a layer is about to play, never at render or mount,
 * and resumed at once: the music effect calls this on the tap's task, while
 * its first `play()` waits out the 800 ms crossfade.
 */
export function ensureConnected(el: HTMLAudioElement, level: number): GainNode {
  sharedCtx ??= new AudioContext();
  resumeIfSuspended();
  const existing = gains.get(el);
  if (existing) return existing;
  const gain = sharedCtx.createGain();
  gain.gain.value = level;
  sharedCtx
    .createMediaElementSource(el)
    .connect(gain)
    .connect(sharedCtx.destination);
  gains.set(el, gain);
  return gain;
}

/** A layer at zero is also muted, which silences it even if the context cannot run. */
export function applyLevel(el: HTMLAudioElement | null, level: number) {
  if (!el) return;
  resumeIfSuspended();
  el.muted = level === 0;
  const gain = gains.get(el);
  if (gain) gain.gain.value = level;
}
