"use client";

import { useCallback, useMemo, useState } from "react";
import type { SceneReviewData } from "~/server/admin/scene-review";
import { MUSIC_MOODS } from "~/lib/panel-tags";
import { saveScenes, type SceneSaveEntry } from "./actions";

// ─── Types ────────────────────────────────────────────────────────────────────

interface WorkingScene {
  id: string;
  musicMood: string;
  label: string | null;
  panelIds: string[];
}

const SCENE_PALETTE = [
  "#f97316", // orange
  "#22d3ee", // cyan
  "#a855f7", // purple
  "#84cc16", // lime
  "#ec4899", // pink
  "#facc15", // yellow
  "#3b82f6", // blue
  "#ef4444", // red
  "#14b8a6", // teal
  "#f59e0b", // amber
];

function sceneColor(idx: number): string {
  return SCENE_PALETTE[idx % SCENE_PALETTE.length]!;
}

function makeId(): string {
  return `s-${Math.random().toString(36).slice(2, 10)}`;
}

function moodLabel(mood: string): string {
  return mood.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  data: SceneReviewData;
}

export function SceneEditorClient({ data }: Props) {
  const [scenes, setScenes] = useState<WorkingScene[]>(() =>
    buildScenesFromData(data),
  );
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allPanelIds = useMemo(() => data.panels.map((p) => p.id), [data]);
  const panelById = useMemo(() => {
    const m = new Map<string, (typeof data.panels)[number]>();
    for (const p of data.panels) m.set(p.id, p);
    return m;
  }, [data]);

  const selectedScene = scenes.find((s) => s.id === selectedSceneId) ?? null;

  const sceneForPanel = useMemo(() => {
    const m = new Map<string, string>();
    for (const scene of scenes) {
      for (const pid of scene.panelIds) m.set(pid, scene.id);
    }
    return m;
  }, [scenes]);

  const unassignedPanelIds = useMemo(
    () => allPanelIds.filter((id) => !sceneForPanel.has(id)),
    [allPanelIds, sceneForPanel],
  );

  // ─── Mutations ──────────────────────────────────────────────────────────

  const updateScene = useCallback(
    (id: string, patch: Partial<Omit<WorkingScene, "id">>) => {
      setScenes((curr) =>
        curr.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      );
    },
    [],
  );

  const mergeScenes = useCallback(
    (sceneAId: string, sceneBId: string) => {
      setScenes((curr) => {
        const idxA = curr.findIndex((s) => s.id === sceneAId);
        const idxB = curr.findIndex((s) => s.id === sceneBId);
        if (idxA < 0 || idxB < 0) return curr;
        const [first, second] =
          idxA < idxB ? [curr[idxA]!, curr[idxB]!] : [curr[idxB]!, curr[idxA]!];
        const merged: WorkingScene = {
          id: first.id,
          musicMood: first.musicMood,
          label: first.label,
          panelIds: [...first.panelIds, ...second.panelIds],
        };
        return curr
          .map((s) => (s.id === first.id ? merged : s))
          .filter((s) => s.id !== second.id);
      });
      if (selectedSceneId === sceneBId) setSelectedSceneId(sceneAId);
    },
    [selectedSceneId],
  );

  const splitScene = useCallback((sceneId: string, afterPanelId: string) => {
    setScenes((curr) => {
      const idx = curr.findIndex((s) => s.id === sceneId);
      if (idx < 0) return curr;
      const scene = curr[idx]!;
      const splitIdx = scene.panelIds.indexOf(afterPanelId);
      if (splitIdx < 0 || splitIdx >= scene.panelIds.length - 1) return curr;
      const leftPanels = scene.panelIds.slice(0, splitIdx + 1);
      const rightPanels = scene.panelIds.slice(splitIdx + 1);
      const left: WorkingScene = { ...scene, panelIds: leftPanels };
      const right: WorkingScene = {
        id: makeId(),
        musicMood: scene.musicMood,
        label: null,
        panelIds: rightPanels,
      };
      const result = [...curr];
      result.splice(idx, 1, left, right);
      return result;
    });
  }, []);

  const assignPanelToScene = useCallback(
    (panelId: string, targetSceneId: string) => {
      setScenes((curr) => {
        // Remove from current scene if any
        let updated = curr.map((s) => ({
          ...s,
          panelIds: s.panelIds.filter((id) => id !== panelId),
        }));
        // Add to target
        updated = updated.map((s) =>
          s.id === targetSceneId
            ? { ...s, panelIds: [...s.panelIds, panelId] }
            : s,
        );
        // Remove empty scenes
        return updated.filter((s) => s.panelIds.length > 0);
      });
    },
    [],
  );

  const createSceneFromPanels = useCallback((panelIds: string[]) => {
    if (panelIds.length === 0) return;
    setScenes((curr) => {
      // Remove these panels from any existing scene
      const cleaned = curr
        .map((s) => ({
          ...s,
          panelIds: s.panelIds.filter((id) => !panelIds.includes(id)),
        }))
        .filter((s) => s.panelIds.length > 0);
      const newScene: WorkingScene = {
        id: makeId(),
        musicMood: "transition_neutral",
        label: null,
        panelIds: [...panelIds],
      };
      return [...cleaned, newScene];
    });
  }, []);

  const autoConsolidate = useCallback(() => {
    const panels = data.panels;
    const newScenes: WorkingScene[] = [];
    let current: WorkingScene | null = null;

    for (const p of panels) {
      const mood = p.musicMood.replace(/_[a-z]$/, "").replace(/_\d+$/, "");

      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
      if (current && current.musicMood === mood && !p.isNewScene) {
        current.panelIds.push(p.id);
      } else {
        if (current) newScenes.push(current);
        current = {
          id: makeId(),
          musicMood: mood,
          label: null,
          panelIds: [p.id],
        };
      }
    }
    if (current) newScenes.push(current);
    setScenes(newScenes);
    setSelectedSceneId(null);
  }, [data.panels]);

  // ─── Save ───────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const entries: SceneSaveEntry[] = scenes.map((s) => ({
        musicMood: s.musicMood,
        label: s.label,
        panelIds: s.panelIds,
      }));
      const result = await saveScenes(data.bookId, data.issueId, entries);
      if (!result.ok) {
        setError(result.error ?? "Save failed");
      } else {
        setSavedAt(new Date().toLocaleTimeString());
      }
    } finally {
      setSaving(false);
    }
  }, [scenes, data.bookId, data.issueId]);

  // ─── Render ─────────────────────────────────────────────────────────────

  const sceneColorById = useMemo(() => {
    const m = new Map<string, string>();
    scenes.forEach((s, i) => m.set(s.id, sceneColor(i)));
    return m;
  }, [scenes]);

  return (
    <div className="flex flex-col gap-6">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={autoConsolidate}
          className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-700"
        >
          Auto-consolidate
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="rounded-lg bg-cyan-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save scenes"}
        </button>
        {savedAt && (
          <span className="text-xs text-green-400">Saved at {savedAt}</span>
        )}
        {error && <span className="text-xs text-red-400">{error}</span>}
        <span className="ml-auto text-xs text-neutral-500">
          {scenes.length} scene{scenes.length !== 1 ? "s" : ""} ·{" "}
          {data.panels.length} panels
          {unassignedPanelIds.length > 0 && (
            <span className="text-amber-400">
              {" "}
              · {unassignedPanelIds.length} unassigned
            </span>
          )}
        </span>
      </div>

      {/* Scene Lane */}
      <div className="rounded-xl border border-white/10 bg-neutral-900/80 p-4">
        <h3 className="mb-3 text-xs font-semibold tracking-wider text-neutral-500 uppercase">
          Scene Lane
        </h3>
        <div className="flex gap-1 overflow-x-auto pb-2">
          {scenes.map((scene, idx) => {
            const color = sceneColorById.get(scene.id)!;
            const isSelected = selectedSceneId === scene.id;
            return (
              <button
                key={scene.id}
                type="button"
                onClick={() => setSelectedSceneId(isSelected ? null : scene.id)}
                className={`relative flex min-w-[80px] shrink-0 flex-col items-start rounded-lg border-2 px-3 py-2 text-left transition-all ${
                  isSelected ? "ring-2 ring-white/40" : "hover:brightness-110"
                }`}
                style={{
                  borderColor: color,
                  backgroundColor: `${color}15`,
                  flex: `${scene.panelIds.length} 0 0`,
                }}
              >
                <span
                  className="text-[10px] font-bold tracking-wider uppercase"
                  style={{ color }}
                >
                  {idx + 1}
                </span>
                <span className="truncate text-xs font-medium text-neutral-200">
                  {scene.label ?? moodLabel(scene.musicMood)}
                </span>
                <span className="text-[10px] text-neutral-500">
                  {scene.panelIds.length} panel
                  {scene.panelIds.length !== 1 ? "s" : ""}
                </span>
              </button>
            );
          })}
          {scenes.length === 0 && (
            <div className="py-4 text-center text-xs text-neutral-600 italic">
              No scenes. Click &quot;Auto-consolidate&quot; to generate from
              panel moods.
            </div>
          )}
        </div>
      </div>

      {/* Scene Editor (when selected) */}
      {selectedScene && (
        <SceneDetailEditor
          scene={selectedScene}
          scenes={scenes}
          color={sceneColorById.get(selectedScene.id)!}
          panelById={panelById}
          onUpdate={(patch) => updateScene(selectedScene.id, patch)}
          onMerge={(targetId) => mergeScenes(selectedScene.id, targetId)}
          onSplit={(afterPanelId) => splitScene(selectedScene.id, afterPanelId)}
          onClose={() => setSelectedSceneId(null)}
        />
      )}

      {/* Panel Grid — shows all panels with scene assignment */}
      <div className="rounded-xl border border-white/10 bg-neutral-900/80 p-4">
        <h3 className="mb-3 text-xs font-semibold tracking-wider text-neutral-500 uppercase">
          All Panels
        </h3>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
          {data.panels.map((panel) => {
            const sid = sceneForPanel.get(panel.id);
            const color = sid ? sceneColorById.get(sid) : undefined;
            const isInSelected = selectedScene?.panelIds.includes(panel.id);
            return (
              <PanelChip
                key={panel.id}
                panel={panel}
                color={color}
                highlighted={isInSelected ?? false}
                scenes={scenes}
                sceneColorById={sceneColorById}
                currentSceneId={sid ?? null}
                onAssign={(targetSceneId) =>
                  assignPanelToScene(panel.id, targetSceneId)
                }
                onNewScene={() => createSceneFromPanels([panel.id])}
              />
            );
          })}
        </div>
      </div>

      {/* Unassigned panels */}
      {unassignedPanelIds.length > 0 && (
        <div className="flex items-center gap-3">
          <span className="text-xs text-amber-400">
            {unassignedPanelIds.length} unassigned panel
            {unassignedPanelIds.length !== 1 ? "s" : ""}
          </span>
          <button
            type="button"
            onClick={() => createSceneFromPanels(unassignedPanelIds)}
            className="rounded bg-amber-900/40 px-2 py-1 text-[10px] font-medium text-amber-300 hover:bg-amber-900/60"
          >
            Group into new scene
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Scene Detail Editor ──────────────────────────────────────────────────────

function SceneDetailEditor({
  scene,
  scenes,
  color,
  panelById,
  onUpdate,
  onMerge,
  onSplit,
  onClose,
}: {
  scene: WorkingScene;
  scenes: WorkingScene[];
  color: string;
  panelById: Map<string, { id: string; panelId: string; pageNumber: number }>;
  onUpdate: (patch: Partial<Omit<WorkingScene, "id">>) => void;
  onMerge: (targetId: string) => void;
  onSplit: (afterPanelId: string) => void;
  onClose: () => void;
}) {
  const sceneIdx = scenes.findIndex((s) => s.id === scene.id);
  const prevScene = sceneIdx > 0 ? scenes[sceneIdx - 1] : null;
  const nextScene = sceneIdx < scenes.length - 1 ? scenes[sceneIdx + 1] : null;

  const firstPanel = panelById.get(scene.panelIds[0]!);
  const lastPanel = panelById.get(scene.panelIds[scene.panelIds.length - 1]!);

  return (
    <div
      className="rounded-xl border-2 p-4"
      style={{ borderColor: color, backgroundColor: `${color}08` }}
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-100">
          Scene {sceneIdx + 1}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          Close
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Mood */}
        <div>
          <label className="mb-1 block text-[10px] font-semibold tracking-wider text-neutral-500 uppercase">
            Mood
          </label>
          <select
            value={scene.musicMood}
            onChange={(e) => onUpdate({ musicMood: e.target.value })}
            className="w-full rounded-lg border border-white/10 bg-neutral-800 px-3 py-1.5 text-xs text-neutral-100"
          >
            {MUSIC_MOODS.map((m) => (
              <option key={m} value={m}>
                {moodLabel(m)}
              </option>
            ))}
          </select>
        </div>

        {/* Label */}
        <div>
          <label className="mb-1 block text-[10px] font-semibold tracking-wider text-neutral-500 uppercase">
            Label (optional)
          </label>
          <input
            type="text"
            value={scene.label ?? ""}
            onChange={(e) => onUpdate({ label: e.target.value || null })}
            placeholder="e.g. Opening fight"
            className="w-full rounded-lg border border-white/10 bg-neutral-800 px-3 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-600"
          />
        </div>
      </div>

      {/* Panel range info */}
      <div className="mt-3 text-xs text-neutral-400">
        Panels: {scene.panelIds.length} · Pages {firstPanel?.pageNumber ?? "?"}–
        {lastPanel?.pageNumber ?? "?"} · {firstPanel?.panelId ?? "?"} →{" "}
        {lastPanel?.panelId ?? "?"}
      </div>

      {/* Split controls */}
      {scene.panelIds.length > 1 && (
        <div className="mt-3">
          <span className="mb-1 block text-[10px] font-semibold tracking-wider text-neutral-500 uppercase">
            Split after panel
          </span>
          <div className="flex flex-wrap gap-1">
            {scene.panelIds.slice(0, -1).map((pid) => {
              const p = panelById.get(pid);
              return (
                <button
                  key={pid}
                  type="button"
                  onClick={() => onSplit(pid)}
                  className="rounded bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-700"
                >
                  {p?.panelId ?? pid.slice(0, 6)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Merge controls */}
      <div className="mt-3 flex gap-2">
        {prevScene && (
          <button
            type="button"
            onClick={() => onMerge(prevScene.id)}
            className="rounded bg-neutral-800 px-3 py-1 text-[10px] font-medium text-neutral-300 hover:bg-neutral-700"
          >
            ← Merge with previous
          </button>
        )}
        {nextScene && (
          <button
            type="button"
            onClick={() => onMerge(nextScene.id)}
            className="rounded bg-neutral-800 px-3 py-1 text-[10px] font-medium text-neutral-300 hover:bg-neutral-700"
          >
            Merge with next →
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Panel Chip ───────────────────────────────────────────────────────────────

function PanelChip({
  panel,
  color,
  highlighted,
  scenes,
  sceneColorById,
  currentSceneId,
  onAssign,
  onNewScene,
}: {
  panel: { id: string; panelId: string; pageNumber: number; musicMood: string };
  color?: string;
  highlighted: boolean;
  scenes: WorkingScene[];
  sceneColorById: Map<string, string>;
  currentSceneId: string | null;
  onAssign: (sceneId: string) => void;
  onNewScene: () => void;
}) {
  const [showMenu, setShowMenu] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setShowMenu(!showMenu)}
        className={`flex w-full flex-col rounded-lg border px-3 py-2 text-left transition-all ${
          highlighted ? "ring-2 ring-white/30" : ""
        }`}
        style={{
          borderColor: color ?? "#525252",
          backgroundColor: color ? `${color}15` : "#1a1a1a",
        }}
      >
        <span className="text-[10px] text-neutral-500">
          pg {panel.pageNumber}
        </span>
        <span className="text-xs font-medium text-neutral-200">
          {panel.panelId}
        </span>
        <span className="truncate text-[10px] text-neutral-500">
          {moodLabel(panel.musicMood)}
        </span>
      </button>

      {showMenu && (
        <div className="absolute top-full right-0 z-20 mt-1 min-w-[160px] rounded-lg border border-white/10 bg-neutral-900 p-1 shadow-xl">
          {scenes
            .filter((s) => s.id !== currentSceneId)
            .map((s) => {
              const c = sceneColorById.get(s.id)!;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    onAssign(s.id);
                    setShowMenu(false);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-neutral-200 hover:bg-white/10"
                >
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: c }}
                  />
                  {s.label ?? moodLabel(s.musicMood)}
                </button>
              );
            })}
          <button
            type="button"
            onClick={() => {
              onNewScene();
              setShowMenu(false);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-amber-300 hover:bg-white/10"
          >
            + New scene
          </button>
          <button
            type="button"
            onClick={() => setShowMenu(false)}
            className="mt-1 w-full rounded px-2 py-1 text-left text-[10px] text-neutral-500 hover:bg-white/10"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildScenesFromData(data: SceneReviewData): WorkingScene[] {
  if (data.scenes.length === 0) return [];

  const panelSceneMap = new Map<string, string>();
  for (const panel of data.panels) {
    if (panel.sceneId) panelSceneMap.set(panel.id, panel.sceneId);
  }

  return data.scenes.map((s) => ({
    id: s.id,
    musicMood: s.musicMood,
    label: s.label,
    panelIds: data.panels
      .filter((p) => panelSceneMap.get(p.id) === s.id)
      .map((p) => p.id),
  }));
}
