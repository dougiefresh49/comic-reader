"use client";

// The panels page keeps what the review editor does not have: effect tags,
// effect positions, the cinematic description, audio tags and the new-scene
// flag. Panel boxes, order and bubbles are edited in the review editor (#331).

import Link from "next/link";
import { useMemo, useState } from "react";
import type {
  EffectAnchor,
  EffectPositions,
  PageDirectedPanel,
  PanelAudioTags,
} from "~/types/panels";

type AudioTags = PanelAudioTags;
import type { PanelReviewData } from "~/server/admin/panel-review";
import { applyPanelFixes, type PanelEdit } from "./actions";

// ─── Types & helpers ──────────────────────────────────────────────────────────

type WorkingPanel = PageDirectedPanel & { dirty?: boolean };

interface TagEnums {
  effect: string[];
  ambience: string[];
  sfx: string[];
  music: string[];
}

const PANEL_PALETTE = [
  "#f97316", // orange
  "#22d3ee", // cyan
  "#a855f7", // purple
  "#84cc16", // lime
  "#ec4899", // pink
  "#facc15", // yellow
  "#3b82f6", // blue
  "#ef4444", // red
];
const FALLBACK_COLOR = "#737373"; // neutral-500

function panelColor(idx: number): string {
  return PANEL_PALETTE[idx % PANEL_PALETTE.length] ?? FALLBACK_COLOR;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  data: PanelReviewData;
  tagEnums: TagEnums;
  /** keyed by `${layer}:${base}` → variant slugs */
  variantsByTag?: Record<string, string[]>;
}

function parseTagString(s: string): { base: string; variant: string | null } {
  const at = s.indexOf("@");
  if (at < 0) return { base: s, variant: null };
  return { base: s.slice(0, at), variant: s.slice(at + 1) || null };
}

export function PanelsReviewClient({
  data,
  tagEnums,
  variantsByTag = {},
}: Props) {
  const [pageIdx, setPageIdx] = useState(0);
  const [panels, setPanels] = useState<WorkingPanel[]>(() =>
    data.pages.flatMap((p) => p.panels),
  );
  const [originalPanels] = useState<PageDirectedPanel[]>(() =>
    data.pages.flatMap((p) => p.panels),
  );
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const page = data.pages[pageIdx];
  const pageNumber = page?.pageNumber ?? 1;
  const pagePanels = useMemo(
    () =>
      panels
        .filter((p) => p.pageNumber === pageNumber)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [panels, pageNumber],
  );

  const panelColorById = useMemo(() => {
    const m = new Map<string, string>();
    pagePanels.forEach((p, i) => m.set(p.id, panelColor(i)));
    return m;
  }, [pagePanels]);

  function updatePanel(id: string, patch: Partial<WorkingPanel>) {
    setPanels((curr) =>
      curr.map((p) => (p.id === id ? { ...p, ...patch, dirty: true } : p)),
    );
  }

  // ─── Apply ────────────────────────────────────────────────────────────────

  async function onApply() {
    setSaving(true);
    setError(null);
    try {
      const originalById = new Map(originalPanels.map((p) => [p.id, p]));
      const edits: PanelEdit[] = panels
        .filter((p) => p.dirty)
        .map((p) => {
          const orig = originalById.get(p.id);
          const edit: PanelEdit = { id: p.id };
          if (orig?.cinematicDescription !== p.cinematicDescription)
            edit.cinematicDescription = p.cinematicDescription;
          if (
            JSON.stringify(orig?.effectTags ?? []) !==
            JSON.stringify(p.effectTags)
          )
            edit.effectTags = p.effectTags;
          if (
            JSON.stringify(orig?.effectPositions ?? null) !==
            JSON.stringify(p.effectPositions ?? null)
          )
            edit.effectPositions = p.effectPositions ?? null;
          if (
            JSON.stringify(orig?.audioTags ?? {}) !==
            JSON.stringify(p.audioTags)
          )
            edit.audioTags = p.audioTags;
          if (orig?.isNewScene !== p.isNewScene) edit.isNewScene = p.isNewScene;
          return edit;
        });

      const result = await applyPanelFixes({
        bookId: data.bookId,
        issueId: data.issueId,
        edits,
      });
      if (!result.ok) {
        setError(result.error ?? "Apply failed");
        return;
      }
      // reload to re-fetch the rows as saved
      window.location.reload();
    } finally {
      setSaving(false);
    }
  }

  const dirtyCount = panels.filter((p) => p.dirty).length;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="grid grid-cols-[1fr_400px] gap-6">
      {/* Left: page navigator + image with the panel boxes */}
      <div>
        <div className="mb-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setPageIdx((i) => Math.max(0, i - 1))}
            disabled={pageIdx === 0}
            className="rounded bg-neutral-800 px-3 py-1 text-sm disabled:opacity-30"
          >
            ← Prev
          </button>
          <span className="text-sm text-neutral-300">
            Page {pageNumber} of {data.pages.length}
          </span>
          <button
            type="button"
            onClick={() =>
              setPageIdx((i) => Math.min(data.pages.length - 1, i + 1))
            }
            disabled={pageIdx >= data.pages.length - 1}
            className="rounded bg-neutral-800 px-3 py-1 text-sm disabled:opacity-30"
          >
            Next →
          </button>
          <select
            value={pageIdx}
            onChange={(e) => setPageIdx(Number(e.target.value))}
            className="rounded bg-neutral-800 px-2 py-1 text-sm"
          >
            {data.pages.map((p, i) => (
              <option key={p.pageNumber} value={i}>
                Page {p.pageNumber}
                {p.panels.length === 0 ? " (no panels)" : ""}
              </option>
            ))}
          </select>
          <Link
            href={`/admin/${data.bookId}/${data.issueId}/review/editor?page=${pageNumber}`}
            className="text-sm text-neutral-400 underline hover:text-neutral-200"
          >
            Open this page in the review editor
          </Link>
        </div>

        <div
          className="relative w-full overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 select-none"
          onClick={() => setSelectedPanelId(null)}
        >
          {page && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={page.imageUrl}
              alt={`Page ${pageNumber}`}
              className="block w-full"
              draggable={false}
            />
          )}

          {/* Panel rectangles: click to select, the boxes do not move here */}
          {pagePanels.map((p) => {
            const color = panelColorById.get(p.id) ?? FALLBACK_COLOR;
            const isSelected = p.id === selectedPanelId;
            return (
              <div
                key={p.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedPanelId(p.id);
                }}
                style={{
                  left: `${p.boundingBox.x * 100}%`,
                  top: `${p.boundingBox.y * 100}%`,
                  width: `${p.boundingBox.w * 100}%`,
                  height: `${p.boundingBox.h * 100}%`,
                  borderColor: color,
                  backgroundColor: `${color}22`,
                  outline: isSelected ? `2px solid ${color}` : undefined,
                }}
                className="absolute cursor-pointer border-2"
              >
                <div
                  className="absolute -top-5 left-0 rounded px-1 py-0.5 text-[10px] font-bold text-white"
                  style={{ backgroundColor: color }}
                >
                  {p.panelId}
                  {p.dirty ? " •" : ""}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: panel list + apply */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={dirtyCount === 0 || saving}
            onClick={onApply}
            className="rounded bg-cyan-700 px-3 py-1.5 text-sm font-medium hover:bg-cyan-600 disabled:opacity-30"
          >
            {saving ? "Applying…" : `Apply (${dirtyCount})`}
          </button>
        </div>
        {error && (
          <div className="rounded border border-red-700 bg-red-900/30 px-2 py-1 text-xs text-red-200">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-3 overflow-y-auto">
          {pagePanels.length === 0 && (
            <div className="rounded border border-neutral-800 p-3 text-xs text-neutral-400">
              No panels on this page. Draw them in the review editor.
            </div>
          )}
          {pagePanels.map((p) => (
            <PanelCard
              key={p.id}
              panel={p}
              color={panelColorById.get(p.id) ?? FALLBACK_COLOR}
              selected={p.id === selectedPanelId}
              tagEnums={tagEnums}
              variantsByTag={variantsByTag}
              bubbleCount={
                page?.bubbles.filter((b) => b.panelId === p.id).length ?? 0
              }
              onSelect={() => setSelectedPanelId(p.id)}
              onChange={(patch) => updatePanel(p.id, patch)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

interface PanelCardProps {
  panel: WorkingPanel;
  color: string;
  selected: boolean;
  bubbleCount: number;
  tagEnums: TagEnums;
  variantsByTag: Record<string, string[]>;
  onSelect: () => void;
  onChange: (patch: Partial<WorkingPanel>) => void;
}

function PanelCard({
  panel,
  color,
  selected,
  bubbleCount,
  tagEnums,
  variantsByTag,
  onSelect,
  onChange,
}: PanelCardProps) {
  function toggleTag(list: string[], tag: string): string[] {
    return list.includes(tag) ? list.filter((t) => t !== tag) : [...list, tag];
  }
  function setBaseVariant(
    list: string[],
    base: string,
    variant: string | null,
  ): string[] {
    const next = list.filter((s) => parseTagString(s).base !== base);
    next.push(variant ? `${base}@${variant}` : base);
    return next;
  }
  function updateAudio(patch: Partial<AudioTags>) {
    onChange({ audioTags: { ...panel.audioTags, ...patch } });
  }

  return (
    <div
      onClick={onSelect}
      className={`rounded-lg border bg-neutral-900 p-3 ${selected ? "border-cyan-500" : "border-neutral-800"}`}
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-3 w-3 rounded"
            style={{ backgroundColor: color }}
          />
          <span className="font-mono text-sm">{panel.panelId}</span>
          <span className="text-xs text-neutral-500">
            {panel.source}
            {panel.dirty ? " · edited" : ""}
          </span>
        </div>
      </div>

      <div className="mb-2 text-xs text-neutral-400">{bubbleCount} bubbles</div>

      <label className="mb-2 block text-xs text-neutral-400">
        Cinematic description
        <textarea
          value={panel.cinematicDescription ?? ""}
          onChange={(e) =>
            onChange({ cinematicDescription: e.target.value || null })
          }
          rows={2}
          className="mt-1 w-full rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-100"
        />
      </label>

      <TagChips
        label="Effect tags"
        all={tagEnums.effect}
        selected={panel.effectTags}
        onToggle={(tag) => {
          const next = toggleTag(panel.effectTags, tag);
          const patch: Partial<WorkingPanel> = { effectTags: next };
          if (!next.includes(tag) && panel.effectPositions?.[tag]) {
            const ep = { ...panel.effectPositions };
            delete ep[tag];
            patch.effectPositions = Object.keys(ep).length > 0 ? ep : null;
          }
          onChange(patch);
        }}
      />
      <EffectPositionPicker
        effectTags={panel.effectTags}
        effectPositions={panel.effectPositions}
        onChange={(ep) => onChange({ effectPositions: ep })}
      />
      <AudioTagChips
        label="Ambience"
        layer="ambience"
        all={tagEnums.ambience}
        selected={panel.audioTags.ambience}
        variantsByTag={variantsByTag}
        onToggle={(tag) =>
          updateAudio({ ambience: toggleTag(panel.audioTags.ambience, tag) })
        }
        onPickVariant={(base, variant) =>
          updateAudio({
            ambience: setBaseVariant(panel.audioTags.ambience, base, variant),
          })
        }
      />
      <AudioTagChips
        label="SFX"
        layer="sfx"
        all={tagEnums.sfx}
        selected={panel.audioTags.sfx}
        variantsByTag={variantsByTag}
        onToggle={(tag) =>
          updateAudio({ sfx: toggleTag(panel.audioTags.sfx, tag) })
        }
        onPickVariant={(base, variant) =>
          updateAudio({
            sfx: setBaseVariant(panel.audioTags.sfx, base, variant),
          })
        }
      />
      <label className="mt-2 block text-xs text-neutral-400">
        Music mood
        <select
          value={panel.audioTags.music_mood}
          onChange={(e) => updateAudio({ music_mood: e.target.value })}
          className="ml-2 rounded bg-neutral-800 px-1 py-0.5 text-xs"
        >
          {tagEnums.music.flatMap((m) => {
            const variants = variantsByTag[`music:${m}`] ?? [];
            return [
              <option key={m} value={m}>
                {m}
              </option>,
              ...variants.map((v) => (
                <option key={`${m}@${v}`} value={`${m}@${v}`}>
                  {m} @{v}
                </option>
              )),
            ];
          })}
        </select>
      </label>
      <label className="mt-2 flex items-center gap-2 text-xs text-neutral-400">
        <input
          type="checkbox"
          checked={panel.isNewScene}
          onChange={(e) => onChange({ isNewScene: e.target.checked })}
        />
        New scene (music transition)
      </label>
    </div>
  );
}

const CAMERA_PREFIXES = ["camera_", "panel_shake"];

const ANCHOR_GRID: Array<{ value: EffectAnchor; label: string }> = [
  { value: "top-left", label: "TL" },
  { value: "top-center", label: "TC" },
  { value: "top-right", label: "TR" },
  { value: "left-center", label: "ML" },
  { value: "center", label: "C" },
  { value: "right-center", label: "MR" },
  { value: "bottom-left", label: "BL" },
  { value: "bottom-center", label: "BC" },
  { value: "bottom-right", label: "BR" },
];

function EffectPositionPicker({
  effectTags,
  effectPositions,
  onChange,
}: {
  effectTags: string[];
  effectPositions: EffectPositions | null;
  onChange: (ep: EffectPositions | null) => void;
}) {
  const positionable = effectTags.filter(
    (t) => !CAMERA_PREFIXES.some((p) => t.startsWith(p)),
  );
  if (positionable.length === 0) return null;

  function setAnchor(tag: string, anchor: EffectAnchor | null) {
    const current = { ...(effectPositions ?? {}) };
    if (anchor === null) {
      delete current[tag];
    } else {
      current[tag] = { anchor };
    }
    onChange(Object.keys(current).length > 0 ? current : null);
  }

  return (
    <div className="mt-2">
      <div className="mb-1 text-xs text-neutral-400">Effect positions</div>
      <div className="flex flex-col gap-2">
        {positionable.map((tag) => {
          const pos = effectPositions?.[tag];
          const activeAnchor = pos?.anchor ?? null;
          return (
            <div key={tag} className="flex items-start gap-2">
              <span className="mt-0.5 min-w-0 shrink text-[10px] leading-tight break-all text-neutral-500">
                {tag.replace(/_/g, " ")}
              </span>
              <div className="grid shrink-0 grid-cols-3 gap-px">
                {ANCHOR_GRID.map((a) => (
                  <button
                    key={a.value}
                    type="button"
                    title={a.value}
                    onClick={(e) => {
                      e.stopPropagation();
                      setAnchor(tag, activeAnchor === a.value ? null : a.value);
                    }}
                    className={`h-4 w-5 text-[8px] leading-none ${
                      activeAnchor === a.value
                        ? "bg-cyan-700 text-white"
                        : "bg-neutral-800 text-neutral-500 hover:bg-neutral-700"
                    }`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TagChips({
  label,
  all,
  selected,
  onToggle,
}: {
  label: string;
  all: string[];
  selected: string[];
  onToggle: (tag: string) => void;
}) {
  return (
    <div className="mt-2">
      <div className="mb-1 text-xs text-neutral-400">{label}</div>
      <div className="flex flex-wrap gap-1">
        {all.map((tag) => {
          const on = selected.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggle(tag);
              }}
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                on
                  ? "bg-cyan-700 text-white"
                  : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
              }`}
            >
              {tag}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Variant-aware tag chips for audio layers (ambience / sfx).
 *
 * Each chip represents a base tag. A tag is "on" if any string in
 * `selected[]` parses to that base. Clicking a chip toggles the bare
 * tag (or removes all variants of that base). When the chip is on AND
 * variants exist, an inline ▾ button reveals a variant menu.
 */
function AudioTagChips({
  label,
  layer,
  all,
  selected,
  variantsByTag,
  onToggle,
  onPickVariant,
}: {
  label: string;
  layer: "ambience" | "sfx";
  all: string[];
  selected: string[];
  variantsByTag: Record<string, string[]>;
  onToggle: (tag: string) => void;
  onPickVariant: (base: string, variant: string | null) => void;
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  return (
    <div className="mt-2">
      <div className="mb-1 text-xs text-neutral-400">{label}</div>
      <div className="flex flex-wrap gap-1">
        {all.map((base) => {
          const selectedString = selected.find(
            (s) => parseTagString(s).base === base,
          );
          const on = Boolean(selectedString);
          const currentVariant = selectedString
            ? parseTagString(selectedString).variant
            : null;
          const variants = variantsByTag[`${layer}:${base}`] ?? [];
          return (
            <span key={base} className="relative inline-flex items-stretch">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(base);
                }}
                className={`rounded-l px-1.5 py-0.5 text-[10px] ${
                  on
                    ? "bg-cyan-700 text-white"
                    : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
                } ${variants.length === 0 ? "rounded-r" : ""}`}
              >
                {base}
                {currentVariant ? (
                  <span className="ml-1 text-cyan-200">@{currentVariant}</span>
                ) : null}
              </button>
              {variants.length > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenMenu(openMenu === base ? null : base);
                  }}
                  className={`rounded-r border-l border-neutral-900 px-1 text-[10px] ${
                    on
                      ? "bg-cyan-700 text-white hover:bg-cyan-600"
                      : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
                  }`}
                  aria-label={`Variants for ${base}`}
                >
                  ▾
                </button>
              )}
              {openMenu === base && (
                <div
                  className="absolute top-full left-0 z-10 mt-0.5 flex flex-col rounded border border-neutral-700 bg-neutral-900 p-1 shadow-xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onPickVariant(base, null);
                      setOpenMenu(null);
                    }}
                    className={`rounded px-2 py-0.5 text-left text-[10px] ${currentVariant === null && on ? "bg-cyan-700 text-white" : "text-neutral-300 hover:bg-neutral-800"}`}
                  >
                    default
                  </button>
                  {variants.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => {
                        onPickVariant(base, v);
                        setOpenMenu(null);
                      }}
                      className={`rounded px-2 py-0.5 text-left text-[10px] ${currentVariant === v ? "bg-cyan-700 text-white" : "text-neutral-300 hover:bg-neutral-800"}`}
                    >
                      @{v}
                    </button>
                  ))}
                </div>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
