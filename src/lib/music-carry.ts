/**
 * Panel music that outlives one page (#983). A page turn is a route change,
 * so it remounts the reader and its panel audio layer. Each layer keeps its
 * music player, and one of these, at module scope; the mount that last
 * turned active owns the music.
 *
 * When the owner unmounts, the music does not stop at once: a pending stop
 * waits out `GRACE_MS`. The next page's layer claims the music when it turns
 * active, which cancels the stop, and the layer's own rule then continues
 * the track or crossfades. With no claim (the reader left for the library,
 * another book, a view without panel audio) the stop fades the music out,
 * and the next play starts fresh.
 */
const GRACE_MS = 3000;

export interface MusicCarry {
  /** Mood and scene of the music last started, for the layer's rule. */
  lastTag: string | null;
  lastSceneId: string | null;
  /** Makes `owner` the mount that plays the music; cancels a pending stop. */
  claim(owner: object): void;
  /**
   * A new page's layer is inactive for its first render; only the owner
   * stops the music then, so the last page's track waits for the claim.
   */
  owns(owner: object): boolean;
  /** On unmount: an owner leaves the music to a pending stop. */
  release(owner: object): void;
}

/** `fadeOutAndStop` runs once the grace window passes with no claim. */
export function createMusicCarry(fadeOutAndStop: () => void): MusicCarry {
  let owner: object | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const carry: MusicCarry = {
    lastTag: null,
    lastSceneId: null,
    claim(next) {
      clearTimeout(timer);
      timer = undefined;
      owner = next;
    },
    owns: (o) => owner === o,
    release(o) {
      if (owner !== o) return;
      owner = null;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        carry.lastTag = null;
        carry.lastSceneId = null;
        fadeOutAndStop();
      }, GRACE_MS);
    },
  };
  return carry;
}
