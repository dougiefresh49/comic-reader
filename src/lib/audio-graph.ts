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
 * app, created on first play, never closed. The destination holds every
 * connected gain and source, so the WeakMap alone frees nothing: `disconnect`
 * unwires an element its owner is done with, and then both can be collected.
 */
let sharedCtx: AudioContext | null = null;
const nodes = new WeakMap<
  HTMLAudioElement,
  { source: MediaElementAudioSourceNode; gain: GainNode }
>();

/**
 * WebKit lets a context resume only inside a gesture's activation window,
 * so call this on the task that follows a tap or slider move, never from a
 * later timer. Any state but "running" resumes: "suspended", and the
 * "interrupted" iOS leaves after a call, another app's audio or a
 * backgrounded tab (the context is never closed). The guard only skips a
 * no-op promise. A rejection is swallowed; the next gesture tries again.
 */
export function resumeContext() {
  if (sharedCtx && sharedCtx.state !== "running") {
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
  resumeContext();
  const existing = nodes.get(el);
  if (existing) return existing.gain;
  const gain = sharedCtx.createGain();
  gain.gain.value = level;
  const source = sharedCtx.createMediaElementSource(el);
  source.connect(gain).connect(sharedCtx.destination);
  nodes.set(el, { source, gain });
  return gain;
}

/**
 * Unwires `el` so the destination no longer holds its gain and source, and
 * the element can be collected. An element bound to a
 * MediaElementAudioSourceNode never outputs on its own again, so call this
 * only when the owner lets go of the element for good, never on a pause or
 * a page turn that keeps the clip for the play button. No-op for an element
 * that was never connected.
 */
export function disconnect(el: HTMLAudioElement): void {
  const entry = nodes.get(el);
  if (!entry) return;
  entry.source.disconnect();
  entry.gain.disconnect();
  nodes.delete(el);
}

/** A layer at zero is also muted, which silences it even if the context cannot run. */
export function applyLevel(el: HTMLAudioElement | null, level: number) {
  if (!el) return;
  resumeContext();
  el.muted = level === 0;
  const entry = nodes.get(el);
  if (entry) entry.gain.gain.value = level;
}
