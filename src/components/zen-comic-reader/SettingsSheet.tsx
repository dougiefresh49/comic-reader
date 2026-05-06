"use client";

import {
  PLAYBACK_RATE_MAX,
  PLAYBACK_RATE_MIN,
  type LayerVolumes,
  type MotionIntensity,
} from "~/hooks/useSettings";

interface SettingsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  autoPlayEnabled: boolean;
  onToggleAutoPlay: () => void;
  muteAll: boolean;
  onToggleMuteAll: () => void;
  voicesOnly: boolean;
  onToggleVoicesOnly: () => void;
  volumes: LayerVolumes;
  onSetLayerVolume: (layer: keyof LayerVolumes, value: number) => void;
  onResetVolumes: () => void;
  autoAdvancePage: boolean;
  onToggleAutoAdvancePage: () => void;
  playbackRate: number;
  onSetPlaybackRate: (rate: number) => void;
  motionIntensity: MotionIntensity;
  onSetMotionIntensity: (m: MotionIntensity) => void;
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
  muteAll,
  onToggleMuteAll,
  voicesOnly,
  onToggleVoicesOnly,
  volumes,
  onSetLayerVolume,
  onResetVolumes,
  autoAdvancePage,
  onToggleAutoAdvancePage,
  playbackRate,
  onSetPlaybackRate,
  motionIntensity,
  onSetMotionIntensity,
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

        <div className="flex flex-col gap-4">
          {/* ── Audio Section ── */}
          <section>
            <h3 className="mb-2 px-1 text-xs font-semibold tracking-[0.08em] text-neutral-500 uppercase">
              Audio
            </h3>
            <div className="flex flex-col gap-3">
              <ToggleRow
                label="Mute all"
                hint="Silence everything"
                enabled={muteAll}
                onToggle={onToggleMuteAll}
                icon={<IconVolumeX />}
              />
              <ToggleRow
                label="Voices only"
                hint="Dialogue only — no music, SFX, or ambience"
                enabled={voicesOnly}
                onToggle={onToggleVoicesOnly}
                icon={<IconMic />}
              />
              <PlaybackRateRow
                value={playbackRate}
                onChange={onSetPlaybackRate}
              />
              <VolumeSection
                volumes={volumes}
                onChange={onSetLayerVolume}
                onReset={onResetVolumes}
                disabled={muteAll || voicesOnly}
              />
            </div>
          </section>

          {/* ── Reading Section ── */}
          <section>
            <h3 className="mb-2 px-1 text-xs font-semibold tracking-[0.08em] text-neutral-500 uppercase">
              Reading
            </h3>
            <div className="flex flex-col gap-3">
              <ToggleRow
                label="Auto-advance"
                hint="Play bubbles continuously"
                enabled={autoPlayEnabled}
                onToggle={onToggleAutoPlay}
                icon={<IconPlayCircle />}
              />
              <ToggleRow
                label="Auto-turn pages"
                hint="Advance to next page when all bubbles finish"
                enabled={autoAdvancePage}
                onToggle={onToggleAutoAdvancePage}
                icon={<IconBookOpen />}
              />
            </div>
          </section>

          {/* ── Visual Section ── */}
          <section>
            <h3 className="mb-2 px-1 text-xs font-semibold tracking-[0.08em] text-neutral-500 uppercase">
              Visual effects
            </h3>
            <div className="flex flex-col gap-3">
              <ToggleRow
                label="Camera motion"
                hint="Panel zoom, push-in, and shake effects"
                enabled={motionIntensity !== "off"}
                onToggle={() =>
                  onSetMotionIntensity(
                    motionIntensity === "off" ? "full" : "off",
                  )
                }
                icon={<IconVideo />}
              />
              <ToggleRow
                label="Particle effects"
                hint="Sparkles, dust, rain, and other overlays"
                enabled={motionIntensity === "full"}
                onToggle={() =>
                  onSetMotionIntensity(
                    motionIntensity === "full" ? "reduced" : "full",
                  )
                }
                icon={<IconSparkles />}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  enabled,
  onToggle,
  icon,
}: {
  label: string;
  hint: string;
  enabled: boolean;
  onToggle: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`flex items-center justify-between rounded-2xl border px-4 py-3 text-left transition-colors ${
        enabled
          ? "border-cyan-500/60 bg-cyan-500/10 text-white"
          : "border-white/10 bg-white/5 text-neutral-100"
      }`}
    >
      <div className="flex items-center gap-3">
        {icon && <div className="shrink-0 text-neutral-400">{icon}</div>}
        <div>
          <div className="text-sm font-semibold">{label}</div>
          <div className="text-xs text-neutral-400">{hint}</div>
        </div>
      </div>
      <div
        className={`ml-3 h-5 w-10 shrink-0 rounded-full p-0.5 transition-colors ${
          enabled ? "bg-cyan-500" : "bg-neutral-700"
        }`}
      >
        <div
          className={`h-4 w-4 rounded-full bg-white transition-transform ${
            enabled ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </div>
    </button>
  );
}

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
            Speeds up dialogue audio. {value.toFixed(2)}x
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
            {p}x
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
  disabled = false,
}: {
  volumes: LayerVolumes;
  onChange: (k: keyof LayerVolumes, v: number) => void;
  onReset: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border border-white/10 bg-white/5 px-4 py-3 transition-opacity ${disabled ? "pointer-events-none opacity-40" : ""}`}
    >
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-neutral-100">Volume</div>
          <div className="text-xs text-neutral-400">
            {disabled
              ? "Overridden by quick toggle above"
              : "Per-layer mix. Drag to 0 to mute."}
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

const svgProps = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function IconVolumeX() {
  return (
    <svg {...svgProps}>
      <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
      <line x1="22" x2="16" y1="9" y2="15" />
      <line x1="16" x2="22" y1="9" y2="15" />
    </svg>
  );
}

function IconMic() {
  return (
    <svg {...svgProps}>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

function IconPlayCircle() {
  return (
    <svg {...svgProps}>
      <circle cx="12" cy="12" r="10" />
      <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconBookOpen() {
  return (
    <svg {...svgProps}>
      <path d="M12 7v14" />
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
    </svg>
  );
}

function IconVideo() {
  return (
    <svg {...svgProps}>
      <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.934a.5.5 0 0 0-.777-.416L16 11" />
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </svg>
  );
}

function IconSparkles() {
  return (
    <svg {...svgProps}>
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
    </svg>
  );
}
