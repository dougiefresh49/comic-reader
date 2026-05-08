"use client";

import { useState, useTransition, useMemo, useCallback } from "react";
import { ApproveClusterButton } from "./ApproveClusterButton";
import {
  confirmCluster,
  rejectDetections,
  reassignDetections,
  renameCluster,
} from "./actions";
import Link from "next/link";

export interface ClusterFace {
  detectionId: string;
  exemplarId: string | null;
  cropUrl: string | null;
  confidence: number;
  humanVerified: boolean;
  isConfirmed: boolean;
  pageNumber: number;
  panelId: string;
  faceBbox: { x: number; y: number; w: number; h: number };
}

export interface CharacterCluster {
  key: string;
  characterId: string | null;
  suggestedName: string | null;
  label: string;
  faces: ClusterFace[];
  isResolved: boolean;
}

interface Props {
  bookId: string;
  issueId: string;
  initialClusters: CharacterCluster[];
  knownCharacters: { id: string; name: string }[];
}

export function ClusterReviewClient({
  bookId,
  issueId,
  initialClusters,
  knownCharacters,
}: Props) {
  const [clusters, setClusters] = useState(initialClusters);
  const [selected, setSelected] = useState<Map<string, Set<string>>>(new Map());
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{
    text: string;
    type: "error" | "success";
  } | null>(null);

  const stats = useMemo(() => {
    const total = clusters.reduce((s, c) => s + c.faces.length, 0);
    const unresolved = clusters
      .filter((c) => !c.isResolved)
      .reduce((s, c) => s + c.faces.length, 0);
    const confirmed = clusters.reduce(
      (s, c) => s + c.faces.filter((f) => f.humanVerified).length,
      0,
    );
    const allHandled = clusters.every((c) => c.isResolved);
    return {
      total,
      resolved: total - unresolved,
      unresolved,
      confirmed,
      allHandled,
    };
  }, [clusters]);

  const toggleFace = useCallback((clusterKey: string, detectionId: string) => {
    setSelected((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(clusterKey) ?? []);
      if (set.has(detectionId)) set.delete(detectionId);
      else set.add(detectionId);
      if (set.size === 0) next.delete(clusterKey);
      else next.set(clusterKey, set);
      return next;
    });
  }, []);

  const selectAllInCluster = useCallback((cluster: CharacterCluster) => {
    setSelected((prev) => {
      const next = new Map(prev);
      next.set(cluster.key, new Set(cluster.faces.map((f) => f.detectionId)));
      return next;
    });
  }, []);

  const clearSelection = useCallback((clusterKey: string) => {
    setSelected((prev) => {
      const next = new Map(prev);
      next.delete(clusterKey);
      return next;
    });
  }, []);

  function getSelectedFaces(clusterKey: string): ClusterFace[] {
    const ids = selected.get(clusterKey);
    if (!ids) return [];
    const cluster = clusters.find((c) => c.key === clusterKey);
    return cluster?.faces.filter((f) => ids.has(f.detectionId)) ?? [];
  }

  function handleConfirm(cluster: CharacterCluster) {
    startTransition(async () => {
      setMsg(null);
      const detectionIds = cluster.faces
        .map((f) => f.detectionId)
        .filter((id) => !id.startsWith("exemplar-only:"));
      const exemplarIds = cluster.faces
        .map((f) => f.exemplarId)
        .filter(Boolean) as string[];

      setClusters((prev) =>
        prev.map((c) =>
          c.key === cluster.key
            ? {
                ...c,
                faces: c.faces.map((f) => ({
                  ...f,
                  humanVerified: true,
                  isConfirmed: true,
                })),
              }
            : c,
        ),
      );

      const result = await confirmCluster({
        bookId,
        issueId,
        detectionIds,
        exemplarIds,
      });
      if (!result.ok) setMsg({ text: result.error, type: "error" });
      else setMsg({ text: `Confirmed ${cluster.label}`, type: "success" });
    });
  }

  function handleReject(clusterKey: string) {
    startTransition(async () => {
      setMsg(null);
      const faces = getSelectedFaces(clusterKey);
      if (faces.length === 0) return;

      const detectionIds = faces
        .map((f) => f.detectionId)
        .filter((id) => !id.startsWith("exemplar-only:"));
      const exemplarIds = faces
        .map((f) => f.exemplarId)
        .filter(Boolean) as string[];

      setClusters((prev) =>
        prev
          .map((c) =>
            c.key === clusterKey
              ? {
                  ...c,
                  faces: c.faces.filter(
                    (f) => !faces.some((s) => s.detectionId === f.detectionId),
                  ),
                }
              : c,
          )
          .filter((c) => c.faces.length > 0),
      );
      clearSelection(clusterKey);

      const result = await rejectDetections({
        bookId,
        issueId,
        detectionIds,
        exemplarIds,
      });
      if (!result.ok) setMsg({ text: result.error, type: "error" });
      else
        setMsg({ text: `Rejected ${faces.length} face(s)`, type: "success" });
    });
  }

  function handleAssign(clusterKey: string, targetCharacterId: string) {
    startTransition(async () => {
      setMsg(null);
      const cluster = clusters.find((c) => c.key === clusterKey);
      if (!cluster) return;

      const selIds = selected.get(clusterKey);
      const facesToMove =
        selIds && selIds.size > 0
          ? cluster.faces.filter((f) => selIds.has(f.detectionId))
          : cluster.faces;

      const detectionIds = facesToMove
        .map((f) => f.detectionId)
        .filter((id) => !id.startsWith("exemplar-only:"));
      const exemplarIds = facesToMove
        .map((f) => f.exemplarId)
        .filter(Boolean) as string[];

      setClusters((prev) => {
        let next = prev.map((c) => {
          if (c.key === clusterKey) {
            return {
              ...c,
              faces: c.faces.filter(
                (f) =>
                  !facesToMove.some((m) => m.detectionId === f.detectionId),
              ),
            };
          }
          return c;
        });

        const targetKey = targetCharacterId;
        const existingTarget = next.find(
          (c) => c.characterId === targetCharacterId,
        );
        if (existingTarget) {
          next = next.map((c) =>
            c.key === existingTarget.key
              ? { ...c, faces: [...c.faces, ...facesToMove] }
              : c,
          );
        } else {
          const charName =
            knownCharacters.find((k) => k.id === targetCharacterId)?.name ??
            targetCharacterId;
          next.push({
            key: targetKey,
            characterId: targetCharacterId,
            suggestedName: null,
            label: charName,
            faces: facesToMove,
            isResolved: true,
          });
        }

        return next.filter((c) => c.faces.length > 0);
      });
      clearSelection(clusterKey);

      const result = await reassignDetections({
        bookId,
        issueId,
        detectionIds,
        exemplarIds,
        targetCharacterId,
      });
      if (!result.ok) setMsg({ text: result.error, type: "error" });
      else
        setMsg({
          text: `Assigned ${facesToMove.length} face(s) to ${targetCharacterId}`,
          type: "success",
        });
    });
  }

  function handleRename(cluster: CharacterCluster, newCharacterId: string) {
    startTransition(async () => {
      setMsg(null);
      const detectionIds = cluster.faces
        .map((f) => f.detectionId)
        .filter((id) => !id.startsWith("exemplar-only:"));
      const exemplarIds = cluster.faces
        .map((f) => f.exemplarId)
        .filter(Boolean) as string[];

      setClusters((prev) =>
        prev.map((c) =>
          c.key === cluster.key
            ? {
                ...c,
                key: newCharacterId,
                characterId: newCharacterId,
                suggestedName: null,
                label: newCharacterId,
                isResolved: true,
              }
            : c,
        ),
      );

      const result = await renameCluster({
        bookId,
        issueId,
        detectionIds,
        exemplarIds,
        newCharacterId,
      });
      if (!result.ok) setMsg({ text: result.error, type: "error" });
      else
        setMsg({
          text: `Renamed cluster to ${newCharacterId}`,
          type: "success",
        });
    });
  }

  const unresolvedClusters = clusters.filter((c) => !c.isResolved);
  const resolvedClusters = clusters.filter((c) => c.isResolved);

  return (
    <div className="space-y-6">
      {/* Stats bar */}
      <div className="flex flex-wrap items-center gap-4 rounded-lg bg-neutral-900 px-4 py-3 text-sm">
        <span>
          <strong>{stats.total}</strong> faces
        </span>
        <span className="text-neutral-500">|</span>
        <span className="text-emerald-400">{stats.resolved} resolved</span>
        <span className="text-neutral-500">|</span>
        <span
          className={
            stats.unresolved > 0 ? "text-amber-400" : "text-neutral-500"
          }
        >
          {stats.unresolved} unresolved
        </span>
        <span className="text-neutral-500">|</span>
        <span className="text-neutral-400">{stats.confirmed} confirmed</span>
      </div>

      {/* Message banner */}
      {msg && (
        <div
          className={`rounded px-4 py-2 text-sm ${
            msg.type === "error"
              ? "bg-red-900/40 text-red-300"
              : "bg-emerald-900/40 text-emerald-300"
          }`}
        >
          {msg.text}
        </div>
      )}

      {/* Unresolved clusters */}
      {unresolvedClusters.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-medium text-amber-400">
            Unresolved (
            {unresolvedClusters.reduce((s, c) => s + c.faces.length, 0)} faces)
          </h2>
          <div className="space-y-4">
            {unresolvedClusters.map((cluster) => (
              <ClusterCard
                key={cluster.key}
                cluster={cluster}
                selected={selected.get(cluster.key) ?? new Set()}
                knownCharacters={knownCharacters}
                pending={pending}
                onToggleFace={(id) => toggleFace(cluster.key, id)}
                onSelectAll={() => selectAllInCluster(cluster)}
                onClearSelection={() => clearSelection(cluster.key)}
                onConfirm={() => handleConfirm(cluster)}
                onReject={() => handleReject(cluster.key)}
                onAssign={(targetId) => handleAssign(cluster.key, targetId)}
                onRename={(newId) => handleRename(cluster, newId)}
                variant="unresolved"
              />
            ))}
          </div>
        </section>
      )}

      {/* Resolved clusters */}
      {resolvedClusters.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-medium text-neutral-300">
            Resolved ({resolvedClusters.reduce((s, c) => s + c.faces.length, 0)}{" "}
            faces)
          </h2>
          <div className="space-y-4">
            {resolvedClusters.map((cluster) => (
              <ClusterCard
                key={cluster.key}
                cluster={cluster}
                selected={selected.get(cluster.key) ?? new Set()}
                knownCharacters={knownCharacters}
                pending={pending}
                onToggleFace={(id) => toggleFace(cluster.key, id)}
                onSelectAll={() => selectAllInCluster(cluster)}
                onClearSelection={() => clearSelection(cluster.key)}
                onConfirm={() => handleConfirm(cluster)}
                onReject={() => handleReject(cluster.key)}
                onAssign={(targetId) => handleAssign(cluster.key, targetId)}
                onRename={(newId) => handleRename(cluster, newId)}
                variant="resolved"
              />
            ))}
          </div>
        </section>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-neutral-800 pt-6">
        <Link
          href={`/admin/${bookId}/${issueId}/review/pipeline`}
          className="text-sm text-cyan-400 hover:text-cyan-300"
        >
          &larr; Back to pipeline review
        </Link>
        <ApproveClusterButton
          bookId={bookId}
          issueId={issueId}
          disabled={!stats.allHandled}
        />
      </div>
    </div>
  );
}

/* ── Cluster Card ────────────────────────────────────────────── */

interface ClusterCardProps {
  cluster: CharacterCluster;
  selected: Set<string>;
  knownCharacters: { id: string; name: string }[];
  pending: boolean;
  onToggleFace: (detectionId: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onConfirm: () => void;
  onReject: () => void;
  onAssign: (targetCharacterId: string) => void;
  onRename: (newCharacterId: string) => void;
  variant: "resolved" | "unresolved";
}

function ClusterCard({
  cluster,
  selected,
  knownCharacters,
  pending,
  onToggleFace,
  onSelectAll,
  onClearSelection,
  onConfirm,
  onReject,
  onAssign,
  onRename,
  variant,
}: ClusterCardProps) {
  const [showAssign, setShowAssign] = useState(false);
  const [search, setSearch] = useState("");
  const [customId, setCustomId] = useState("");

  const avgConfidence =
    cluster.faces.reduce((s, f) => s + f.confidence, 0) / cluster.faces.length;
  const allConfirmed = cluster.faces.every((f) => f.humanVerified);
  const selectedCount = selected.size;

  const borderColor =
    variant === "unresolved" ? "border-amber-700/50" : "border-neutral-800";

  const filteredChars = knownCharacters
    .filter(
      (c) =>
        c.id !== cluster.characterId &&
        (c.id.includes(search.toLowerCase()) ||
          c.name.toLowerCase().includes(search.toLowerCase())),
    )
    .slice(0, 30);

  return (
    <div className={`rounded-lg border ${borderColor} bg-neutral-900 p-4`}>
      {/* Header */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-base font-medium">
          {cluster.label}
          {variant === "unresolved" && (
            <span className="ml-2 text-xs text-amber-500">(suggested)</span>
          )}
        </h3>
        <span className="text-xs text-neutral-500">
          {cluster.faces.length} face{cluster.faces.length !== 1 && "s"}
        </span>
        <ConfidenceBadge value={avgConfidence} label="avg" />
        {allConfirmed && (
          <span className="rounded bg-emerald-700/30 px-2 py-0.5 text-xs text-emerald-300">
            confirmed
          </span>
        )}
      </div>

      {/* Face grid */}
      <div className="mb-3 flex flex-wrap gap-2">
        {cluster.faces.map((face) => (
          <FaceThumbnail
            key={face.detectionId}
            face={face}
            isSelected={selected.has(face.detectionId)}
            onClick={() => onToggleFace(face.detectionId)}
          />
        ))}
      </div>

      {/* Selection controls */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <button
          onClick={onSelectAll}
          className="text-neutral-400 underline hover:text-neutral-200"
        >
          Select all
        </button>
        {selectedCount > 0 && (
          <button
            onClick={onClearSelection}
            className="text-neutral-400 underline hover:text-neutral-200"
          >
            Clear ({selectedCount})
          </button>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        {variant === "resolved" && !allConfirmed && (
          <button
            onClick={onConfirm}
            disabled={pending}
            className="rounded bg-emerald-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Confirm All
          </button>
        )}

        <button
          onClick={() => setShowAssign(!showAssign)}
          disabled={pending}
          className="rounded bg-cyan-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
        >
          {variant === "unresolved"
            ? "Assign to Character"
            : selectedCount > 0
              ? `Move Selected (${selectedCount})`
              : "Rename / Merge"}
        </button>

        {selectedCount > 0 && (
          <button
            onClick={onReject}
            disabled={pending}
            className="rounded border border-red-800 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-900/30 disabled:opacity-50"
          >
            Reject Selected ({selectedCount})
          </button>
        )}
      </div>

      {/* Assign/Rename dropdown */}
      {showAssign && (
        <div className="mt-3 rounded border border-neutral-700 bg-neutral-800 p-3">
          <input
            type="text"
            placeholder="Search characters..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="mb-2 w-full rounded border border-neutral-600 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-cyan-600 focus:outline-none"
          />

          <div className="mb-2 max-h-40 overflow-y-auto">
            {filteredChars.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  onAssign(c.id);
                  setShowAssign(false);
                  setSearch("");
                }}
                disabled={pending}
                className="block w-full rounded px-2 py-1 text-left text-sm text-neutral-300 hover:bg-neutral-700 disabled:opacity-50"
              >
                {c.name}{" "}
                <span className="text-xs text-neutral-500">({c.id})</span>
              </button>
            ))}
            {filteredChars.length === 0 && search && (
              <p className="px-2 py-1 text-xs text-neutral-500">No matches</p>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-neutral-700 pt-2">
            <input
              type="text"
              placeholder="Or type new character ID..."
              value={customId}
              onChange={(e) => setCustomId(e.target.value)}
              className="flex-1 rounded border border-neutral-600 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-cyan-600 focus:outline-none"
            />
            <button
              onClick={() => {
                const id = customId.trim().toLowerCase().replace(/\s+/g, "-");
                if (!id) return;
                if (cluster.characterId) {
                  onRename(id);
                } else {
                  onAssign(id);
                }
                setShowAssign(false);
                setCustomId("");
              }}
              disabled={pending || !customId.trim()}
              className="rounded bg-cyan-800 px-3 py-1 text-xs font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
            >
              Apply
            </button>
            <button
              onClick={() => {
                setShowAssign(false);
                setSearch("");
                setCustomId("");
              }}
              className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Face Thumbnail ──────────────────────────────────────────── */

function FaceThumbnail({
  face,
  isSelected,
  onClick,
}: {
  face: ClusterFace;
  isSelected: boolean;
  onClick: () => void;
}) {
  const borderClass = isSelected
    ? "ring-2 ring-cyan-500"
    : face.humanVerified
      ? "ring-1 ring-emerald-600"
      : "ring-1 ring-neutral-700";

  return (
    <button
      onClick={onClick}
      className={`relative h-[72px] w-[72px] flex-shrink-0 overflow-hidden rounded ${borderClass} transition-all hover:ring-2 hover:ring-cyan-400`}
      title={`Page ${face.pageNumber} | Confidence: ${(face.confidence * 100).toFixed(0)}%`}
    >
      {face.cropUrl ? (
        <img
          src={face.cropUrl}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-neutral-800 text-neutral-600">
          <svg
            className="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0"
            />
          </svg>
        </div>
      )}
      <ConfidenceBadge
        value={face.confidence}
        className="absolute right-0.5 bottom-0.5"
      />
      {face.humanVerified && (
        <span className="absolute top-0.5 left-0.5 text-xs text-emerald-400">
          &#10003;
        </span>
      )}
      <span className="absolute bottom-0.5 left-0.5 text-[9px] text-neutral-400">
        p{face.pageNumber}
      </span>
    </button>
  );
}

/* ── Confidence Badge ────────────────────────────────────────── */

function ConfidenceBadge({
  value,
  label,
  className = "",
}: {
  value: number;
  label?: string;
  className?: string;
}) {
  const color =
    value >= 0.9
      ? "bg-emerald-700/80 text-emerald-200"
      : value >= 0.7
        ? "bg-yellow-700/80 text-yellow-200"
        : "bg-red-700/80 text-red-200";

  return (
    <span
      className={`rounded px-1 py-0.5 text-[10px] font-medium ${color} ${className}`}
    >
      {label ? `${label} ` : ""}
      {(value * 100).toFixed(0)}%
    </span>
  );
}
