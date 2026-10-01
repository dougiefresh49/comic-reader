// THROWAWAY prototype for issue #325.
export type Box = { x: number; y: number; w: number; h: number };
export type ScriptBubble = {
  id: string;
  text: string;
  speaker: string;
  emotion: string;
  type: string;
  ignored: boolean;
  silent: boolean;
  box: Box;
  panel: string;
  duplicateDismissed: boolean;
  fresh?: boolean;
};
export type ScriptPage = {
  number: number;
  image: string;
  width: number;
  height: number;
  panels: Array<{ id: string; box: Box }>;
  bubbles: ScriptBubble[];
};
export function overlap(a: Box, b: Box) {
  return (
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  );
}
export function panelFor(box: Box, page: ScriptPage) {
  return (
    [...page.panels]
      .sort((a, b) => overlap(box, b.box) - overlap(box, a.box))
      .find((p) => overlap(box, p.box) > 0)?.id ?? ""
  );
}
export function likelyDuplicate(b: ScriptBubble, page: ScriptPage) {
  if (b.ignored || b.duplicateDismissed) return false;
  return page.bubbles.some(
    (other) =>
      other.id !== b.id &&
      !other.ignored &&
      overlap(b.box, other.box) /
        Math.max(
          0.000001,
          Math.min(b.box.w * b.box.h, other.box.w * other.box.h),
        ) >
        0.7,
  );
}
export function needsSpeaker(b: ScriptBubble, cast: string[]) {
  return (
    !b.ignored &&
    !b.silent &&
    !["sfx", "background"].includes(b.type) &&
    !cast.includes(b.speaker)
  );
}
export function needsAttention(
  b: ScriptBubble,
  page: ScriptPage,
  cast: string[],
) {
  return needsSpeaker(b, cast) || likelyDuplicate(b, page);
}
