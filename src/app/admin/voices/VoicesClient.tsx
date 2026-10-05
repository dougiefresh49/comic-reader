"use client";

import { Fragment, useState, useMemo, useRef } from "react";
import { VOICE_SLOTS_TOTAL } from "~/lib/voice-slots/types";
import {
  toggleKeepActive,
  planVoiceOperation,
  executeVoiceOperation,
  getVoices,
  type VoiceRow,
  type VoicePlan,
  type VoiceOperation,
} from "./actions";

type StatusFilter = "all" | "active" | "archived" | "library";

export function VoicesClient({ voices: initial }: { voices: VoiceRow[] }) {
  const [voices, setVoices] = useState(initial);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [updating, setUpdating] = useState<string | null>(null);
  const [plan, setPlan] = useState<VoicePlan | null>(null);
  const confirming = useRef(false);
  const [results, setResults] = useState<
    Record<string, { ok: boolean; message: string }>
  >({});

  function showResult(id: string, result: { ok: boolean; message: string }) {
    setResults((prev) => ({ ...prev, [id]: result }));
  }

  const filtered = useMemo(
    () => voices.filter((v) => filter === "all" || v.status === filter),
    [voices, filter],
  );

  const counts = useMemo(() => {
    const c = { active: 0, archived: 0, library: 0 };
    voices.forEach((v) => {
      if (v.status in c) c[v.status as keyof typeof c]++;
    });
    return c;
  }, [voices]);

  async function handleToggleKeepActive(id: string, current: boolean) {
    setUpdating(id);
    setPlan(null);
    try {
      const result = await toggleKeepActive(id, !current);
      if (result.ok) {
        setVoices((prev) =>
          prev.map((v) => (v.id === id ? { ...v, keep_active: !current } : v)),
        );
      } else {
        showResult(id, { ok: false, message: result.error ?? "Update failed" });
      }
    } catch (error) {
      showResult(id, { ok: false, message: errorMessage(error) });
    } finally {
      setUpdating(null);
    }
  }

  async function handlePlan(id: string, operation: VoiceOperation) {
    setUpdating(id);
    setPlan(null);
    try {
      const result = await planVoiceOperation(id, operation);
      if (result.ok) setPlan(result.plan);
      else showResult(id, { ok: false, message: result.error });
    } catch (error) {
      showResult(id, { ok: false, message: errorMessage(error) });
    } finally {
      setUpdating(null);
    }
  }

  async function handleConfirm() {
    if (!plan?.eligible || updating || confirming.current) return;
    confirming.current = true;
    const { voiceId, operation, token } = plan;
    setUpdating(voiceId);
    try {
      const result = await executeVoiceOperation(voiceId, operation, token);
      showResult(voiceId, result);
      if (result.ok) {
        try {
          setVoices(await getVoices());
        } catch {
          showResult(voiceId, {
            ok: true,
            message: `${result.message} Row refresh failed. Reload the page.`,
          });
        }
      }
    } catch (error) {
      showResult(voiceId, {
        ok: false,
        message: `${errorMessage(error)} The change may have landed. Nothing was retried. Check ElevenLabs before repeating the operation.`,
      });
    } finally {
      confirming.current = false;
      setPlan(null);
      setUpdating(null);
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {(["all", "active", "archived", "library"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`rounded px-2.5 py-1 text-xs font-medium ${
                filter === s
                  ? "bg-cyan-700 text-white"
                  : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
              }`}
            >
              {s === "all" ? `All (${voices.length})` : `${s} (${counts[s]})`}
            </button>
          ))}
        </div>
      </div>

      {Object.entries(results)
        .filter(([id]) => !filtered.some((voice) => voice.id === id))
        .map(([id, result]) => (
          <p
            key={id}
            role="status"
            className={`mb-3 text-xs ${result.ok ? "text-emerald-300" : "text-amber-400"}`}
          >
            {voices.find((voice) => voice.id === id)?.display_name ?? id}:{" "}
            {result.ok ? "Success: " : "Failed: "}
            {result.message}
          </p>
        ))}

      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-neutral-800 bg-neutral-900/50 text-xs text-neutral-400">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">EL ID</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Keep Active</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800/50">
            {filtered.map((v) => (
              <Fragment key={v.id}>
                <tr className="hover:bg-neutral-900/50">
                  <td className="px-3 py-2 font-medium">{v.display_name}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={v.status} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-neutral-500">
                    {v.current_elevenlabs_id
                      ? v.current_elevenlabs_id.slice(0, 10) + "…"
                      : "None"}
                  </td>
                  <td className="px-3 py-2 text-xs text-neutral-400">
                    {v.source_clip_path
                      ? "clip"
                      : v.design_prompt
                        ? "design"
                        : "None"}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() =>
                        handleToggleKeepActive(v.id, v.keep_active)
                      }
                      disabled={updating !== null}
                      className={`rounded px-2 py-0.5 text-xs font-medium transition ${
                        v.keep_active
                          ? "bg-emerald-900/50 text-emerald-300 hover:bg-emerald-900"
                          : "bg-neutral-800 text-neutral-500 hover:bg-neutral-700 hover:text-neutral-300"
                      } disabled:opacity-40`}
                    >
                      {updating === v.id
                        ? "…"
                        : v.keep_active
                          ? "pinned"
                          : "auto"}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      {(v.status === "active"
                        ? (["archive", "snapshot"] as const)
                        : v.status === "archived"
                          ? (["restore"] as const)
                          : []
                      ).map((operation) => (
                        <button
                          key={operation}
                          onClick={() => handlePlan(v.id, operation)}
                          disabled={updating !== null}
                          className="rounded bg-neutral-800 px-2 py-0.5 text-xs font-medium text-neutral-400 capitalize hover:bg-neutral-700 disabled:opacity-40"
                        >
                          {operation}
                        </button>
                      ))}
                    </div>
                    {updating === v.id && (
                      <p
                        role="status"
                        className="mt-2 text-xs text-neutral-400"
                      >
                        Working...
                      </p>
                    )}
                    {results[v.id] && (
                      <p
                        role="status"
                        className={`mt-2 text-xs ${results[v.id]!.ok ? "text-emerald-300" : "text-amber-400"}`}
                      >
                        {results[v.id]!.ok ? "Success: " : "Failed: "}
                        {results[v.id]!.message}
                      </p>
                    )}
                  </td>
                </tr>
                {plan?.voiceId === v.id && (
                  <tr>
                    <td colSpan={6} className="bg-neutral-900/50 px-3 py-4">
                      <div
                        role="region"
                        aria-label={`${plan.operation} plan for ${plan.voiceName}`}
                      >
                        <h2 className="mb-2 font-medium">
                          <span className="capitalize">{plan.operation}</span>{" "}
                          plan for {plan.voiceName}
                        </h2>
                        <p className="text-xs text-neutral-400">
                          ElevenLabs slots: {plan.status.voice_slots_used} of{" "}
                          {plan.status.voice_limit} used. Add/edits:{" "}
                          {plan.status.voice_add_edit_counter} of{" "}
                          {plan.status.max_voice_add_edits} used,{" "}
                          {Math.max(
                            0,
                            plan.status.max_voice_add_edits -
                              plan.status.voice_add_edit_counter,
                          )}{" "}
                          remaining.
                        </p>
                        <p className="mt-2 text-xs text-neutral-400">
                          {plan.operation === "archive"
                            ? "Confirm deletes this voice from ElevenLabs and marks it archived. Its hash-checked bucket copy remains the restore source."
                            : plan.operation === "restore"
                              ? "Confirm restores this voice from its hash-checked bucket copy, uses one slot and one add/edit, and saves the new ElevenLabs ID."
                              : `Confirm saves ${plan.sampleCount ?? 0} hash-checked sample(s) to the private bucket and updates the voice's snapshot. Slot use does not change.`}
                        </p>
                        <p className="mt-2 text-xs">
                          {plan.eligible ? "Eligible." : "Refused."}
                        </p>
                        {plan.refusals.length > 0 && (
                          <ul className="mt-2 list-inside list-disc text-xs text-amber-400">
                            {plan.refusals.map((reason, i) => (
                              <li key={i}>{reason}</li>
                            ))}
                          </ul>
                        )}
                        {plan.warnings.map((warning, i) => (
                          <p key={i} className="mt-2 text-xs text-amber-400">
                            {warning}
                          </p>
                        ))}
                        <div className="mt-3 flex gap-2">
                          <button
                            onClick={handleConfirm}
                            disabled={!plan.eligible || updating !== null}
                            className="rounded bg-neutral-800 px-2.5 py-1 text-xs font-medium text-neutral-100 hover:bg-neutral-700 disabled:opacity-40"
                          >
                            {updating === plan.voiceId
                              ? "Confirming..."
                              : `Confirm ${plan.operation}`}
                          </button>
                          <button
                            onClick={() => setPlan(null)}
                            disabled={updating !== null}
                            className="rounded bg-neutral-800 px-2.5 py-1 text-xs font-medium text-neutral-400 hover:bg-neutral-700 disabled:opacity-40"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-6 text-center text-sm text-neutral-500"
                >
                  No voices match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-neutral-600">
        {counts.active} active of {VOICE_SLOTS_TOTAL} ElevenLabs Creator slots.
        {counts.active >= 25 && (
          <span className="ml-1 text-amber-400">
            Approaching cap. Consider archiving unused voices.
          </span>
        )}
      </p>
    </div>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Voice request failed";
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: "bg-emerald-900/50 text-emerald-300",
    archived: "bg-neutral-800 text-neutral-400",
    library: "bg-blue-900/50 text-blue-300",
  };
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${styles[status] ?? "bg-neutral-800 text-neutral-400"}`}
    >
      {status}
    </span>
  );
}
