"use client";

import { useState, useTransition } from "react";
import type { CastingAppearance, CastingTask } from "~/server/admin/casting";
import {
  bulkVoiceDesign,
  completeCasting,
  createVoiceDesign,
  markChosenSource,
  researchCharacter,
  saveVoiceId,
  skipAndAddLater,
} from "./actions";

interface Props {
  initialTasks: CastingTask[];
  bookId?: string;
  issueId?: string;
}

export function CastingClient({ initialTasks, bookId, issueId }: Props) {
  const [tasks, setTasks] = useState<CastingTask[]>(initialTasks);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [researchingIds, setResearchingIds] = useState<Set<string>>(new Set());

  const unresearched = tasks.filter((t) => !t.researched);
  const researched = tasks.filter((t) => t.researched);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(unresearched.map((t) => t.characterId)));
  };

  const selectNone = () => setSelected(new Set());

  const handleResearchSelected = () => {
    const toResearch = unresearched.filter((t) => selected.has(t.characterId));
    if (toResearch.length === 0) return;

    const ids = new Set(toResearch.map((t) => t.characterId));
    setResearchingIds(ids);

    startTransition(async () => {
      for (const task of toResearch) {
        const res = await researchCharacter({
          characterId: task.characterId,
          franchise: task.franchise ?? undefined,
        });
        if (res.ok && res.appearances) {
          setTasks((prev) =>
            prev.map((t) =>
              t.characterId === task.characterId
                ? {
                    ...t,
                    researched: true,
                    appearances: (res.appearances ?? []).map((a) => ({
                      id: `${task.characterId}-${a.mediaTitle}-${a.year}`
                        .toLowerCase()
                        .replace(/[^a-z0-9-]/g, "-")
                        .replace(/-+/g, "-")
                        .slice(0, 80),
                      mediaTitle: a.mediaTitle,
                      year: a.year,
                      voiceActor: a.voiceActor,
                      mediaType: a.mediaType,
                      youtubeSearchTerms: a.youtubeSearchTerms,
                      notes: a.notes,
                      voiceId: null,
                      voiceType: null,
                      voiceStatus: null,
                      voiceDescription: null,
                      clipStoragePath: null,
                      clipSourceUrl: null,
                      clipDurationSecs: null,
                      voiceModelStatus: "pending",
                      voiceModelError: null,
                      voiceModelStartedAt: null,
                    })),
                  }
                : t,
            ),
          );
        }
        setResearchingIds((prev) => {
          const next = new Set(prev);
          next.delete(task.characterId);
          return next;
        });
      }
      setSelected(new Set());
      setMsg(
        `Researched ${toResearch.length} character${toResearch.length === 1 ? "" : "s"}.`,
      );
    });
  };

  const handleBulkVoiceDesign = () => {
    const toDesign = unresearched.filter((t) => selected.has(t.characterId));
    if (toDesign.length === 0) return;
    if (
      !window.confirm(
        `Generate Voice Design for ${toDesign.length} character(s)? This uses ElevenLabs credits.`,
      )
    )
      return;

    startTransition(async () => {
      const res = await bulkVoiceDesign({
        tasks: toDesign.map((t) => ({
          taskId: t.id,
          characterId: t.characterId,
          bookId: t.bookId,
          issueId: t.issueId,
          voiceDescription: `A distinctive character voice for ${t.characterName} from ${t.franchise ?? "comics"}.`,
        })),
      });
      if (res.ok && res.results) {
        const doneIds = new Set(
          res.results.filter((r) => r.ok).map((r) => r.characterId),
        );
        setTasks((prev) => prev.filter((t) => !doneIds.has(t.characterId)));
        const failed = res.results.filter((r) => !r.ok);
        if (failed.length > 0) {
          setMsg(
            `Designed ${doneIds.size} voice(s). ${failed.length} failed: ${failed.map((f) => f.characterId).join(", ")}`,
          );
        } else {
          setMsg(`Designed ${doneIds.size} voice(s) via Voice Design.`);
        }
      }
      setSelected(new Set());
    });
  };

  const handleSaveVoiceId = (
    task: CastingTask,
    voiceId: string,
    chosenAppearanceId: string | null,
  ) => {
    startTransition(async () => {
      const res = await saveVoiceId({
        taskId: task.id,
        characterId: task.characterId,
        bookId: task.bookId,
        issueId: task.issueId,
        voiceId,
        appearanceId: chosenAppearanceId ?? undefined,
      });
      if (!res.ok) {
        setMsg(`Error: ${res.error}`);
        return;
      }
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
      setMsg(`${task.characterName} voice saved.`);
    });
  };

  const handleSkip = (task: CastingTask) => {
    if (
      !window.confirm(
        `Skip casting for ${task.characterName}? Their bubbles will not have audio generated until you come back and add a voice ID.`,
      )
    )
      return;
    startTransition(async () => {
      const res = await skipAndAddLater({
        taskId: task.id,
        characterId: task.characterId,
        bookId: task.bookId,
        issueId: task.issueId,
      });
      if (!res.ok) {
        setMsg(`Error: ${res.error}`);
        return;
      }
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
      setMsg(`${task.characterName} skipped — bubbles will be silent.`);
    });
  };

  const handleMarkSource = (task: CastingTask, appearanceId: string) => {
    startTransition(async () => {
      await markChosenSource({ appearanceId });
      setTasks((prev) =>
        prev.map((t) =>
          t.id === task.id
            ? {
                ...t,
                appearances: t.appearances.map((a) =>
                  a.id === appearanceId
                    ? { ...a, voiceModelStatus: "processing" }
                    : a,
                ),
              }
            : t,
        ),
      );
    });
  };

  const handleVoiceDesign = (task: CastingTask, description: string) => {
    startTransition(async () => {
      const res = await createVoiceDesign({
        taskId: task.id,
        characterId: task.characterId,
        bookId: task.bookId,
        issueId: task.issueId,
        voiceDescription: description,
      });
      if (!res.ok) {
        setMsg(`Error: ${res.error}`);
        return;
      }
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
      setMsg(`${task.characterName} voice designed (${res.voiceId}).`);
    });
  };

  const handleCompleteCasting = () => {
    if (!bookId || !issueId) return;
    startTransition(async () => {
      const res = await completeCasting({ bookId, issueId });
      if (!res.ok) {
        setMsg(`Error: ${res.error}`);
        return;
      }
      setCompleted(true);
      setMsg("Casting complete — pipeline unpaused.");
    });
  };

  return (
    <div className="space-y-6">
      {msg && (
        <div className="rounded border border-cyan-700 bg-cyan-900/20 px-4 py-2 text-sm text-cyan-200">
          {msg}
        </div>
      )}

      {/* ── Phase 1: Triage — select characters to research ── */}
      {unresearched.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-medium text-neutral-200">
              Select Characters to Research
            </h2>
            <div className="flex gap-2 text-xs">
              <button
                onClick={selectAll}
                className="text-neutral-400 hover:text-neutral-200"
              >
                Select all
              </button>
              <span className="text-neutral-700">|</span>
              <button
                onClick={selectNone}
                className="text-neutral-400 hover:text-neutral-200"
              >
                None
              </button>
            </div>
          </div>

          <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 text-xs text-neutral-400">
            Check characters you want Gemini to research (voice actors, media
            appearances, YouTube clips). Unchecked characters can go straight to
            Voice Design or Skip.
          </div>

          <div className="space-y-1">
            {unresearched.map((task) => (
              <TriageRow
                key={task.id}
                task={task}
                checked={selected.has(task.characterId)}
                researching={researchingIds.has(task.characterId)}
                onToggle={() => toggleSelect(task.characterId)}
                onSkip={() => handleSkip(task)}
              />
            ))}
          </div>

          <div className="mt-4 flex gap-3">
            <button
              onClick={handleResearchSelected}
              disabled={pending || selected.size === 0}
              className="rounded bg-cyan-700 px-5 py-2 text-sm font-semibold text-white hover:bg-cyan-600 disabled:opacity-40"
            >
              Research Selected ({selected.size})
            </button>
            <button
              onClick={handleBulkVoiceDesign}
              disabled={pending || selected.size === 0}
              className="rounded border border-purple-700 px-5 py-2 text-sm font-semibold text-purple-300 hover:bg-purple-900/20 disabled:opacity-40"
            >
              Voice Design Selected ({selected.size})
            </button>
          </div>
        </section>
      )}

      {/* ── Phase 2: Cast — researched characters with full cards ── */}
      {researched.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-medium text-neutral-200">
            Cast Voices
          </h2>

          <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 text-xs text-neutral-400">
            <strong className="text-neutral-300">How this works:</strong> Click
            search links to find clips on YouTube. Download and splice locally,
            then create an{" "}
            <a
              href="https://elevenlabs.io/app/voice-library"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-cyan-300"
            >
              ElevenLabs IVC voice
            </a>{" "}
            and paste the voice ID. Or use Voice Design for a generated voice.
          </div>

          <div className="space-y-4">
            {researched.map((task) => (
              <CharacterCard
                key={task.id}
                task={task}
                disabled={pending}
                onSaveVoiceId={handleSaveVoiceId}
                onSkip={handleSkip}
                onMarkSource={handleMarkSource}
                onVoiceDesign={handleVoiceDesign}
              />
            ))}
          </div>
        </section>
      )}

      {tasks.length === 0 && !completed && bookId && issueId && (
        <div className="rounded-lg border border-emerald-800 bg-emerald-900/20 p-6 text-center">
          <p className="mb-3 text-sm text-emerald-200">
            All characters cast. Ready to resume the pipeline.
          </p>
          <button
            onClick={handleCompleteCasting}
            disabled={pending}
            className="rounded bg-emerald-700 px-6 py-2.5 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
          >
            Complete Casting
          </button>
        </div>
      )}

      {completed && (
        <div className="rounded-lg border border-emerald-800 bg-emerald-900/20 p-6 text-center">
          <p className="mb-2 text-sm text-emerald-200">
            Pipeline unpaused. Resume with:
          </p>
          <code className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200">
            pnpm ingest -- --book {bookId} --issue{" "}
            {issueId?.replace("issue-", "")}
          </code>
          <div className="mt-3">
            <a
              href="/admin"
              className="text-xs text-neutral-400 hover:text-neutral-200"
            >
              ← Back to dashboard
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function TriageRow({
  task,
  checked,
  researching,
  onToggle,
  onSkip,
}: {
  task: CastingTask;
  checked: boolean;
  researching: boolean;
  onToggle: () => void;
  onSkip: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded px-3 py-2.5 transition-colors ${
        checked
          ? "border border-cyan-800 bg-cyan-900/10"
          : "border border-neutral-800 bg-neutral-900"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={researching}
        className="h-4 w-4 accent-cyan-600"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-neutral-100">
            {task.characterName}
          </span>
          {researching && (
            <span className="animate-pulse text-xs text-cyan-400">
              researching...
            </span>
          )}
        </div>
        {task.wikiVoiceHint && (
          <p className="mt-0.5 text-xs text-amber-400/80">
            Wiki: voiced by {task.wikiVoiceHint}
          </p>
        )}
        {task.franchise && !task.wikiVoiceHint && (
          <p className="mt-0.5 text-xs text-neutral-500">{task.franchise}</p>
        )}
      </div>
      <button
        onClick={onSkip}
        className="text-xs text-neutral-500 hover:text-yellow-400"
      >
        Skip
      </button>
    </div>
  );
}

function youtubeSearchUrl(query: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

function CharacterCard({
  task,
  disabled,
  onSaveVoiceId,
  onSkip,
  onMarkSource,
  onVoiceDesign,
}: {
  task: CastingTask;
  disabled: boolean;
  onSaveVoiceId: (
    task: CastingTask,
    voiceId: string,
    chosenAppearanceId: string | null,
  ) => void;
  onSkip: (task: CastingTask) => void;
  onMarkSource: (task: CastingTask, appearanceId: string) => void;
  onVoiceDesign: (task: CastingTask, description: string) => void;
}) {
  const [voiceIdInput, setVoiceIdInput] = useState("");
  const [chosenAppearanceId, setChosenAppearanceId] = useState<string | null>(
    task.appearances.find((a) => a.voiceModelStatus === "processing")?.id ??
      null,
  );
  const [showDesign, setShowDesign] = useState(false);
  const [designPrompt, setDesignPrompt] = useState(
    task.appearances[0]?.voiceDescription ?? "",
  );

  const submit = () => {
    if (!voiceIdInput.trim()) return;
    onSaveVoiceId(task, voiceIdInput.trim(), chosenAppearanceId);
  };

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
        <div className="flex gap-2">
          <button
            onClick={() => setShowDesign(!showDesign)}
            disabled={disabled}
            className="rounded border border-neutral-700 px-2.5 py-1 text-xs text-neutral-400 hover:border-purple-600 hover:text-purple-400 disabled:opacity-40"
          >
            Voice Design
          </button>
          <button
            onClick={() => onSkip(task)}
            disabled={disabled}
            className="rounded border border-neutral-700 px-2.5 py-1 text-xs text-neutral-400 hover:border-yellow-600 hover:text-yellow-400 disabled:opacity-40"
          >
            Skip
          </button>
        </div>
      </div>

      {showDesign ? (
        <div className="space-y-3 rounded border border-purple-800 bg-purple-900/10 p-3">
          <p className="text-xs text-neutral-400">
            Generate a voice from a text description (minor/one-off characters).
          </p>
          <textarea
            value={designPrompt}
            onChange={(e) => setDesignPrompt(e.target.value)}
            rows={3}
            placeholder="A gruff adult male villain voice, deep and menacing with theatrical flair..."
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200"
          />
          <div className="flex gap-2">
            <button
              onClick={() => onVoiceDesign(task, designPrompt)}
              disabled={disabled || !designPrompt.trim()}
              className="rounded bg-purple-700 px-4 py-2 text-xs font-semibold text-white hover:bg-purple-600 disabled:opacity-40"
            >
              Generate Voice
            </button>
            <button
              onClick={() => setShowDesign(false)}
              className="text-xs text-neutral-500 hover:text-neutral-300"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {task.appearances.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No Gemini suggestions yet — run{" "}
              <code className="rounded bg-neutral-800 px-1 text-xs">
                find-voice-sources --db
              </code>{" "}
              locally.
            </p>
          ) : (
            <div className="space-y-2">
              {task.appearances.map((app, i) => (
                <SuggestionRow
                  key={app.id}
                  appearance={app}
                  isFirst={i === 0}
                  isChosen={chosenAppearanceId === app.id}
                  disabled={disabled}
                  onChoose={() => {
                    setChosenAppearanceId(app.id);
                    onMarkSource(task, app.id);
                  }}
                />
              ))}
            </div>
          )}

          {/* Voice ID paste */}
          <div className="mt-4 flex flex-col gap-2 border-t border-neutral-800 pt-4">
            <label className="text-xs text-neutral-400">
              ElevenLabs voice ID (paste once you&apos;ve created the IVC)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={voiceIdInput}
                onChange={(e) => setVoiceIdInput(e.target.value)}
                placeholder="abc123def456…"
                onKeyDown={(e) => e.key === "Enter" && submit()}
                className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-200"
              />
              <button
                onClick={submit}
                disabled={disabled || !voiceIdInput.trim()}
                className="rounded bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
              >
                Save voice ID
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SuggestionRow({
  appearance,
  isFirst,
  isChosen,
  disabled,
  onChoose,
}: {
  appearance: CastingAppearance;
  isFirst: boolean;
  isChosen: boolean;
  disabled: boolean;
  onChoose: () => void;
}) {
  const searchTerms = appearance.youtubeSearchTerms ?? [];

  return (
    <div
      className={`rounded border p-3 transition-colors ${
        isChosen
          ? "border-cyan-600 bg-cyan-900/10"
          : "border-neutral-700 bg-neutral-950"
      }`}
    >
      <div className="mb-2 flex items-start justify-between">
        <div className="flex-1">
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
          {appearance.notes && (
            <p className="mt-1 text-xs text-neutral-500 italic">
              {appearance.notes}
            </p>
          )}
          {searchTerms.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {searchTerms.map((term) => (
                <a
                  key={term}
                  href={youtubeSearchUrl(term)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded bg-red-900/30 px-2 py-0.5 text-[11px] text-red-200 hover:bg-red-900/50"
                  title={`Search YouTube for "${term}"`}
                >
                  ▶ {term}
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      <button
        onClick={onChoose}
        disabled={disabled || isChosen}
        className={`text-xs ${
          isChosen ? "text-cyan-400" : "text-neutral-500 hover:text-neutral-200"
        }`}
      >
        {isChosen ? "✓ Selected" : "Mark as my source"}
      </button>
    </div>
  );
}
