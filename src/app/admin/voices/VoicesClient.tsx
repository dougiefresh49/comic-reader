"use client";

import { useState, useMemo } from "react";
import { toggleKeepActive, type VoiceRow } from "./actions";

type StatusFilter = "all" | "active" | "archived" | "library";

export function VoicesClient({ voices: initial }: { voices: VoiceRow[] }) {
  const [voices, setVoices] = useState(initial);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [seriesFilter, setSeriesFilter] = useState<string>("all");
  const [updating, setUpdating] = useState<string | null>(null);

  const seriesIds = useMemo(() => {
    const set = new Set<string>();
    voices.forEach((v) => {
      if (v.series_id) set.add(v.series_id);
    });
    return Array.from(set).sort();
  }, [voices]);

  const filtered = useMemo(
    () =>
      voices.filter((v) => {
        if (filter !== "all" && v.status !== filter) return false;
        if (seriesFilter !== "all" && v.series_id !== seriesFilter)
          return false;
        return true;
      }),
    [voices, filter, seriesFilter],
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
    const result = await toggleKeepActive(id, !current);
    if (result.ok) {
      setVoices((prev) =>
        prev.map((v) => (v.id === id ? { ...v, keep_active: !current } : v)),
      );
    }
    setUpdating(null);
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
        {seriesIds.length > 1 && (
          <select
            value={seriesFilter}
            onChange={(e) => setSeriesFilter(e.target.value)}
            className="rounded bg-neutral-800 px-2 py-1 text-xs"
          >
            <option value="all">All series</option>
            {seriesIds.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-neutral-800 bg-neutral-900/50 text-xs text-neutral-400">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Series</th>
              <th className="px-3 py-2 font-medium">EL ID</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Keep Active</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800/50">
            {filtered.map((v) => (
              <tr key={v.id} className="hover:bg-neutral-900/50">
                <td className="px-3 py-2 font-medium">{v.display_name}</td>
                <td className="px-3 py-2">
                  <StatusBadge status={v.status} />
                </td>
                <td className="px-3 py-2 text-xs text-neutral-400">
                  {v.series_id ?? "—"}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-neutral-500">
                  {v.current_elevenlabs_id
                    ? v.current_elevenlabs_id.slice(0, 10) + "…"
                    : "—"}
                </td>
                <td className="px-3 py-2 text-xs text-neutral-400">
                  {v.source_clip_path
                    ? "clip"
                    : v.design_prompt
                      ? "design"
                      : "—"}
                </td>
                <td className="px-3 py-2">
                  <button
                    onClick={() => handleToggleKeepActive(v.id, v.keep_active)}
                    disabled={updating === v.id}
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
              </tr>
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
        {counts.active} active of 30 ElevenLabs Creator slots.
        {counts.active >= 25 && (
          <span className="ml-1 text-amber-400">
            Approaching cap — consider archiving unused voices.
          </span>
        )}
      </p>
    </div>
  );
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
