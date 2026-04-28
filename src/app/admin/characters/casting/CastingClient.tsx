"use client";

import { useState, useTransition } from "react";
import type { CastingAppearance, CastingTask } from "~/server/admin/casting";
import {
  markCastingComplete,
  selectAppearance,
  skipCastingTask,
} from "./actions";

interface Props {
  initialTasks: CastingTask[];
}

export function CastingClient({ initialTasks }: Props) {
  const [tasks, setTasks] = useState<CastingTask[]>(initialTasks);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const handleSelect = (task: CastingTask, appearance: CastingAppearance) => {
    startTransition(async () => {
      const res = await selectAppearance(appearance.id, task.characterId);
      if (!res.ok) {
        setMsg(`Error: ${res.error}`);
        return;
      }
      setTasks((prev) =>
        prev.map((t) =>
          t.id === task.id
            ? {
                ...t,
                status: "in_progress",
                appearances: t.appearances.map((a) =>
                  a.id === appearance.id
                    ? { ...a, voiceModelStatus: "processing" }
                    : a,
                ),
              }
            : t,
        ),
      );
      setMsg(
        `Selected source for ${task.characterName}. Clip download + voice model creation will run in the next pipeline run (or via worker).`,
      );
    });
  };

  const handleManualComplete = (
    task: CastingTask,
    appearance: CastingAppearance,
  ) => {
    const voiceId = window.prompt(
      `Voice model already created for ${task.characterName}? Enter the ElevenLabs voice ID:`,
      appearance.voiceId ?? "",
    );
    if (!voiceId) return;
    startTransition(async () => {
      const res = await markCastingComplete(
        task.id,
        task.characterId,
        voiceId.trim(),
        appearance.id,
        task.bookId,
        task.issueId,
      );
      if (!res.ok) {
        setMsg(`Error: ${res.error}`);
        return;
      }
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
      setMsg(`✓ ${task.characterName} marked complete.`);
    });
  };

  const handleSkip = (task: CastingTask) => {
    if (!window.confirm(`Skip casting for ${task.characterName}?`)) return;
    startTransition(async () => {
      const res = await skipCastingTask(task.id);
      if (!res.ok) {
        setMsg(`Error: ${res.error}`);
        return;
      }
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
    });
  };

  return (
    <div className="space-y-4">
      {msg && (
        <div className="rounded border border-cyan-700 bg-cyan-900/20 px-4 py-2 text-sm text-cyan-200">
          {msg}
        </div>
      )}

      <div className="text-sm text-neutral-400">
        {tasks.length} character{tasks.length === 1 ? "" : "s"} need
        {tasks.length === 1 ? "s" : ""} casting
      </div>

      {tasks.map((task) => (
        <CharacterCard
          key={task.id}
          task={task}
          onSelect={handleSelect}
          onComplete={handleManualComplete}
          onSkip={handleSkip}
          disabled={pending}
        />
      ))}
    </div>
  );
}

function CharacterCard({
  task,
  onSelect,
  onComplete,
  onSkip,
  disabled,
}: {
  task: CastingTask;
  onSelect: (t: CastingTask, a: CastingAppearance) => void;
  onComplete: (t: CastingTask, a: CastingAppearance) => void;
  onSkip: (t: CastingTask) => void;
  disabled: boolean;
}) {
  const inProgress = task.appearances.find(
    (a) => a.voiceModelStatus === "processing",
  );

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-base font-medium">{task.characterName}</h3>
          {task.franchise && (
            <p className="text-xs text-neutral-500">
              Franchise: {task.franchise}
            </p>
          )}
        </div>
        <button
          onClick={() => onSkip(task)}
          disabled={disabled}
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          Skip
        </button>
      </div>

      {inProgress && (
        <div className="mb-3 rounded bg-yellow-900/30 px-3 py-2 text-xs text-yellow-200">
          Selected: {inProgress.mediaTitle ?? "—"} · status:{" "}
          {inProgress.voiceModelStatus}
          {inProgress.voiceId ? ` · voice_id: ${inProgress.voiceId}` : ""}
        </div>
      )}

      {task.appearances.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No Gemini suggestions yet — run{" "}
          <code className="rounded bg-neutral-800 px-1 text-xs">
            find-voice-sources --db
          </code>
          .
        </p>
      ) : (
        <div className="space-y-2">
          {task.appearances.map((app, i) => (
            <AppearanceRow
              key={app.id}
              appearance={app}
              isFirst={i === 0}
              onSelect={() => onSelect(task, app)}
              onComplete={() => onComplete(task, app)}
              disabled={disabled}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AppearanceRow({
  appearance,
  isFirst,
  onSelect,
  onComplete,
  disabled,
}: {
  appearance: CastingAppearance;
  isFirst: boolean;
  onSelect: () => void;
  onComplete: () => void;
  disabled: boolean;
}) {
  const isReady = appearance.voiceModelStatus === "ready";
  const isProcessing = appearance.voiceModelStatus === "processing";
  return (
    <div className="rounded border border-neutral-700 bg-neutral-950 p-3">
      <div className="mb-2 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-neutral-100">
            {isFirst && <span className="text-yellow-400">★</span>}
            {appearance.mediaTitle ?? "—"}
            {appearance.year && (
              <span className="text-xs text-neutral-500">
                ({appearance.year})
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-neutral-400">
            {appearance.voiceActor && `Voice: ${appearance.voiceActor}`}
            {appearance.mediaType && ` · ${appearance.mediaType}`}
          </div>
          {appearance.youtubeSearchTerms?.length ? (
            <div className="mt-1 text-xs text-neutral-500">
              Search: {appearance.youtubeSearchTerms.join(", ")}
            </div>
          ) : null}
          {appearance.notes && (
            <div className="mt-1 text-xs text-neutral-500 italic">
              {appearance.notes}
            </div>
          )}
        </div>
        <span
          className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-medium ${
            isReady
              ? "bg-emerald-700/40 text-emerald-200"
              : isProcessing
                ? "bg-yellow-700/40 text-yellow-200"
                : "bg-neutral-800 text-neutral-400"
          }`}
        >
          {appearance.voiceModelStatus}
        </span>
      </div>

      <div className="flex gap-2">
        {!isReady && !isProcessing && (
          <button
            onClick={onSelect}
            disabled={disabled}
            className="rounded bg-cyan-700 px-3 py-1 text-xs font-medium text-white hover:bg-cyan-600 disabled:opacity-40"
          >
            Use this source
          </button>
        )}
        <button
          onClick={onComplete}
          disabled={disabled}
          className="rounded bg-neutral-700 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-600 disabled:opacity-40"
        >
          Mark complete (manual voice ID)
        </button>
      </div>
    </div>
  );
}
