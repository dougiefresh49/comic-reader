"use client";

import { useState } from "react";
import {
  audioLibraryUrl,
  slugifyVariant,
  type AudioLayer,
} from "~/lib/audio-library";
import type {
  AudioLibraryListing,
  TagVariants,
} from "~/server/admin/audio-library";
import {
  deleteAudioVariant,
  generateAudioWithElevenLabs,
  saveFromFreesound,
  searchFreesound,
  uploadAudioBytes,
  type FreesoundHit,
} from "./actions";

interface Props {
  listing: AudioLibraryListing;
  enums: { ambience: string[]; sfx: string[]; music: string[] };
}

export function AudioLibraryClient({ listing, enums }: Props) {
  const [modal, setModal] = useState<{
    layer: AudioLayer;
    base: string;
    /** null when swapping the default; non-null when adding/editing a variant. */
    variant: string | null;
    mode: "swap" | "add";
  } | null>(null);

  return (
    <>
      {(["ambience", "sfx", "music"] as const).map((layer) => (
        <Section
          key={layer}
          layer={layer}
          tags={enums[layer]}
          listing={listing[layer]}
          onSwap={(base) =>
            setModal({ layer, base, variant: null, mode: "swap" })
          }
          onAddVariant={(base) =>
            setModal({ layer, base, variant: "", mode: "add" })
          }
        />
      ))}
      {modal && (
        <SwapModal
          layer={modal.layer}
          base={modal.base}
          mode={modal.mode}
          initialVariant={modal.variant ?? ""}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}

function Section({
  layer,
  tags,
  listing,
  onSwap,
  onAddVariant,
}: {
  layer: AudioLayer;
  tags: string[];
  listing: Record<string, TagVariants[]>;
  onSwap: (base: string) => void;
  onAddVariant: (base: string) => void;
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-lg font-medium capitalize">{layer}</h2>
      <div className="flex flex-col gap-2">
        {tags.map((base) => {
          const variants = listing[base] ?? [];
          const hasDefault = variants.some((v) => v.variant === null);
          return (
            <div
              key={base}
              className="rounded border border-neutral-800 bg-neutral-900 p-3"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="font-mono text-xs text-neutral-300">
                  {base}
                  {!hasDefault && (
                    <span className="ml-2 rounded bg-amber-900/50 px-1.5 py-0.5 text-[10px] text-amber-200">
                      no default yet
                    </span>
                  )}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => onSwap(base)}
                    className="rounded bg-cyan-700 px-2 py-1 text-xs hover:bg-cyan-600"
                  >
                    {hasDefault ? "Swap default" : "Set default"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onAddVariant(base)}
                    className="rounded bg-neutral-700 px-2 py-1 text-xs hover:bg-neutral-600"
                  >
                    + Variant
                  </button>
                </div>
              </div>

              {variants.length === 0 ? (
                <div className="text-xs text-neutral-500">
                  No clip cached yet for this tag.
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {variants.map((v) => (
                    <VariantRow
                      key={v.filename}
                      layer={layer}
                      base={base}
                      v={v}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function VariantRow({
  layer,
  base,
  v,
}: {
  layer: AudioLayer;
  base: string;
  v: TagVariants;
}) {
  const [busy, setBusy] = useState(false);
  const label = v.variant === null ? "default" : `@${v.variant}`;
  const tagString = v.variant === null ? base : `${base}@${v.variant}`;
  return (
    <div className="flex items-center gap-3">
      <span className="w-32 font-mono text-[10px] text-neutral-500">
        {label}
      </span>
      <audio
        src={audioLibraryUrl(layer, tagString)}
        controls
        preload="none"
        className="flex-1"
      />
      {v.variant !== null && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            if (!confirm(`Delete variant ${tagString}?`)) return;
            setBusy(true);
            await deleteAudioVariant({ layer, filename: v.filename });
            setBusy(false);
            location.reload();
          }}
          className="text-xs text-red-400 hover:text-red-300 disabled:opacity-30"
        >
          Delete
        </button>
      )}
    </div>
  );
}

// ─── Swap modal ──────────────────────────────────────────────────────────────

function SwapModal({
  layer,
  base,
  mode,
  initialVariant,
  onClose,
}: {
  layer: AudioLayer;
  base: string;
  mode: "swap" | "add";
  initialVariant: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"freesound" | "generate" | "upload">(
    "freesound",
  );
  const [variant, setVariant] = useState(initialVariant);
  const [error, setError] = useState<string | null>(null);
  const variantSlug = mode === "add" ? slugifyVariant(variant) : null;
  const targetLabel =
    mode === "swap" ? `${base} (default)` : `${base}@${variantSlug ?? "?"}`;
  const ready = mode === "swap" || variantSlug !== "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-lg border border-neutral-700 bg-neutral-950 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-mono text-sm">
            {mode === "swap" ? "Swap default" : "Add variant"} → {targetLabel}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300"
          >
            ✕
          </button>
        </div>

        {mode === "add" && (
          <label className="mb-3 block">
            <span className="text-xs text-neutral-400">
              Variant name (will be slugified)
            </span>
            <input
              value={variant}
              onChange={(e) => setVariant(e.target.value)}
              placeholder="e.g. bowstaff"
              className="mt-1 w-full rounded bg-neutral-800 px-2 py-1 text-sm"
            />
            <span className="text-[10px] text-neutral-500">
              file: {base}
              {variantSlug ? `.${variantSlug}` : ".???"}.mp3
            </span>
          </label>
        )}

        <div className="mb-4 flex gap-1 rounded bg-neutral-900 p-1">
          {(["freesound", "generate", "upload"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`flex-1 rounded px-2 py-1 text-xs capitalize ${tab === t ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-neutral-200"}`}
            >
              {t}
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-3 rounded border border-red-700 bg-red-900/30 px-2 py-1 text-xs text-red-200">
            {error}
          </div>
        )}

        {tab === "freesound" && (
          <FreesoundPanel
            layer={layer}
            base={base}
            variant={variantSlug}
            ready={ready}
            onError={setError}
            onDone={() => {
              onClose();
              location.reload();
            }}
          />
        )}
        {tab === "generate" && (
          <GeneratePanel
            layer={layer}
            base={base}
            variant={variantSlug}
            ready={ready}
            onError={setError}
            onDone={() => {
              onClose();
              location.reload();
            }}
          />
        )}
        {tab === "upload" && (
          <UploadPanel
            layer={layer}
            base={base}
            variant={variantSlug}
            ready={ready}
            onError={setError}
            onDone={() => {
              onClose();
              location.reload();
            }}
          />
        )}
      </div>
    </div>
  );
}

interface PanelProps {
  layer: AudioLayer;
  base: string;
  variant: string | null;
  ready: boolean;
  onError: (e: string | null) => void;
  onDone: () => void;
}

function FreesoundPanel({
  layer,
  base,
  variant,
  ready,
  onError,
  onDone,
}: PanelProps) {
  const [query, setQuery] = useState(base.replace(/_/g, " "));
  const [results, setResults] = useState<FreesoundHit[]>([]);
  const [busy, setBusy] = useState(false);

  return (
    <div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          onError(null);
          setBusy(true);
          const r = await searchFreesound(layer, query);
          setBusy(false);
          if (!r.ok) onError(r.error ?? "search failed");
          setResults(r.results);
        }}
        className="mb-3 flex gap-2"
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Freesound query"
          className="flex-1 rounded bg-neutral-800 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-neutral-700 px-3 py-1 text-sm hover:bg-neutral-600 disabled:opacity-30"
        >
          {busy ? "Searching…" : "Search"}
        </button>
      </form>
      <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
        {results.length === 0 && !busy && (
          <div className="text-xs text-neutral-500">
            Type a query and hit Search to audition Freesound clips. CC0 + CC-BY
            only.
          </div>
        )}
        {results.map((r) => (
          <div
            key={r.id}
            className="rounded border border-neutral-800 bg-neutral-900 p-2"
          >
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-neutral-300">
                {r.name}{" "}
                <span className="text-neutral-500">
                  ({r.duration.toFixed(1)}s · {r.license.split("/").pop()} ·{" "}
                  {r.username})
                </span>
              </span>
              <button
                type="button"
                disabled={!ready}
                onClick={async () => {
                  onError(null);
                  const result = await saveFromFreesound({
                    layer,
                    base,
                    variant,
                    previewUrl: r.previewUrl,
                  });
                  if (!result.ok) onError(result.error ?? "save failed");
                  else onDone();
                }}
                className="rounded bg-emerald-700 px-2 py-0.5 text-[10px] hover:bg-emerald-600 disabled:opacity-30"
              >
                Use this
              </button>
            </div>
            <audio
              src={r.previewUrl}
              controls
              preload="none"
              className="w-full"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function GeneratePanel({
  layer,
  base,
  variant,
  ready,
  onError,
  onDone,
}: PanelProps) {
  const [prompt, setPrompt] = useState(base.replace(/_/g, " "));
  const [duration, setDuration] = useState(
    layer === "sfx" ? 1.5 : layer === "ambience" ? 12 : 30,
  );
  const [busy, setBusy] = useState(false);

  return (
    <div>
      <label className="mb-2 block">
        <span className="text-xs text-neutral-400">Prompt</span>
        <textarea
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="mt-1 w-full rounded bg-neutral-800 px-2 py-1 text-sm"
        />
      </label>
      <label className="mb-3 block">
        <span className="text-xs text-neutral-400">
          Duration (seconds) —{" "}
          {layer === "music"
            ? "music tracks"
            : layer === "sfx"
              ? "short sfx hits"
              : "ambience loops"}
        </span>
        <input
          type="number"
          step="0.1"
          min={0.5}
          max={layer === "music" ? 60 : 30}
          value={duration}
          onChange={(e) => setDuration(parseFloat(e.target.value))}
          className="mt-1 w-32 rounded bg-neutral-800 px-2 py-1 text-sm"
        />
      </label>
      <button
        type="button"
        disabled={!ready || busy || !prompt.trim()}
        onClick={async () => {
          onError(null);
          setBusy(true);
          const r = await generateAudioWithElevenLabs({
            layer,
            base,
            variant,
            prompt,
            durationSeconds: duration,
          });
          setBusy(false);
          if (!r.ok) onError(r.error ?? "generation failed");
          else onDone();
        }}
        className="rounded bg-cyan-700 px-3 py-1.5 text-sm hover:bg-cyan-600 disabled:opacity-30"
      >
        {busy ? "Generating…" : "Generate & save"}
      </button>
      <p className="mt-2 text-[10px] text-neutral-500">
        Each generation hits the ElevenLabs API once and is metered against your
        Creator-plan minutes. There&apos;s no free preview — the result saves
        directly. Audition first via Freesound or Upload if you want to retry
        without spending credits.
      </p>
    </div>
  );
}

function UploadPanel({
  layer,
  base,
  variant,
  ready,
  onError,
  onDone,
}: PanelProps) {
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <p className="mb-3 text-xs text-neutral-400">
        Drop in any .mp3 (≤ 10 MB) — including a clip you downloaded from the
        ElevenLabs dashboard or recorded yourself.
      </p>
      <input
        type="file"
        accept="audio/mpeg,audio/mp3"
        disabled={!ready || busy}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          onError(null);
          setBusy(true);
          const buf = await file.arrayBuffer();
          const base64 = arrayBufferToBase64(buf);
          const r = await uploadAudioBytes({ layer, base, variant, base64 });
          setBusy(false);
          if (!r.ok) onError(r.error ?? "upload failed");
          else onDone();
        }}
        className="block text-sm text-neutral-300 file:mr-3 file:rounded file:border-0 file:bg-neutral-700 file:px-3 file:py-1 file:text-xs file:text-white hover:file:bg-neutral-600"
      />
      {busy && (
        <span className="ml-2 text-xs text-neutral-400">Uploading…</span>
      )}
    </div>
  );
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++)
    binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}
