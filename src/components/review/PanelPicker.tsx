import type { BubbleBounds } from "~/hooks/useReviewEdits";
import type { PanelBoundingBox } from "~/types/panels";

/** A page's panel as the review editor needs it, listed in reading order. */
export interface ReviewPanel {
  id: string;
  boundingBox: PanelBoundingBox;
}

/** The panel whose box holds the bubble's center, when exactly one does. */
export function panelAtCenter(
  panels: ReviewPanel[],
  bounds: BubbleBounds,
): string | null {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const hits = panels.filter(
    ({ boundingBox: b }) =>
      cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h,
  );
  return hits.length === 1 ? hits[0]!.id : null;
}

export function PanelPicker({
  panels,
  value,
  onChange,
}: {
  panels: ReviewPanel[];
  value: string | null;
  onChange: (panelId: string | null) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-400">Panel</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className={`w-full rounded border bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-cyan-500 focus:outline-none ${
          value ? "border-neutral-700" : "border-amber-600"
        }`}
      >
        <option value="">Choose a panel…</option>
        {panels.map((p, i) => (
          <option key={p.id} value={p.id}>
            Panel {i + 1}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Numbered outlines of the page's panels, drawn under the bubbles. */
export function PanelOutlines({
  panels,
  pickedId,
}: {
  panels: ReviewPanel[];
  pickedId: string | null;
}) {
  return (
    <div className="pointer-events-none absolute inset-0">
      {panels.map((p, i) => {
        const isPicked = p.id === pickedId;
        const b = p.boundingBox;
        return (
          <div
            key={p.id}
            className={`absolute border-2 ${
              isPicked
                ? "border-cyan-400 bg-cyan-400/10"
                : "border-dashed border-amber-400/60"
            }`}
            style={{
              left: `${b.x * 100}%`,
              top: `${b.y * 100}%`,
              width: `${b.w * 100}%`,
              height: `${b.h * 100}%`,
            }}
          >
            <span
              className={`absolute top-1 left-1 rounded px-1 text-[10px] font-semibold ${
                isPicked
                  ? "bg-cyan-400 text-black"
                  : "bg-black/70 text-amber-300"
              }`}
            >
              {i + 1}
            </span>
          </div>
        );
      })}
    </div>
  );
}
