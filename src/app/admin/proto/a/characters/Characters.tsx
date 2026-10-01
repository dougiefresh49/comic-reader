// THROWAWAY prototype for issue #325 (review-flow spike, variant A). Never merges.
// The characters stop: one card per character, unknown face groups first, a voice on every card.
"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { protoHref, slug, storageKey, writeSession } from "../lib";
import { PageCrop } from "../PageCrop";
import type { Portrait, ProtoData, SrcPage } from "../types";

type VoiceState =
  | { kind: "has"; name: string }
  | { kind: "borrow"; name: string }
  | { kind: "new" }
  | null;

interface Card {
  key: string;
  kind: "character" | "role" | "unknown";
  name: string;
  portraits: Portrait[];
  faceCount: number;
  pages: number[];
  voice: VoiceState;
}

type Filter = "all" | "needs" | "unknown" | "novoice" | "ready";

const BUTTON =
  "h-6 rounded-sm border border-neutral-700 px-2 text-[12px] whitespace-nowrap text-neutral-200 hover:border-neutral-500 hover:bg-neutral-800 disabled:border-neutral-800 disabled:text-neutral-600 disabled:hover:bg-transparent";

function buildCards(data: ProtoData, demo: boolean): Card[] {
  const cards: Card[] = data.cast.map((c) => ({
    key: c.id,
    kind: c.kind,
    name: c.name,
    portraits: c.portrait ? [c.portrait] : [],
    faceCount: c.faceCount,
    pages: c.pages,
    voice: c.voice ? { kind: "has", name: c.voice } : null,
  }));
  // Faces the lookup could not name arrive as one group per suggested cluster.
  const unnamed = data.faces.filter((f) => !f.characterId);
  if (unnamed.length > 0) {
    cards.push({
      key: "unknown-real",
      kind: "unknown",
      name: "",
      portraits: unnamed
        .slice(0, 4)
        .map((f) => ({ page: f.page, rect: f.rect })),
      faceCount: unnamed.length,
      pages: Array.from(new Set(unnamed.map((f) => f.page))),
      voice: null,
    });
  }
  if (!demo) return cards;
  // Demo: the two least-seen characters are shown as unknown face groups.
  const rare = cards
    .filter((c) => c.kind === "character" && c.portraits.length > 0)
    .sort((a, b) => a.faceCount - b.faceCount || a.name.localeCompare(b.name))
    .slice(0, 2);
  return cards.map((c) => {
    if (!rare.includes(c)) return c;
    return {
      ...c,
      key: `unknown-${c.key}`,
      kind: "unknown",
      name: "",
      voice: null,
      portraits: data.faces
        .filter((f) => f.characterId === c.key)
        .slice(0, 4)
        .map((f) => ({ page: f.page, rect: f.rect })),
    };
  });
}

function rank(card: Card): number {
  if (card.kind === "unknown") return 0;
  if (!card.voice) return 1;
  return card.kind === "role" ? 3 : 2;
}

function Face({
  portrait,
  pages,
  className,
  label,
}: {
  portrait: Portrait | undefined;
  pages: Map<number, SrcPage>;
  className: string;
  label: string;
}) {
  const page = portrait ? pages.get(portrait.page) : undefined;
  if (!portrait || !page) {
    return (
      <div
        className={`flex aspect-square items-center justify-center bg-neutral-800 text-[18px] text-neutral-500 ${className}`}
      >
        {label.charAt(0) || "?"}
      </div>
    );
  }
  return (
    <PageCrop
      url={page.imageUrl}
      rect={portrait.rect}
      pageAspect={page.width / page.height}
      boxAspect={1}
      mode="cover"
      pad={0.04}
      alt={label ? `${label}, from page ${portrait.page}` : "Unnamed face"}
      className={`bg-neutral-800 ${className}`}
    />
  );
}

function NameField({
  options,
  onName,
}: {
  options: string[];
  onName: (name: string) => void;
}) {
  const [value, setValue] = useState("");
  const [active, setActive] = useState(0);
  const q = slug(value);
  const matches = q
    ? options.filter((o) => slug(o).includes(q)).slice(0, 4)
    : [];
  const exact = matches.some((m) => slug(m) === q);
  const rows = [
    ...matches.map((m) => ({ label: `Merge into ${m}`, name: m })),
    ...(q && !exact
      ? [{ label: `New character "${value.trim()}"`, name: value.trim() }]
      : []),
  ];
  const index = Math.min(active, Math.max(0, rows.length - 1));
  return (
    <div className="relative">
      <input
        value={value}
        placeholder="Who is this?"
        aria-label="Name this character"
        onChange={(e) => {
          setValue(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((index + 1) % Math.max(1, rows.length));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((index - 1 + rows.length) % Math.max(1, rows.length));
          } else if (e.key === "Enter") {
            const row = rows[index];
            if (row) onName(row.name);
          } else if (e.key === "Escape") {
            setValue("");
          }
        }}
        className="h-7 w-full rounded-sm border border-amber-400/50 bg-neutral-950 px-2 text-[12px] text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-amber-300"
      />
      {rows.length > 0 && (
        <div className="absolute top-full right-0 left-0 z-10 mt-px rounded-sm border border-neutral-700 bg-neutral-900 py-0.5">
          {rows.map((row, i) => (
            <button
              key={row.label}
              type="button"
              tabIndex={-1}
              onMouseEnter={() => setActive(i)}
              onClick={() => onName(row.name)}
              className={`block h-6 w-full truncate px-2 text-left text-[12px] ${
                i === index
                  ? "bg-neutral-700/70 text-white"
                  : "text-neutral-300"
              }`}
            >
              {row.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Characters({ data }: { data: ProtoData }) {
  const hasRealUnknown = data.faces.some((f) => !f.characterId);
  const [demo, setDemo] = useState(!hasRealUnknown);
  const [cards, setCards] = useState<Card[]>(() => buildCards(data, demo));
  const [past, setPast] = useState<Card[][]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [borrowing, setBorrowing] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const pages = useMemo(
    () => new Map<number, SrcPage>(data.pages.map((p) => [p.number, p])),
    [data.pages],
  );

  useEffect(() => {
    writeSession(storageKey("chars", data.bookId, data.issueId), {
      confirmed,
    });
  }, [confirmed, data.bookId, data.issueId]);

  const change = (next: Card[], message?: string) => {
    setPast((prev) => [...prev, cards].slice(-30));
    setCards(next);
    setConfirmed(false);
    setNote(message ?? null);
  };

  const undo = () => {
    const last = past[past.length - 1];
    if (!last) return;
    setCards(last);
    setPast(past.slice(0, -1));
    setNote("Undid the last change.");
  };

  const newCount = cards.filter((c) => c.voice?.kind === "new").length;
  const slotsLeft = data.slotsTotal - data.slotsUsed - newCount;
  const unknown = cards.filter((c) => c.kind === "unknown");
  const noVoice = cards.filter((c) => c.kind !== "unknown" && !c.voice);
  const ready = cards.filter((c) => c.kind !== "unknown" && c.voice);
  const names = cards
    .filter((c) => c.kind === "character")
    .map((c) => c.name)
    .sort();

  const nameCard = (card: Card, name: string) => {
    const target = cards.find(
      (c) => c.kind === "character" && slug(c.name) === slug(name),
    );
    if (target) {
      change(
        cards
          .filter((c) => c.key !== card.key)
          .map((c) =>
            c.key === target.key
              ? {
                  ...c,
                  faceCount: c.faceCount + card.faceCount,
                  pages: Array.from(new Set([...c.pages, ...card.pages])).sort(
                    (a, b) => a - b,
                  ),
                }
              : c,
          ),
        `Merged ${card.faceCount} ${card.faceCount === 1 ? "face" : "faces"} into ${target.name}.`,
      );
      return;
    }
    const voice = data.voices.find((v) => slug(v.name) === slug(name));
    change(
      cards.map((c) =>
        c.key === card.key
          ? {
              ...c,
              key: slug(name) || c.key,
              kind: "character",
              name,
              voice: voice ? { kind: "has", name: voice.name } : null,
            }
          : c,
      ),
      voice
        ? `${name} joins the cast and already has a voice.`
        : `${name} joins the cast. It needs a voice.`,
    );
  };

  const setVoice = (card: Card, voice: VoiceState) => {
    setBorrowing(null);
    change(cards.map((c) => (c.key === card.key ? { ...c, voice } : c)));
  };

  const shown = cards
    .filter((c) => {
      if (filter === "needs") return c.kind === "unknown" || !c.voice;
      if (filter === "unknown") return c.kind === "unknown";
      if (filter === "novoice") return c.kind !== "unknown" && !c.voice;
      if (filter === "ready") return c.kind !== "unknown" && !!c.voice;
      return true;
    })
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  const blocked = unknown.length + noVoice.length;
  const chips: [Filter, string, number][] = [
    ["all", "All", cards.length],
    ["needs", "Needs you", blocked],
    ["unknown", "Unknown faces", unknown.length],
    ["novoice", "No voice", noVoice.length],
    ["ready", "Ready", ready.length],
  ];

  const confirm = () => {
    if (blocked > 0) {
      setFilter("all");
      setNote(null);
      window.requestAnimationFrame(() => {
        const first = gridRef.current?.querySelector<HTMLElement>(
          "[data-needs] input, [data-needs] button",
        );
        first?.focus();
        first?.scrollIntoView({ block: "center" });
      });
      return;
    }
    setConfirmed(true);
    setNote(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col text-[12px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-neutral-800 px-4 py-2.5">
        <h1 className="text-[15px] font-medium text-neutral-50">Characters</h1>
        <span className="text-neutral-500">
          {cards.filter((c) => c.kind === "character").length} characters and{" "}
          {cards.filter((c) => c.kind === "role").length} roles in the cast
          {unknown.length > 0
            ? `, ${unknown.length} face ${unknown.length === 1 ? "group" : "groups"} unnamed`
            : ""}
          {noVoice.length > 0 ? `, ${noVoice.length} without a voice` : ""}
        </span>
        <span className="flex-1" />
        <div className="flex gap-1">
          {chips.map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
              className={`flex h-6 items-center gap-1.5 rounded-sm border px-2 ${
                filter === id
                  ? "border-neutral-200 bg-neutral-200 text-neutral-950"
                  : "border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-neutral-100"
              }`}
            >
              {label}
              <span className="tabular-nums opacity-60">{count}</span>
            </button>
          ))}
        </div>
        <span
          className={`rounded-sm border px-2 leading-6 tabular-nums ${
            slotsLeft <= 0
              ? "border-amber-400/50 text-amber-200"
              : "border-neutral-800 text-neutral-300"
          }`}
        >
          Voice slots {data.slotsUsed + newCount} of {data.slotsTotal}
        </span>
        <button
          type="button"
          className={BUTTON}
          disabled={past.length === 0}
          onClick={undo}
        >
          Undo
        </button>
      </div>

      {(demo || !hasRealUnknown) && (
        <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-1.5 text-[11px] text-neutral-500">
          {demo
            ? "Prototype data: every face in this issue was named by the lookup, so the two least-seen characters are shown as unknown groups to demonstrate naming."
            : "Showing the faces as the lookup named them."}
          <button
            type="button"
            className="text-neutral-300 underline-offset-2 hover:text-white hover:underline"
            onClick={() => {
              setDemo(!demo);
              setCards(buildCards(data, !demo));
              setPast([]);
              setConfirmed(false);
              setNote(null);
            }}
          >
            {demo ? "Show as detected" : "Show the unknown-face demo"}
          </button>
        </div>
      )}

      <div
        ref={gridRef}
        className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(236px,1fr))] content-start gap-2 overflow-y-auto p-4"
      >
        {shown.map((card) => {
          const needs = card.kind === "unknown" || !card.voice;
          return (
            <article
              key={card.key}
              data-needs={needs ? "" : undefined}
              className={`flex flex-col rounded-sm border bg-neutral-900/50 ${
                needs ? "border-amber-400/40" : "border-neutral-800"
              }`}
            >
              <div className="flex gap-2 p-2">
                <Face
                  portrait={card.portraits[0]}
                  pages={pages}
                  label={card.name}
                  className="w-20 shrink-0 rounded-sm"
                />
                <div className="min-w-0 flex-1">
                  {card.kind === "unknown" ? (
                    <div className="text-[13px] font-medium text-amber-200">
                      Unknown
                    </div>
                  ) : (
                    <div className="truncate text-[13px] font-medium text-neutral-100">
                      {card.name}
                    </div>
                  )}
                  <div className="text-[11px] text-neutral-500">
                    {card.kind === "role"
                      ? "role, one voice per book"
                      : `${card.faceCount} ${
                          card.faceCount === 1 ? "face" : "faces"
                        } on ${
                          card.pages.length === 1
                            ? `page ${card.pages[0]}`
                            : `${card.pages.length} pages`
                        }`}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {card.kind === "unknown" ? (
                      <span className="rounded-sm bg-amber-400/15 px-1 text-[10px] leading-4 text-amber-300">
                        needs a name
                      </span>
                    ) : !card.voice ? (
                      <span className="rounded-sm bg-amber-400/15 px-1 text-[10px] leading-4 text-amber-300">
                        needs a voice
                      </span>
                    ) : card.voice.kind === "new" ? (
                      <span className="rounded-sm bg-neutral-800 px-1 text-[10px] leading-4 text-neutral-300">
                        new voice
                      </span>
                    ) : card.voice.kind === "borrow" ? (
                      <span className="rounded-sm bg-neutral-800 px-1 text-[10px] leading-4 text-neutral-300">
                        borrowed voice
                      </span>
                    ) : (
                      <span className="rounded-sm bg-emerald-400/15 px-1 text-[10px] leading-4 text-emerald-300">
                        ready
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {card.kind === "unknown" && card.portraits.length > 1 && (
                <div className="flex gap-1 px-2 pb-2">
                  {card.portraits.slice(1).map((p, i) => (
                    <Face
                      key={i}
                      portrait={p}
                      pages={pages}
                      label=""
                      className="w-9 rounded-sm"
                    />
                  ))}
                </div>
              )}

              <div className="mt-auto space-y-1.5 border-t border-neutral-800 p-2">
                {card.kind === "unknown" ? (
                  <>
                    <NameField
                      options={names}
                      onName={(name) => nameCard(card, name)}
                    />
                    <button
                      type="button"
                      className="text-[11px] text-neutral-500 underline-offset-2 hover:text-neutral-200 hover:underline"
                      onClick={() =>
                        change(
                          cards.filter((c) => c.key !== card.key),
                          "Removed: not a character. Its faces are left out of the cast.",
                        )
                      }
                    >
                      Not a character
                    </button>
                  </>
                ) : borrowing === card.key ? (
                  <div className="flex gap-1">
                    <select
                      autoFocus
                      defaultValue=""
                      aria-label={`Voice for ${card.name}`}
                      onChange={(e) => {
                        if (e.target.value)
                          setVoice(card, {
                            kind: "borrow",
                            name: e.target.value,
                          });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setBorrowing(null);
                      }}
                      className="h-6 min-w-0 flex-1 rounded-sm border border-neutral-700 bg-neutral-950 px-1 text-[12px] text-neutral-100"
                    >
                      <option value="" disabled>
                        Pick a voice
                      </option>
                      {data.voices.map((v) => (
                        <option key={v.id} value={v.name}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={BUTTON}
                      onClick={() => setBorrowing(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : card.voice ? (
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-neutral-300">
                      {card.voice.kind === "new"
                        ? "New voice, made after pages"
                        : `Voice: ${card.voice.name}`}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 text-[11px] text-neutral-500 underline-offset-2 hover:text-neutral-200 hover:underline"
                      onClick={() =>
                        card.voice?.kind === "new"
                          ? setVoice(card, null)
                          : setBorrowing(card.key)
                      }
                    >
                      {card.voice.kind === "new" ? "Undo" : "Change"}
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        className={BUTTON + " flex-1"}
                        onClick={() => setBorrowing(card.key)}
                      >
                        Borrow a voice
                      </button>
                      <button
                        type="button"
                        className={BUTTON + " flex-1"}
                        disabled={slotsLeft <= 0}
                        onClick={() => setVoice(card, { kind: "new" })}
                      >
                        New voice
                      </button>
                    </div>
                    <p
                      className={`text-[11px] ${
                        slotsLeft <= 1 ? "text-amber-300" : "text-neutral-500"
                      }`}
                    >
                      {data.slotsUsed + newCount} of {data.slotsTotal} slots
                      used.{" "}
                      {slotsLeft <= 0
                        ? "No slot left for a new voice."
                        : slotsLeft === 1
                          ? "A new voice takes the last one."
                          : `${slotsLeft} left.`}
                    </p>
                  </>
                )}
              </div>
            </article>
          );
        })}
        {shown.length === 0 && (
          <p className="col-span-full py-8 text-center text-neutral-500">
            Nothing here.
          </p>
        )}
      </div>

      <div className="flex min-h-12 flex-wrap items-center gap-3 border-t border-neutral-800 py-2 pr-4 pl-16">
        {confirmed ? (
          <>
            <span className="text-neutral-200">
              Cast confirmed: {cards.length} names. The pages are read against
              this list. Nothing was written: this is a prototype.
            </span>
            <span className="flex-1" />
            <Link
              href={protoHref("", data.bookId, data.issueId)}
              className={BUTTON + " flex h-7 items-center"}
            >
              Back to the issue
            </Link>
            <Link
              href={protoHref("/editor", data.bookId, data.issueId)}
              className="flex h-7 items-center rounded-sm bg-neutral-100 px-3 font-medium text-neutral-950 hover:bg-white"
            >
              Review pages
            </Link>
          </>
        ) : (
          <>
            <span
              className={blocked > 0 ? "text-amber-200" : "text-neutral-400"}
            >
              {blocked > 0
                ? `Blocked: ${[
                    unknown.length > 0
                      ? `${unknown.length} face ${unknown.length === 1 ? "group needs" : "groups need"} a name`
                      : null,
                    noVoice.length > 0
                      ? `${noVoice.length} ${noVoice.length === 1 ? "character needs" : "characters need"} a voice`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(", ")}.`
                : `Every face has a name and every name has a voice.${
                    newCount > 0
                      ? ` ${newCount} new ${newCount === 1 ? "voice is" : "voices are"} made after the pages are approved.`
                      : ""
                  }`}
            </span>
            {note && <span className="text-neutral-500">{note}</span>}
            <span className="flex-1" />
            <button
              type="button"
              onClick={confirm}
              className={
                blocked > 0
                  ? BUTTON + " h-7"
                  : "h-7 rounded-sm bg-neutral-100 px-3 font-medium text-neutral-950 hover:bg-white"
              }
            >
              {blocked > 0 ? "Go to the first" : "Confirm the cast"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
