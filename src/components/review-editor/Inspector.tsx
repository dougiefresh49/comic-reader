// Right drawer: the selected bubble's or panel's fields, or the page's flags when nothing is selected.
"use client";

import type { RefObject } from "react";
import type { AnalyzeRun } from "./analyze";
import type { ListenJob, ListenNotice } from "./listen";
import {
  needYou,
  plural,
  resolveSpeaker,
  slug,
  tintFor,
  titleCase,
  voiceLabel,
} from "./lib";
import {
  facesIn,
  groupMembers,
  joinNeighbour,
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
import { PageCrop } from "./PageCrop";
import { cuesOf } from "./save";
import { Portrait, SpeakerPicker } from "./SpeakerPicker";
import type {
  BubbleType,
  CastMember,
  EditorData,
  Rect,
  SrcPage,
} from "./types";

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
    knownId: string | null,
    bubbleId: string,
    raw: string | null,
  ) => void;
  openPicker: (addName?: string) => void;
  closePicker: () => void;
  dismiss: (ids: string[]) => void;
  keep: (id: string) => void;
  deleteBubble: (id: string) => void;
  deletePanel: (id: string) => void;
  moveToPanel: (id: string, panelId: string | null) => void;
  shift: (sel: Sel, dir: -1 | 1) => void;
  setRect: (sel: Sel, rect: Rect, coalesce?: string) => void;
  zoomTo: (rect: Rect) => void;
  goto: (page: number, sel: Sel | null) => void;
  /** Analyze again, or Try again: one model call with the bubble's hint. */
  analyze: (id: string) => void;
  /** Turn the bubble's proposal into pending edits. */
  accept: (id: string) => void;
  setHint: (id: string, text: string) => void;
  /** Play the bubble's take, or stop it when it is playing. */
  play: (id: string) => void;
  /** Save first when the bubble has pending edits, then regenerate. */
  regenerate: (id: string, job: ListenJob) => void;
  /** Join with the previous (-1) or next (1) balloon in the panel (#451). */
  joinWith: (id: string, dir: -1 | 1) => void;
  /** Take the balloon out of its joined group. */
  splitFrom: (id: string) => void;
  /** "Not one line": a touching pair stands alone, both balloons. */
  standAlone: (id: string, otherId: string) => void;
}

/**
 * The selected bubble's audio controls. Null hides them: the bubble has no
 * saved row, or is silent or ignored.
 */
export interface ListenView {
  /** The bubble has a take to play. */
  hasAudio: boolean;
  playing: boolean;
  /** The regenerate running on this bubble, or null. */
  running: ListenJob | null;
  notice: ListenNotice | null;
  /** Rows a Save writes before a regenerate; 0 when this bubble has no pending edit. */
  saveFirst: number;
  /** Active balloons in its joined group (#451); under 2 means it renders alone. */
  groupSize: number;
}

/**
 * A Save or a regenerate is in flight, and the editor holds still: why, and
 * the bubble whose text is read-only meanwhile.
 */
export interface Lock {
  reason: string;
  bubbleId: string | null;
}

interface InspectorProps {
  data: EditorData;
  doc: Doc;
  page: SrcPage;
  sel: Sel | null;
  panels: PanelDoc[];
  flags: Map<string, Flag[]>;
  /** Touching-balloon prompts (#451): each bubble's other balloon. */
  touching: Map<string, string>;
  allFlags: IssueFlag[];
  numbers: Map<string, number>;
  cast: CastMember[];
  castById: Map<string, CastMember>;
  pagesByNumber: Map<number, SrcPage>;
  picker: { open: boolean; addName: string | null };
  emotions: string[];
  textRef: RefObject<HTMLTextAreaElement | null>;
  emotionRef: RefObject<HTMLInputElement | null>;
  analysis: Record<string, AnalyzeRun>;
  hints: Record<string, string>;
  listen: ListenView | null;
  lock: Lock | null;
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
  if (flag.kind === "touching") return "touches another speaker";
  return `"${flag.raw}" not in cast`;
}

// ----------------------------------------------------------------- analyze

/**
 * The bubble's analyze: the wait, the call, its error, or the proposal with
 * Accept and Try again; under it the hint and Analyze again.
 */
function AnalyzeBlock({
  bubble: b,
  run,
  hint,
  castById,
  lock,
  actions,
}: {
  bubble: BubbleDoc;
  run: AnalyzeRun | undefined;
  hint: string;
  castById: Map<string, CastMember>;
  lock: Lock | null;
  actions: Actions;
}) {
  const proposal = run?.phase === "ready" ? run.proposal : null;
  const offered = proposal?.speaker ? castById.get(proposal.speaker) : null;
  const running = run?.phase === "running";
  return (
    <div className="space-y-2 rounded-sm border border-neutral-700 bg-neutral-900 p-2">
      {lock && <p className="text-amber-300">{lock.reason}</p>}
      {run?.phase === "waiting" && (
        <p className="text-neutral-300">
          New bubble. Analyze starts once the box has been still for a second.
        </p>
      )}
      {running && <p className="text-neutral-300">Analyzing...</p>}
      {run?.phase === "failed" && (
        <p role="alert" className="text-red-300">
          Analyze failed: {run.error}. Every field below still works by hand.
        </p>
      )}
      {proposal && (
        <>
          <dl className="grid grid-cols-[56px_1fr] gap-x-2 gap-y-1">
            <dt className="text-neutral-500">Text</dt>
            <dd className="whitespace-pre-wrap text-neutral-100">
              {proposal.text || "(no text read)"}
            </dd>
            <dt className="text-neutral-500">Cues</dt>
            <dd className="whitespace-pre-wrap text-neutral-100">
              {proposal.textWithCues ?? "(none)"}
            </dd>
            <dt className="text-neutral-500">Speaker</dt>
            <dd
              className={offered ? tintFor(offered).text : "text-neutral-400"}
            >
              {offered
                ? offered.name
                : b.speakerId
                  ? "none from the cast; Accept keeps the current speaker"
                  : "none from the cast"}
            </dd>
            <dt className="text-neutral-500">Emotion</dt>
            <dd className="text-neutral-100">{proposal.emotion}</dd>
            <dt className="text-neutral-500">Type</dt>
            <dd className="text-neutral-100">
              {TYPES.find((t) => t.id === proposal.type)?.label ??
                proposal.type}
            </dd>
          </dl>
          <div className="flex gap-1.5">
            <button
              type="button"
              className={PRIMARY + " disabled:opacity-40"}
              disabled={!!lock}
              onClick={() => actions.accept(b.id)}
            >
              Accept <Key>Enter</Key>
            </button>
            <button
              type="button"
              className={BUTTON + " h-7"}
              disabled={!!lock}
              title="Uses up to two Gemini calls."
              onClick={() => actions.analyze(b.id)}
            >
              Try again <Key>R</Key>
            </button>
          </div>
        </>
      )}
      <div className="flex gap-1.5">
        <input
          key={b.id}
          value={hint}
          maxLength={500}
          placeholder="Hint: it's the Yellow Ranger, she is angry"
          aria-label="Hint for Analyze again"
          onChange={(e) => actions.setHint(b.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || running || lock) return;
            e.preventDefault();
            // Off the field, so the next Enter accepts what comes back.
            e.currentTarget.blur();
            actions.analyze(b.id);
          }}
          className={`${INPUT} h-6 min-w-0 flex-1`}
        />
        <button
          type="button"
          className={BUTTON}
          disabled={running || !!lock}
          title="Uses up to two Gemini calls."
          onClick={() => actions.analyze(b.id)}
        >
          Analyze again
        </button>
      </div>
      <p className="text-[11px] text-neutral-500">
        Each analyze uses up to two Gemini calls.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ listen

/** A click from a pointer. A key on a focused button clicks with `detail` 0. */
const pointerClick = (e: React.MouseEvent) => e.detail > 0;

/**
 * Play the bubble's take, edit its cues by hand, and regenerate either. A cues
 * edit is saved by Save like any other edit and costs nothing; clearing the
 * field leaves no cues, so the audio reads the text as it is. The cues field
 * is read-only when the Text field is. The two regenerate buttons run on a
 * pointer click only, never a key, and are off while the editor is locked.
 */
function ListenBlock({
  bubble: b,
  view,
  lock,
  readOnly,
  actions,
}: {
  bubble: BubbleDoc;
  view: ListenView;
  lock: Lock | null;
  readOnly: boolean;
  actions: Actions;
}) {
  const { running, notice } = view;
  const cues = cuesOf(b);
  const first = view.saveFirst > 0 ? "Save, then regenerate" : "Regenerate";
  const off = !!lock;
  const grouped = view.groupSize >= 2;
  return (
    <div className="space-y-2 rounded-sm border border-neutral-800 p-2">
      {view.hasAudio ? (
        <button
          type="button"
          aria-pressed={view.playing}
          className={BUTTON + " h-7"}
          onClick={() => actions.play(b.id)}
        >
          {view.playing ? "Stop" : "Play"} <Key>L</Key>
        </button>
      ) : (
        <p className="text-neutral-500">No audio yet.</p>
      )}
      <div>
        <Label>Cues, as the audio step reads them</Label>
        <textarea
          key={b.id}
          value={cues ?? ""}
          readOnly={readOnly}
          placeholder={
            b.cues
              ? "None: the text changed since they were written."
              : "None. The audio reads the text as it is."
          }
          rows={Math.min(8, Math.max(3, (cues ?? "").split("\n").length))}
          onChange={(e) => {
            const value = e.target.value;
            actions.patch(
              b.id,
              { cues: value ? { forText: b.text, value } : null },
              "cues edit",
              `cues:${b.id}`,
            );
          }}
          className={`${INPUT} resize-y py-1.5 leading-snug`}
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          className={BUTTON + " h-7"}
          disabled={off}
          title="Uses a Gemini call."
          onClick={(e) => {
            if (pointerClick(e)) actions.regenerate(b.id, "cues");
          }}
        >
          {running === "cues" ? "Regenerating cues..." : `${first} cues`}
        </button>
        <button
          type="button"
          className={
            BUTTON + " h-auto min-h-7 py-1 text-left whitespace-normal"
          }
          disabled={off}
          title={
            grouped
              ? "Uses ElevenLabs credits. The joined balloons render as one clip in their speaker's voice, and every balloon of the group plays it."
              : "Uses ElevenLabs credits."
          }
          onClick={(e) => {
            if (pointerClick(e)) actions.regenerate(b.id, "audio");
          }}
        >
          {running === "audio"
            ? "Regenerating audio..."
            : grouped
              ? `${first} group audio (${view.groupSize} balloons)`
              : `${first} audio`}
        </button>
      </div>
      <p className="text-[11px] text-neutral-500">
        Regenerating cues uses a Gemini call; audio uses ElevenLabs credits.
        {grouped && (
          <> The group renders as one clip for all {view.groupSize} balloons.</>
        )}
      </p>
      {lock ? (
        <p className="text-amber-300">{lock.reason}</p>
      ) : (
        view.saveFirst > 0 && (
          <p className="text-[11px] text-neutral-500">
            This bubble has unsaved edits, so a regenerate saves{" "}
            {view.saveFirst === 1
              ? "the 1 pending change"
              : `all ${view.saveFirst} pending changes`}{" "}
            first.
          </p>
        )
      )}
      {notice && (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={
            notice.tone === "error" ? "text-red-300" : "text-emerald-300"
          }
        >
          {notice.text}
        </p>
      )}
    </div>
  );
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
    touching,
    numbers,
    cast,
    castById,
    pagesByNumber,
    picker,
    emotions,
    textRef,
    emotionRef,
    analysis,
    hints,
    listen,
    lock,
    actions,
  } = props;
  // A regenerate on this bubble sent its saved text; it stays as sent.
  const textLocked = !!lock && lock.bubbleId === b.id;
  const f = flags.get(b.id) ?? [];
  const member = b.speakerId ? castById.get(b.speakerId) : undefined;
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
      (panel ? facesIn(data.faces, panel) : [])
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

  // Joined balloons (#451).
  const touchingId = touching.get(b.id);
  const touchingBubble = touchingId ? doc.bubbles[touchingId] : undefined;
  const touchingName = touchingBubble
    ? ((touchingBubble.speakerId
        ? castById.get(touchingBubble.speakerId)?.name
        : null) ??
      touchingBubble.rawSpeaker ??
      "another speaker")
    : null;
  const joinPrev = joinNeighbour(doc, b.id, -1);
  const joinNext = joinNeighbour(doc, b.id, 1);
  const joined = groupMembers(doc, b.id).filter((m) => m.id !== b.id);
  const shortText = (text: string) => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > 32 ? `${flat.slice(0, 31)}…` : flat || "(no text)";
  };
  const candidates = unknown
    ? unknown.raw
        .split(/,|&|\/|\band\b/i)
        .map((part) => part.trim())
        .filter(Boolean)
    : [];
  // The cast members the label's parts name: offered as "Use X" buttons, and
  // the reason the label is "not assigned" rather than "not in the cast".
  const assignable = candidates.flatMap((name) => {
    const id = resolveSpeaker(name, cast);
    const known = id ? castById.get(id) : undefined;
    return known ? [known] : [];
  });
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

      {touchingId && touchingName && (
        <div className="space-y-2 rounded-sm border border-sky-400/40 bg-sky-400/10 p-2">
          <p className="text-sky-200">
            Touches {touchingName}&apos;s balloon,{" "}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-white"
              onClick={() => actions.select({ kind: "bubble", id: touchingId })}
            >
              bubble {numbers.get(touchingId)}
            </button>
            . One line split in two?
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className={BUTTON}
              title="Join the two balloons: one speaker, one clip"
              onClick={() =>
                actions.joinWith(
                  b.id,
                  "id" in joinPrev && joinPrev.id === touchingId ? -1 : 1,
                )
              }
            >
              Join
            </button>
            <button
              type="button"
              className={BUTTON}
              onClick={() => actions.standAlone(b.id, touchingId)}
            >
              Not one line
            </button>
          </div>
        </div>
      )}

      <AnalyzeBlock
        bubble={b}
        run={analysis[b.id]}
        hint={hints[b.id] ?? ""}
        castById={castById}
        lock={lock}
        actions={actions}
      />

      <div>
        <Label>
          Text <Key>E</Key>
          {textLocked && (
            <span className="text-amber-300">read-only: {lock.reason}</span>
          )}
        </Label>
        <textarea
          key={b.id}
          ref={textRef}
          value={b.text}
          readOnly={textLocked}
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

      {listen && (
        <ListenBlock
          bubble={b}
          view={listen}
          lock={lock}
          readOnly={textLocked}
          actions={actions}
        />
      )}

      <div>
        <Label>
          Speaker <Key>S</Key>
          {joined.length > 0 && (
            <span className="text-neutral-500">
              (applies to {joined.length + 1} joined balloons)
            </span>
          )}
        </Label>
        {picker.open ? (
          <SpeakerPicker
            cast={cast}
            known={data.known}
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
            onAdd={(name, voice, knownId) =>
              actions.addCast(name, voice, knownId, b.id, b.rawSpeaker)
            }
            onClose={actions.closePicker}
          />
        ) : (
          <button
            type="button"
            onClick={() => actions.openPicker()}
            className={`flex h-8 w-full items-center gap-2 rounded-sm border px-2 text-left ${
              spoken && !b.silent && !b.ignored && !member
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
                  {voiceLabel(member)
                    ? `voice: ${voiceLabel(member)}`
                    : "no voice yet"}
                </span>
              </>
            ) : (
              <span
                className={`flex-1 ${spoken ? "text-amber-200" : "text-neutral-500"}`}
              >
                {unknown
                  ? assignable.length === 0
                    ? `"${unknown.raw}" is not in the cast`
                    : candidates.length === 1 && assignable[0]
                      ? `"${unknown.raw}" is not assigned; use the Use ${assignable[0].name} button below`
                      : `"${unknown.raw}" is not assigned; use a button below to assign it`
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
          key={b.id}
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
        <div className="flex flex-wrap gap-px overflow-hidden rounded-sm border border-neutral-800 bg-neutral-800">
          {TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={b.type === t.id}
              onClick={() => actions.patch(b.id, { type: t.id }, "type change")}
              className={`h-7 flex-auto px-1.5 text-[11px] ${
                b.type === t.id
                  ? "bg-neutral-200 font-medium text-neutral-950"
                  : "bg-neutral-950 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
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
          className={`flex min-h-8 items-center justify-between gap-1 rounded-sm border px-2 py-1 text-left ${
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
          className={`flex min-h-8 items-center justify-between gap-1 rounded-sm border px-2 py-1 text-left ${
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

      <div>
        <Label>
          Join, one line in one clip <Key>G</Key>
        </Label>
        <div className="flex gap-1">
          {(
            [
              [-1, "with previous", joinPrev],
              [1, "with next", joinNext],
            ] as const
          ).map(([dir, label, found]) => (
            <button
              key={dir}
              type="button"
              className={BUTTON + " h-7"}
              disabled={"reason" in found}
              title={"reason" in found ? found.reason : undefined}
              onClick={() => actions.joinWith(b.id, dir)}
            >
              {label}
            </button>
          ))}
        </div>
        {joined.length > 0 && (
          <div className="mt-1.5 space-y-1">
            <p className="text-neutral-400">
              Joined with {plural(joined.length, "other balloon")}:{" "}
              {joined.map((m, i) => (
                <span key={m.id}>
                  {i > 0 && ", "}
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-white"
                    onClick={() => actions.select({ kind: "bubble", id: m.id })}
                  >
                    {numbers.get(m.id)}
                  </button>{" "}
                  &ldquo;{shortText(m.text)}&rdquo;
                </span>
              ))}
            </p>
            <button
              type="button"
              className={BUTTON + " h-7"}
              onClick={() => actions.splitFrom(b.id)}
            >
              Split off
            </button>
          </div>
        )}
      </div>

      <BoxFields
        rect={b.rect}
        onChange={(rect) =>
          actions.setRect({ kind: "bubble", id: b.id }, rect, `box:${b.id}`)
        }
      />

      <div className="border-t border-neutral-800 pt-3">
        <button
          type="button"
          className={BUTTON}
          onClick={() => actions.deleteBubble(b.id)}
        >
          Delete bubble <Key>Del</Key>
        </button>
      </div>
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
    new Set(facesIn(data.faces, panel).flatMap((f) => f.characterId ?? [])),
  );
  return (
    <div className="space-y-3 p-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[13px] font-medium text-neutral-100">
          Panel {index + 1}
        </h2>
        <span className="text-neutral-500">
          of {panels.length}, {plural(rows.length, "bubble")}
          {flagged > 0 ? `, ${needYou(flagged)}` : ""}
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

      <div className="space-y-1 border-t border-neutral-800 pt-3">
        <button
          type="button"
          className={BUTTON}
          onClick={() => actions.deletePanel(panel.id)}
        >
          Delete panel <Key>Del</Key>
        </button>
        {rows.length > 0 && (
          <p className="text-[11px] text-neutral-600">
            Its bubbles stay: each moves to the panel it overlaps most, or
            outside every panel.
          </p>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- page

function PageInspector(props: InspectorProps) {
  const { data, doc, page, flags, allFlags, numbers, castById, actions } =
    props;
  const pageFlagged = allFlags.filter((f) => f.page === page.number);
  const duplicates = pageFlagged.filter((f) =>
    f.flags.some((x) => x.kind === "duplicate"),
  );
  const speakerless = pageFlagged.filter((f) =>
    f.flags.some((x) => x.kind !== "duplicate"),
  );
  const firstFlag = allFlags[0];
  const flaggedPages = new Set(allFlags.map((f) => f.page)).size;
  const newVoices = doc.addedCast
    .filter((c) => c.voice.kind === "new")
    .map((c) => c.name);
  const noVoice = Array.from(
    new Set(
      Object.values(doc.bubbles)
        .filter((b) => !b.deleted && !b.ignored && !b.silent && b.speakerId)
        .flatMap((b) => {
          const m = b.speakerId ? castById.get(b.speakerId) : undefined;
          return m && !voiceLabel(m) ? [m.name] : [];
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
        </div>

        {pageFlagged.length > 0 ? (
          <div className="space-y-2 rounded-sm border border-amber-400/40 bg-amber-400/10 p-2">
            <p className="text-amber-200">
              Needs you:{" "}
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
        ) : (
          <p className="text-neutral-400">
            Every spoken bubble has a speaker. Nothing is flagged.
          </p>
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
          {plural(numbers.size, "bubble")}, {flags.size} flagged.
        </p>
      </section>

      <section className="space-y-2 border-t border-neutral-800 pt-3">
        <h2 className="text-[13px] font-medium text-neutral-100">Issue</h2>

        {firstFlag ? (
          <div className="space-y-2">
            <p className="text-amber-200">
              {allFlags.length}{" "}
              {allFlags.length === 1 ? "bubble needs" : "bubbles need"} you on{" "}
              {flaggedPages === 1
                ? `page ${firstFlag.page}`
                : `${flaggedPages} pages`}
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
        ) : (
          <p className="text-neutral-400">Nothing needs you on any page.</p>
        )}

        <div className="rounded-sm border border-neutral-800 p-2 text-[11px] text-neutral-400">
          <div className="text-neutral-300">
            Voice slots: {data.slotsUsed} of {data.slotsTotal} in use
            {newVoices.length > 0
              ? `, ${data.slotsUsed + newVoices.length} with the new voices`
              : ""}
            .
          </div>
          {newVoices.length > 0 && (
            <div>New voices to make: {newVoices.join(", ")}.</div>
          )}
          {noVoice.length > 0 && (
            <div className="text-amber-300">
              No voice yet: {noVoice.join(", ")}.
            </div>
          )}
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
