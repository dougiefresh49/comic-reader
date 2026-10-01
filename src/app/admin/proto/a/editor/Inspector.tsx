// THROWAWAY prototype for issue #325 (review-flow spike, variant A). Never merges.
// Right drawer: the selected bubble's or panel's fields, or the page's approve bar when nothing is selected.
"use client";

import type { RefObject } from "react";
import { resolveSpeaker, slug, tintFor, titleCase } from "../lib";
import { PageCrop } from "../PageCrop";
import type {
  BubbleType,
  CastMember,
  ProtoData,
  Rect,
  SrcPage,
} from "../types";
import {
  panelOf,
  SPOKEN,
  visibleBubbles,
  type BubbleDoc,
  type Doc,
  type Flag,
  type IssueFlag,
  type PanelDoc,
  type Sel,
  type VoiceChoice,
} from "./model";
import { Portrait, SpeakerPicker } from "./SpeakerPicker";
import type { Proposal } from "./store";

export interface Analysis {
  phase: "still" | "running" | "ready";
  attempt: number;
  proposal: Proposal | null;
}

export interface Actions {
  select: (sel: Sel | null) => void;
  patch: (
    id: string,
    patch: Partial<BubbleDoc>,
    label: string,
    coalesce?: string,
  ) => void;
  setSpeaker: (id: string, castId: string) => void;
  addCast: (
    name: string,
    voice: VoiceChoice,
    bubbleId: string,
    raw: string | null,
  ) => void;
  openPicker: (addName?: string) => void;
  closePicker: () => void;
  dismiss: (ids: string[]) => void;
  keep: (id: string) => void;
  moveToPanel: (id: string, panelId: string | null) => void;
  shift: (sel: Sel, dir: -1 | 1) => void;
  setRect: (sel: Sel, rect: Rect, coalesce?: string) => void;
  analyze: (id: string) => void;
  accept: (id: string) => void;
  retry: (id: string) => void;
  zoomTo: (rect: Rect) => void;
  goto: (page: number, sel: Sel | null) => void;
  approvePage: () => void;
  unapprovePage: () => void;
  approveIssue: () => void;
}

interface InspectorProps {
  data: ProtoData;
  doc: Doc;
  page: SrcPage;
  sel: Sel | null;
  panels: PanelDoc[];
  flags: Map<string, Flag[]>;
  allFlags: IssueFlag[];
  numbers: Map<string, number>;
  cast: CastMember[];
  castById: Map<string, CastMember>;
  pagesByNumber: Map<number, SrcPage>;
  analysis: Record<string, Analysis>;
  picker: { open: boolean; addName: string | null };
  emotions: string[];
  textRef: RefObject<HTMLTextAreaElement | null>;
  emotionRef: RefObject<HTMLInputElement | null>;
  actions: Actions;
}

const TYPES: { id: BubbleType; label: string }[] = [
  { id: "SPEECH", label: "Speech" },
  { id: "NARRATION", label: "Narration" },
  { id: "CAPTION", label: "Caption" },
  { id: "SFX", label: "SFX" },
  { id: "BACKGROUND", label: "Background" },
];

const INPUT =
  "w-full rounded-sm border border-neutral-800 bg-neutral-950 px-2 text-[12px] text-neutral-100 outline-none focus:border-neutral-400";
const BUTTON =
  "h-6 shrink-0 rounded-sm border border-neutral-700 px-2 text-[12px] whitespace-nowrap text-neutral-200 hover:border-neutral-500 hover:bg-neutral-800 disabled:border-neutral-800 disabled:text-neutral-600 disabled:hover:bg-transparent";
const PRIMARY =
  "h-7 rounded-sm bg-neutral-100 px-3 text-[12px] font-medium text-neutral-950 hover:bg-white";

export function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-sm border border-neutral-700 bg-neutral-900 px-1 font-sans text-[10px] leading-4 text-neutral-400">
      {children}
    </kbd>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 flex items-center gap-1.5 text-[11px] text-neutral-500">
      {children}
    </div>
  );
}

function BoxFields({
  rect,
  onChange,
}: {
  rect: Rect;
  onChange: (rect: Rect) => void;
}) {
  const fields: { key: keyof Rect; label: string }[] = [
    { key: "x", label: "X" },
    { key: "y", label: "Y" },
    { key: "w", label: "W" },
    { key: "h", label: "H" },
  ];
  return (
    <div>
      <Label>Box, percent of page</Label>
      <div className="grid grid-cols-4 gap-1">
        {fields.map((f) => (
          <label key={f.key} className="relative block">
            <span className="pointer-events-none absolute top-1.5 left-1.5 text-[10px] text-neutral-600">
              {f.label}
            </span>
            <input
              type="number"
              step={0.1}
              min={0}
              max={100}
              value={Number((rect[f.key] * 100).toFixed(1))}
              onChange={(e) => {
                const n = parseFloat(e.target.value);
                if (Number.isFinite(n)) onChange({ ...rect, [f.key]: n / 100 });
              }}
              className={`${INPUT} h-7 pr-1 pl-5 tabular-nums`}
            />
          </label>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-neutral-600">
        Drag the box or its handles. Shift+arrows move it, Alt+Shift+arrows
        resize it.
      </p>
    </div>
  );
}

function flagLine(flag: Flag): string {
  if (flag.kind === "duplicate") return "possible duplicate";
  if (flag.kind === "no-speaker") return "no speaker";
  if (flag.kind === "unknown-speaker") return `"${flag.raw}" not in cast`;
  return "new, not accepted";
}

// ------------------------------------------------------------------ bubble

function BubbleInspector(
  props: InspectorProps & { bubble: BubbleDoc; panel: PanelDoc | null },
) {
  const {
    bubble: b,
    panel,
    data,
    doc,
    page,
    panels,
    flags,
    numbers,
    cast,
    castById,
    pagesByNumber,
    analysis,
    picker,
    emotions,
    textRef,
    emotionRef,
    actions,
  } = props;
  const f = flags.get(b.id) ?? [];
  const member = b.speakerId ? castById.get(b.speakerId) : undefined;
  const run = analysis[b.id];
  const siblings = visibleBubbles(
    doc,
    panel ? panel.bubbleIds : (doc.pages[b.page]?.looseIds ?? []),
  );
  const position = siblings.findIndex((s) => s.id === b.id) + 1;
  const panelNumber = panel ? panels.indexOf(panel) + 1 : 0;
  const spoken = SPOKEN.includes(b.type);

  // Faces in this bubble's panel, nearest first: the likeliest speakers.
  const cx = b.rect.x + b.rect.w / 2;
  const cy = b.rect.y + b.rect.h / 2;
  const nearby = Array.from(
    new Set(
      data.faces
        .filter((face) => panel && face.panelId === panel.id)
        .map((face) => ({
          id: face.characterId,
          d: Math.hypot(
            face.rect.x + face.rect.w / 2 - cx,
            face.rect.y + face.rect.h / 2 - cy,
          ),
        }))
        .sort((a, z) => a.d - z.d)
        .flatMap((face) => face.id ?? []),
    ),
  );

  const duplicate = f.find((x) => x.kind === "duplicate");
  const unknown = f.find((x) => x.kind === "unknown-speaker");
  const candidates = unknown
    ? unknown.raw
        .split(/,|&|\/|\band\b/i)
        .map((part) => part.trim())
        .filter(Boolean)
    : [];
  const sameRaw = unknown
    ? Object.values(doc.bubbles).filter(
        (o) =>
          !o.speakerId &&
          o.rawSpeaker &&
          slug(o.rawSpeaker) === slug(unknown.raw),
      ).length
    : 0;
  const boxAspect = Math.min(
    3.2,
    Math.max(1.3, (b.rect.w * page.width) / (b.rect.h * page.height)),
  );

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[13px] font-medium text-neutral-100">
          Bubble {numbers.get(b.id)}
        </h2>
        <span className="text-neutral-500">
          {panel
            ? `Panel ${panelNumber}, ${position} of ${siblings.length}`
            : "outside every panel"}
        </span>
      </div>

      <PageCrop
        url={page.imageUrl}
        rect={b.rect}
        pageAspect={page.width / page.height}
        boxAspect={boxAspect}
        mode="contain"
        pad={0.06}
        alt="The selected bubble on the page"
        className="w-full rounded-sm border border-neutral-800 bg-neutral-950"
      />

      {duplicate && (
        <div className="space-y-2 rounded-sm border border-amber-400/40 bg-amber-400/10 p-2">
          <p className="text-amber-200">
            Possible duplicate: this box covers{" "}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-white"
              onClick={() =>
                actions.select({ kind: "bubble", id: duplicate.ofId })
              }
            >
              bubble {numbers.get(duplicate.ofId)}
            </button>
            .
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className={BUTTON}
              onClick={() => actions.dismiss([b.id])}
            >
              Dismiss this one <Key>D</Key>
            </button>
            <button
              type="button"
              className={BUTTON}
              onClick={() => actions.keep(b.id)}
            >
              Keep both <Key>Y</Key>
            </button>
          </div>
        </div>
      )}

      {b.pending && (
        <div className="space-y-2 rounded-sm border border-neutral-700 bg-neutral-900 p-2">
          {(!run || run.phase === "still") && (
            <p className="text-neutral-300">
              New bubble. Analyze starts once the box has been still for a
              second.
            </p>
          )}
          {run?.phase === "running" && (
            <p className="text-neutral-300">Analyzing (simulated)...</p>
          )}
          {run?.phase === "ready" && run.proposal && (
            <>
              <div className="text-[11px] text-neutral-500">
                Simulated result. No model was called.
              </div>
              <dl className="grid grid-cols-[56px_1fr] gap-x-2 gap-y-1">
                <dt className="text-neutral-500">Text</dt>
                <dd className="text-neutral-100">{run.proposal.text}</dd>
                <dt className="text-neutral-500">Speaker</dt>
                <dd className="text-neutral-100">
                  {(run.proposal.speakerId
                    ? castById.get(run.proposal.speakerId)?.name
                    : null) ?? "none found"}
                </dd>
                <dt className="text-neutral-500">Emotion</dt>
                <dd className="text-neutral-100">{run.proposal.emotion}</dd>
              </dl>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  className={PRIMARY}
                  onClick={() => actions.accept(b.id)}
                >
                  Accept <Key>Enter</Key>
                </button>
                <button
                  type="button"
                  className={BUTTON + " h-7"}
                  onClick={() => actions.retry(b.id)}
                >
                  Try again <Key>R</Key>
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div>
        <Label>
          Text <Key>E</Key>
        </Label>
        <textarea
          ref={textRef}
          value={b.text}
          rows={Math.min(8, Math.max(3, b.text.split("\n").length))}
          onChange={(e) =>
            actions.patch(
              b.id,
              { text: e.target.value },
              "text edit",
              `text:${b.id}`,
            )
          }
          className={`${INPUT} resize-y py-1.5 leading-snug`}
        />
      </div>

      <div>
        <Label>
          Speaker <Key>S</Key>
        </Label>
        {picker.open ? (
          <SpeakerPicker
            cast={cast}
            nearby={nearby}
            current={b.speakerId}
            pages={pagesByNumber}
            voices={data.voices}
            slotsUsed={data.slotsUsed}
            slotsTotal={data.slotsTotal}
            newVoices={
              doc.addedCast.filter((c) => c.voice.kind === "new").length
            }
            addName={picker.addName}
            onPick={(id) => actions.setSpeaker(b.id, id)}
            onAdd={(name, voice) =>
              actions.addCast(name, voice, b.id, b.rawSpeaker)
            }
            onClose={actions.closePicker}
          />
        ) : (
          <button
            type="button"
            onClick={() => actions.openPicker()}
            className={`flex h-8 w-full items-center gap-2 rounded-sm border px-2 text-left ${
              spoken && !b.silent && !b.ignored && !member && !b.pending
                ? "border-amber-400/60 bg-amber-400/10"
                : "border-neutral-800 bg-neutral-950 hover:border-neutral-600"
            }`}
          >
            {member ? (
              <>
                <Portrait
                  member={member}
                  pages={pagesByNumber}
                  className="size-5 shrink-0 rounded-sm"
                />
                <span className={`flex-1 truncate ${tintFor(member).text}`}>
                  {member.name}
                </span>
                <span className="truncate text-[11px] text-neutral-500">
                  {member.voice ? `voice: ${member.voice}` : "no voice yet"}
                </span>
              </>
            ) : (
              <span
                className={`flex-1 ${spoken ? "text-amber-200" : "text-neutral-500"}`}
              >
                {unknown
                  ? `"${unknown.raw}" is not in the cast`
                  : spoken
                    ? "No speaker"
                    : "None needed"}
              </span>
            )}
          </button>
        )}
        {unknown && !picker.open && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {candidates.map((name) => {
              const id = resolveSpeaker(name, cast);
              const known = id ? castById.get(id) : undefined;
              return known ? (
                <button
                  key={name}
                  type="button"
                  className={BUTTON}
                  onClick={() => actions.setSpeaker(b.id, known.id)}
                >
                  Use {known.name}
                </button>
              ) : (
                <button
                  key={name}
                  type="button"
                  className={BUTTON}
                  onClick={() => actions.openPicker(titleCase(name))}
                >
                  Add {titleCase(name)} to the cast
                  {candidates.length === 1 && sameRaw > 1
                    ? `, sets ${sameRaw} bubbles`
                    : ""}
                </button>
              );
            })}
          </div>
        )}
        {nearby.length > 0 && !picker.open && !member && spoken && (
          <p className="mt-1.5 text-[11px] text-neutral-500">
            Or click a face name on the page.
          </p>
        )}
      </div>

      <div>
        <Label>
          Emotion <Key>M</Key>
        </Label>
        <input
          ref={emotionRef}
          value={b.emotion}
          onChange={(e) =>
            actions.patch(
              b.id,
              { emotion: e.target.value },
              "emotion edit",
              `emotion:${b.id}`,
            )
          }
          className={`${INPUT} h-7`}
        />
        <div className="mt-1 flex flex-wrap gap-1">
          {emotions.map((emotion) => (
            <button
              key={emotion}
              type="button"
              tabIndex={-1}
              onClick={() => actions.patch(b.id, { emotion }, "emotion change")}
              className={`rounded-sm px-1.5 text-[11px] leading-5 ${
                b.emotion === emotion
                  ? "bg-neutral-200 text-neutral-950"
                  : "bg-neutral-800/70 text-neutral-400 hover:text-neutral-100"
              }`}
            >
              {emotion}
            </button>
          ))}
        </div>
      </div>

      <div>
        <Label>
          Type <Key>1</Key>-<Key>5</Key>
        </Label>
        <div className="flex overflow-hidden rounded-sm border border-neutral-800">
          {TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={b.type === t.id}
              onClick={() => actions.patch(b.id, { type: t.id }, "type change")}
              className={`h-7 flex-auto border-l border-neutral-800 px-1.5 text-[11px] first:border-l-0 ${
                b.type === t.id
                  ? "bg-neutral-200 font-medium text-neutral-950"
                  : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          aria-pressed={b.silent}
          onClick={() =>
            actions.patch(
              b.id,
              { silent: !b.silent },
              b.silent ? "unmark silent" : "mark silent",
            )
          }
          className={`flex h-8 items-center justify-between rounded-sm border px-2 ${
            b.silent
              ? "border-neutral-300 bg-neutral-200 text-neutral-950"
              : "border-neutral-800 text-neutral-300 hover:border-neutral-600"
          }`}
        >
          <span>Silent, no audio</span>
          <Key>X</Key>
        </button>
        <button
          type="button"
          aria-pressed={b.ignored}
          onClick={() =>
            actions.patch(
              b.id,
              { ignored: !b.ignored },
              b.ignored ? "unmark ignored" : "mark ignored",
            )
          }
          className={`flex h-8 items-center justify-between rounded-sm border px-2 ${
            b.ignored
              ? "border-neutral-300 bg-neutral-200 text-neutral-950"
              : "border-neutral-800 text-neutral-300 hover:border-neutral-600"
          }`}
        >
          <span>Ignored, not read</span>
          <Key>I</Key>
        </button>
      </div>

      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <div>
          <Label>Panel</Label>
          <select
            value={panel?.id ?? ""}
            onChange={(e) => actions.moveToPanel(b.id, e.target.value || null)}
            className={`${INPUT} h-7 px-1`}
          >
            {panels.map((p, i) => (
              <option key={p.id} value={p.id}>
                Panel {i + 1}
              </option>
            ))}
            <option value="">Outside every panel</option>
          </select>
        </div>
        <div>
          <Label>
            Order <Key>Alt</Key>+<Key>↑</Key>
            <Key>↓</Key>
          </Label>
          <div className="flex gap-1">
            <button
              type="button"
              className={BUTTON + " h-7"}
              onClick={() => actions.shift({ kind: "bubble", id: b.id }, -1)}
            >
              Earlier
            </button>
            <button
              type="button"
              className={BUTTON + " h-7"}
              onClick={() => actions.shift({ kind: "bubble", id: b.id }, 1)}
            >
              Later
            </button>
          </div>
        </div>
      </div>

      <BoxFields
        rect={b.rect}
        onChange={(rect) =>
          actions.setRect({ kind: "bubble", id: b.id }, rect, `box:${b.id}`)
        }
      />

      {!b.pending && (
        <div className="border-t border-neutral-800 pt-3">
          {run?.phase === "running" && (
            <p className="text-neutral-400">Analyzing (simulated)...</p>
          )}
          {run?.phase === "ready" && run.proposal && (
            <div className="space-y-2">
              <div className="text-[11px] text-neutral-500">
                Simulated result. No model was called.
              </div>
              <p className="text-neutral-200">
                {run.proposal.text}
                <span className="text-neutral-500">
                  {" "}
                  {(run.proposal.speakerId
                    ? castById.get(run.proposal.speakerId)?.name
                    : null) ?? "no speaker"}
                  , {run.proposal.emotion}
                </span>
              </p>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  className={BUTTON}
                  onClick={() => actions.accept(b.id)}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className={BUTTON}
                  onClick={() => actions.retry(b.id)}
                >
                  Try again
                </button>
              </div>
            </div>
          )}
          {!run && (
            <button
              type="button"
              className={BUTTON}
              onClick={() => actions.analyze(b.id)}
            >
              Analyze again (simulated)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- panel

function PanelInspector(props: InspectorProps & { panel: PanelDoc }) {
  const { panel, panels, doc, data, flags, castById, pagesByNumber, actions } =
    props;
  const index = panels.indexOf(panel);
  const rows = visibleBubbles(doc, panel.bubbleIds);
  const flagged = rows.filter((b) => flags.has(b.id)).length;
  const faceIds = Array.from(
    new Set(
      data.faces
        .filter((f) => f.panelId === panel.id)
        .flatMap((f) => f.characterId ?? []),
    ),
  );
  return (
    <div className="space-y-3 p-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[13px] font-medium text-neutral-100">
          Panel {index + 1}
        </h2>
        <span className="text-neutral-500">
          of {panels.length}, {rows.length} bubbles
          {flagged > 0 ? `, ${flagged} need you` : ""}
        </span>
      </div>

      <div>
        <Label>
          Reading order <Key>Alt</Key>+<Key>↑</Key>
          <Key>↓</Key>
        </Label>
        <div className="flex gap-1">
          <button
            type="button"
            className={BUTTON + " h-7"}
            disabled={index === 0}
            onClick={() => actions.shift({ kind: "panel", id: panel.id }, -1)}
          >
            Earlier
          </button>
          <button
            type="button"
            className={BUTTON + " h-7"}
            disabled={index === panels.length - 1}
            onClick={() => actions.shift({ kind: "panel", id: panel.id }, 1)}
          >
            Later
          </button>
          <span className="flex-1" />
          <button
            type="button"
            className={BUTTON + " h-7"}
            onClick={() => actions.zoomTo(panel.rect)}
          >
            Zoom to panel <Key>Z</Key>
          </button>
        </div>
      </div>

      <BoxFields
        rect={panel.rect}
        onChange={(rect) =>
          actions.setRect(
            { kind: "panel", id: panel.id },
            rect,
            `box:${panel.id}`,
          )
        }
      />

      <div>
        <Label>Faces found in this panel</Label>
        {faceIds.length === 0 ? (
          <p className="text-neutral-500">None.</p>
        ) : (
          <ul className="space-y-1">
            {faceIds.map((id) => {
              const member = castById.get(id);
              if (!member) return null;
              return (
                <li key={id} className="flex items-center gap-2">
                  <Portrait
                    member={member}
                    pages={pagesByNumber}
                    className="size-5 rounded-sm"
                  />
                  <span className={tintFor(member).text}>{member.name}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div>
        <Label>Bubbles in play order</Label>
        <ol className="space-y-0.5">
          {rows.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => actions.select({ kind: "bubble", id: b.id })}
                className="flex w-full gap-2 rounded-sm px-1 text-left leading-5 hover:bg-neutral-800"
              >
                <span className="w-4 shrink-0 text-right text-neutral-500 tabular-nums">
                  {props.numbers.get(b.id)}
                </span>
                <span className="min-w-0 flex-1 truncate text-neutral-300">
                  {b.text.replace(/\s+/g, " ") || "(no text)"}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- page

function PageInspector(props: InspectorProps) {
  const { data, doc, page, flags, allFlags, numbers, castById, actions } =
    props;
  const pageDoc = doc.pages[page.number];
  const pageFlagged = allFlags.filter((f) => f.page === page.number);
  const duplicates = pageFlagged.filter((f) =>
    f.flags.some((x) => x.kind === "duplicate"),
  );
  const speakerless = pageFlagged.filter((f) =>
    f.flags.some((x) => x.kind !== "duplicate"),
  );
  const blocked = pageFlagged.length > 0;
  const approved = (pageDoc?.approved ?? false) && !blocked;

  const numbersOfPages = data.pages.map((p) => p.number);
  const approvedPages = numbersOfPages.filter(
    (n) => doc.pages[n]?.approved && !allFlags.some((f) => f.page === n),
  );
  const unapproved = numbersOfPages.filter((n) => !approvedPages.includes(n));
  const firstFlag = allFlags[0];
  const newVoices = [
    ...doc.addedCast.filter((c) => c.voice.kind === "new").map((c) => c.name),
  ];
  const noVoice = Array.from(
    new Set(
      Object.values(doc.bubbles)
        .filter((b) => !b.dismissed && !b.ignored && !b.silent && b.speakerId)
        .flatMap((b) => {
          const m = b.speakerId ? castById.get(b.speakerId) : undefined;
          return m && !m.voice && !newVoices.includes(m.name) ? [m.name] : [];
        }),
    ),
  );

  return (
    <div className="space-y-4 p-3">
      <section className="space-y-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[13px] font-medium text-neutral-100">
            Page {page.number}
          </h2>
          <span className="text-neutral-500">of {data.pages.length}</span>
          <span className="flex-1" />
          {approved && (
            <span className="rounded-sm bg-emerald-400/15 px-1.5 text-[11px] leading-5 text-emerald-300">
              approved
            </span>
          )}
        </div>

        {blocked ? (
          <div className="space-y-2 rounded-sm border border-amber-400/40 bg-amber-400/10 p-2">
            <p className="text-amber-200">
              Approval is blocked:{" "}
              {[
                speakerless.length > 0
                  ? `${speakerless.length} ${
                      speakerless.length === 1 ? "bubble has" : "bubbles have"
                    } no speaker from the cast`
                  : null,
                duplicates.length > 0
                  ? `${duplicates.length} possible ${
                      duplicates.length === 1 ? "duplicate" : "duplicates"
                    } undecided`
                  : null,
              ]
                .filter(Boolean)
                .join(", ")}
              .
            </p>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                className={PRIMARY}
                onClick={() => {
                  const first = pageFlagged[0];
                  if (first)
                    actions.select({ kind: "bubble", id: first.bubbleId });
                }}
              >
                Go to the first <Key>N</Key>
              </button>
              {duplicates.length > 1 && (
                <button
                  type="button"
                  className={BUTTON + " h-7"}
                  onClick={() =>
                    actions.dismiss(duplicates.map((d) => d.bubbleId))
                  }
                >
                  Dismiss all {duplicates.length} duplicates
                </button>
              )}
            </div>
          </div>
        ) : approved ? (
          <div className="flex items-center gap-2">
            <span className="text-neutral-400">
              Every spoken bubble has a speaker.
            </span>
            <span className="flex-1" />
            <button
              type="button"
              className={BUTTON}
              onClick={actions.unapprovePage}
            >
              Undo approval
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-neutral-400">
              Every spoken bubble has a speaker. Nothing is flagged.
            </p>
            <button
              type="button"
              className={PRIMARY}
              onClick={actions.approvePage}
            >
              Approve page <Key>A</Key>
            </button>
          </div>
        )}

        {pageFlagged.length > 0 && (
          <ol className="space-y-0.5">
            {pageFlagged.map((f) => {
              const b = doc.bubbles[f.bubbleId];
              if (!b) return null;
              return (
                <li key={f.bubbleId}>
                  <button
                    type="button"
                    onClick={() =>
                      actions.select({ kind: "bubble", id: f.bubbleId })
                    }
                    className="flex w-full items-baseline gap-2 rounded-sm px-1 text-left leading-5 hover:bg-neutral-800"
                  >
                    <span className="w-4 shrink-0 text-right text-neutral-500 tabular-nums">
                      {numbers.get(f.bubbleId)}
                    </span>
                    <span className="shrink-0 text-amber-300">
                      {f.flags.map(flagLine).join(", ")}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-neutral-500">
                      {b.text.replace(/\s+/g, " ")}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        <p className="text-[11px] text-neutral-600">
          {numbers.size} bubbles, {flags.size} flagged.
        </p>
      </section>

      <section className="space-y-2 border-t border-neutral-800 pt-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[13px] font-medium text-neutral-100">Issue</h2>
          <span className="text-neutral-500">
            {approvedPages.length} of {numbersOfPages.length} pages approved
          </span>
          <span className="flex-1" />
          {doc.issueApproved && (
            <span className="rounded-sm bg-emerald-400/15 px-1.5 text-[11px] leading-5 text-emerald-300">
              approved
            </span>
          )}
        </div>

        {doc.issueApproved ? (
          <p className="text-neutral-300">
            Issue approved. In the real flow the run now makes voices for new
            characters, then audio. Nothing was written here: this is a
            prototype.
          </p>
        ) : allFlags.length > 0 && firstFlag ? (
          <div className="space-y-2">
            <p className="text-amber-200">
              Blocked: {allFlags.length}{" "}
              {allFlags.length === 1 ? "bubble needs" : "bubbles need"} you on{" "}
              {new Set(allFlags.map((f) => f.page)).size === 1
                ? `page ${firstFlag.page}`
                : `${new Set(allFlags.map((f) => f.page)).size} pages`}
              .
            </p>
            <button
              type="button"
              className={BUTTON + " h-7"}
              onClick={() =>
                actions.goto(firstFlag.page, {
                  kind: "bubble",
                  id: firstFlag.bubbleId,
                })
              }
            >
              Go to the first, page {firstFlag.page}
            </button>
          </div>
        ) : unapproved.length > 0 ? (
          <div className="space-y-2">
            <p className="text-neutral-400">
              {unapproved.length === 1
                ? `Page ${unapproved[0]} is not approved yet.`
                : `${unapproved.length} pages are not approved yet.`}
            </p>
            {unapproved[0] !== undefined && unapproved[0] !== page.number && (
              <button
                type="button"
                className={BUTTON + " h-7"}
                onClick={() => actions.goto(unapproved[0] ?? 1, null)}
              >
                Go to page {unapproved[0]}
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            className={PRIMARY}
            onClick={actions.approveIssue}
          >
            Approve issue <Key>Shift</Key>+<Key>A</Key>
          </button>
        )}

        <div className="rounded-sm border border-neutral-800 p-2 text-[11px] text-neutral-400">
          <div className="text-neutral-300">
            Voice slots: {data.slotsUsed + newVoices.length} of{" "}
            {data.slotsTotal} after approval
          </div>
          {newVoices.length > 0 ? (
            <div>New voices to make: {newVoices.join(", ")}.</div>
          ) : (
            <div>No new voice is made for this issue.</div>
          )}
          {noVoice.length > 0 && (
            <div className="text-amber-300">
              No voice yet, set it at the characters stop: {noVoice.join(", ")}.
            </div>
          )}
          <div>Audio is made only after the issue is approved.</div>
        </div>
      </section>
    </div>
  );
}

export function Inspector(props: InspectorProps) {
  const { doc, sel } = props;
  if (sel?.kind === "bubble") {
    const bubble = doc.bubbles[sel.id];
    if (bubble)
      return (
        <BubbleInspector
          {...props}
          bubble={bubble}
          panel={panelOf(doc, bubble)}
        />
      );
  }
  if (sel?.kind === "panel") {
    const panel = doc.panels[sel.id];
    if (panel) return <PanelInspector {...props} panel={panel} />;
  }
  return <PageInspector {...props} />;
}
