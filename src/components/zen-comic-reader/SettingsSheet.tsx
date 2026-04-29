"use client";

import {
  PLAYBACK_RATE_MAX,
  PLAYBACK_RATE_MIN,
  type LayerVolumes,
} from "~/hooks/useSettings";

interface SettingsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  autoPlayEnabled: boolean;
  onToggleAutoPlay: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  hasNext: boolean;
  hasPrev: boolean;
  volumes: LayerVolumes;
  onSetLayerVolume: (layer: keyof LayerVolumes, value: number) => void;
  onResetVolumes: () => void;
  playbackRate: number;
  onSetPlaybackRate: (rate: number) => void;
}

const VOLUME_LAYERS: Array<{
  key: keyof LayerVolumes;
  label: string;
  hint: string;
}> = [
  { key: "dialogue", label: "Dialogue", hint: "Character voices" },
  { key: "music", label: "Music", hint: "Mood bed under the scene" },
  { key: "sfx", label: "Sound FX", hint: "Whooshes, impacts, zaps" },
  { key: "ambience", label: "Ambience", hint: "Wind, rain, machinery" },
];

export function SettingsSheet({
  isOpen,
  onClose,
  autoPlayEnabled,
  onToggleAutoPlay,
  onNext,
  onPrev,
  hasNext,
  hasPrev,
  volumes,
  onSetLayerVolume,
  onResetVolumes,
  playbackRate,
  onSetPlaybackRate,
}: SettingsSheetProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-t-3xl border border-white/10 bg-neutral-950/95 px-4 pt-3 pb-5 shadow-[0_-10px_40px_rgba(0,0,0,0.45)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between px-1">
          <span className="text-sm font-semibold tracking-[0.08em] text-neutral-200 uppercase">
            Settings
          </span>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Close settings"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" x2="6" y1="6" y2="18" />
              <line x1="6" x2="18" y1="6" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex flex-col gap-3">
          <button
            onClick={onToggleAutoPlay}
            className={`flex items-center justify-between rounded-2xl border px-4 py-3 text-left transition-colors ${
              autoPlayEnabled
                ? "border-cyan-500/60 bg-cyan-500/10 text-white"
                : "border-white/10 bg-white/5 text-neutral-100"
            }`}
          >
            <div className="flex items-center gap-3">
              <div>
                <div className="text-sm font-semibold">Auto Play</div>
                <div className="text-xs text-neutral-400">
                  Toggle continuous reading
                </div>
              </div>
            </div>
            <div
              className={`h-5 w-10 rounded-full p-0.5 transition-colors ${
                autoPlayEnabled ? "bg-cyan-500" : "bg-neutral-700"
              }`}
            >
              <div
                className={`h-4 w-4 rounded-full bg-white transition-transform ${
                  autoPlayEnabled ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </div>
          </button>

          <PlaybackRateRow value={playbackRate} onChange={onSetPlaybackRate} />

          <VolumeSection
            volumes={volumes}
            onChange={onSetLayerVolume}
            onReset={onResetVolumes}
          />

          <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
            <div className="text-sm font-semibold text-neutral-100">
              Page Controls
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onPrev}
                disabled={!hasPrev}
                className={`rounded-full p-3 transition-colors ${
                  hasPrev
                    ? "bg-neutral-800 text-white hover:bg-neutral-700"
                    : "cursor-not-allowed bg-neutral-900 text-neutral-600"
                }`}
                aria-label="Previous page"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </button>
              <button
                onClick={onNext}
                disabled={!hasNext}
                className={`rounded-full p-3 transition-colors ${
                  hasNext
                    ? "bg-neutral-800 text-white hover:bg-neutral-700"
                    : "cursor-not-allowed bg-neutral-900 text-neutral-600"
                }`}
                aria-label="Next page"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function PlaybackRateRow({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  const presets = [0.75, 1.0, 1.2, 1.5, 2.0];
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-neutral-100">
            Reading speed
          </div>
          <div className="text-xs text-neutral-400">
            Speeds up dialogue audio. {value.toFixed(2)}×
          </div>
        </div>
      </div>
      <input
        type="range"
        min={PLAYBACK_RATE_MIN}
        max={PLAYBACK_RATE_MAX}
        step={0.05}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="mb-2 w-full accent-cyan-500"
        aria-label="Playback speed"
      />
      <div className="flex flex-wrap gap-1">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            className={`rounded px-2 py-0.5 text-xs ${
              Math.abs(value - p) < 0.01
                ? "bg-cyan-600 text-white"
                : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            {p}×
          </button>
        ))}
      </div>
    </div>
  );
}

function VolumeSection({
  volumes,
  onChange,
  onReset,
}: {
  volumes: LayerVolumes;
  onChange: (k: keyof LayerVolumes, v: number) => void;
  onReset: () => void;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-neutral-100">Volume</div>
          <div className="text-xs text-neutral-400">
            Per-layer mix. Drag to 0 to mute.
          </div>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="rounded bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-700"
        >
          reset
        </button>
      </div>
      <div className="flex flex-col gap-2">
        {VOLUME_LAYERS.map((layer) => {
          const v = volumes[layer.key];
          const muted = v === 0;
          return (
            <div key={layer.key} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onChange(layer.key, muted ? 0.5 : 0)}
                className={`w-9 shrink-0 rounded px-1 py-0.5 text-[10px] ${
                  muted
                    ? "bg-red-900/60 text-red-200"
                    : "bg-neutral-800 text-neutral-300"
                }`}
                aria-label={
                  muted ? `Unmute ${layer.label}` : `Mute ${layer.label}`
                }
              >
                {muted ? "MUTE" : "ON"}
              </button>
              <div className="flex-1">
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-neutral-200">{layer.label}</span>
                  <span className="text-neutral-500">
                    {Math.round(v * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={v}
                  onChange={(e) =>
                    onChange(layer.key, parseFloat(e.target.value))
                  }
                  className="w-full accent-cyan-500"
                  aria-label={`${layer.label} volume`}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
