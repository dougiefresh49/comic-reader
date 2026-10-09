// The pending card's decision (#779), read top to bottom: which voice the character gets (one radio group, the plan's pick preselected, each option's player inside it), what that costs (a slot, which voice is archived, what that leaves without a voice), then one action named for what it does.
"use client";

import { useId, useState } from "react";
import { chooseVoice, noAudio, pickActiveVoice, runItem } from "./actions";
import { Leaves, Samples } from "./bits";
import {
  PRIMARY,
  SELECT,
  plain,
  plainList,
  refOf,
  type Note,
  type Run,
  type Scope,
} from "./shared";
import type { Candidate, ItemView, SlotsView, VoiceRef } from "./types";

const FREE = "free";
// The archive select's placeholder, when the plan has no voice it can archive and offers no free slot (#770).
const PICK = "";

/**
 * Whether "use a free slot" is on offer: the plan's own free slot, or one
 * the plan gave no item. An item the plan found no slot for gets neither,
 * so Add cannot take the slot another item holds (#778, option A).
 */
const freeOfferedFor = (item: ItemView, slots: SlotsView): boolean =>
  item.outgoing?.kind === "free slot" ||
  (item.outgoing !== null && slots.freeAfterPlan > 0);

/** What the archive select starts on: the plan's pick only when it can be archived. */
function presetOf(item: ItemView, slots: SlotsView | null): string {
  const out = item.outgoing;
  if (out?.kind === "archive" && out.refusals.length === 0) return out.id;
  return slots && freeOfferedFor(item, slots) ? FREE : PICK;
}

/** The option the plan holds for the item: what Add would make. Null when nothing is chosen yet. */
function chosenKeyOf(item: ItemView): string | null {
  // Not a request and not planned: the plan's default is not on offer.
  const planned =
    item.source === "request" || item.needsSlot || item.refusals.length > 0;
  if (!planned) return null;
  if (item.action === "design") return "design";
  return item.target ? `voice:${item.target.id}` : null;
}

/** The card's key: a refresh that changes the plan's pick or the preset starts the decision over. */
export const decisionKey = (item: ItemView, slots: SlotsView | null): string =>
  `${chosenKeyOf(item)}|${presetOf(item, slots)}`;

type Option =
  | {
      key: string;
      kind: "voice";
      voice: VoiceRef;
      how: "clone" | "restore";
      clip: Candidate["clipUrl"] | undefined;
      labDefault: boolean;
    }
  | { key: "design"; kind: "design" }
  | { key: "keep"; kind: "keep"; voice: VoiceRef }
  | { key: "active"; kind: "active" }
  | { key: "none"; kind: "none" };

function optionsOf(item: ItemView, chosenKey: string | null): Option[] {
  const out: Option[] = [];
  // The plan's target when it is not a voice-lab clone on offer (a restore, or a clone already cast here).
  if (
    item.target &&
    chosenKey === `voice:${item.target.id}` &&
    !item.candidates.some((c) => c.id === item.target!.id)
  )
    out.push({
      key: chosenKey,
      kind: "voice",
      voice: item.target,
      how: item.action === "restore" ? "restore" : "clone",
      clip: undefined,
      labDefault: false,
    });
  for (const c of item.candidates)
    out.push({
      key: `voice:${c.id}`,
      kind: "voice",
      voice: c,
      how: "clone",
      clip: c.clipUrl,
      labDefault: c.labDefault,
    });
  out.push({ key: "design", kind: "design" });
  if (item.replaces)
    out.push({ key: "keep", kind: "keep", voice: item.replaces });
  out.push({ key: "active", kind: "active" });
  out.push({ key: "none", kind: "none" });
  return out;
}

function titleOf(o: Option): string {
  switch (o.kind) {
    case "voice":
      return o.voice.name;
    case "design":
      return "A new designed voice";
    case "keep":
      return `Keep ${o.voice.name}`;
    case "active":
      return "Another active voice";
    case "none":
      return "No audio this run";
  }
}

function describe(o: Option, chosen: boolean): string {
  const chosenNote = chosen ? " The plan's pick." : "";
  switch (o.kind) {
    case "voice":
      return o.how === "restore"
        ? `Its archived voice, brought back from the backup copy. Takes a slot.${chosenNote}`
        : `Voice-lab clone${o.labDefault ? ", the lab's pick" : ""}. Takes a slot.${chosenNote}`;
    case "design":
      return `Made from the character's description. Takes a slot.${chosenNote}`;
    case "keep":
      return "Its current voice. No slot used.";
    case "active":
      return "A voice already on the account. No slot used.";
    case "none":
      return "Its lines in this issue stay silent. No slot used.";
  }
}

export function Decision({
  scope,
  item,
  slots,
  active,
  busy,
  run,
  setNote,
}: {
  scope: Scope;
  item: ItemView;
  slots: SlotsView | null;
  active: VoiceRef[];
  busy: boolean;
  run: Run;
  setNote: (n: Note) => void;
}) {
  const ref = refOf(item);
  const chosenKey = chosenKeyOf(item);
  const options = optionsOf(item, chosenKey);
  const [selected, setSelected] = useState<string | null>(chosenKey);
  const [activeId, setActiveId] = useState("");
  const [picked, setPicked] = useState(presetOf(item, slots));
  const group = useId();
  const archiveId = useId();
  const sel = options.find((o) => o.key === selected) ?? null;
  const activeVoice = active.find((v) => v.id === activeId) ?? null;

  // The slot plan, shown only under the plan's own pick: another option is a choice to record, or takes no slot.
  const preset = presetOf(item, slots);
  const freeOffered = slots !== null && freeOfferedFor(item, slots);
  const choice = item.choices.find((c) => c.id === picked) ?? null;
  const refused = (choice?.refusals.length ?? 0) > 0;
  const order =
    choice && !refused
      ? item.outgoing?.kind === "archive" && item.outgoing.id === choice.id
        ? item.outgoing.order
        : slots && slots.free > 0
          ? "add first"
          : "archive first"
      : null;
  const replacesRefusals =
    item.choices.find((c) => c.id === item.replaces?.id)?.refusals ?? [];
  const costs = sel !== null && sel.key === chosenKey && item.needsSlot;

  // Why Add is off, first match wins; null means it may go.
  const addWhy = item.refusals.length
    ? plainList(item.refusals)
    : !item.needsSlot
      ? "Nothing to add."
      : !slots
        ? "The slot plan could not be read."
        : picked === FREE
          ? slots.free === 0
            ? "No free slot: pick a voice to archive"
            : null
          : !choice
            ? "Pick a voice to archive"
            : refused
              ? `${choice.name} cannot be archived: ${plainList(choice.refusals)}`
              : null;

  const addLabel = (o: Option) =>
    o.kind === "voice"
      ? `${o.how === "restore" ? "Restore" : "Add"} ${o.voice.name}`
      : "Add a new designed voice";
  const addConsequence = (): string => {
    if (picked === FREE && slots)
      return `Uses ${slots.free === 1 ? "the last free slot" : "a free slot"}.${
        item.replaces ? ` ${item.replaces.name} stays active.` : ""
      }`;
    if (choice && order === "add first")
      return `Adds the new voice, then archives ${choice.name}.`;
    if (choice)
      return `Archives ${choice.name} first; if the add is refused, ${choice.name} is put back.`;
    return "Nothing is added or archived yet.";
  };

  // The one action, named for what the selected option does.
  let action: {
    label: string;
    consequence: string;
    why: string | null;
    go: (() => void) | null;
  };
  if (!sel) {
    action = {
      label: "Pick a voice",
      consequence: "",
      why: "Pick one of the voices above.",
      go: null,
    };
  } else if (sel.kind === "voice" || sel.kind === "design") {
    if (sel.key === chosenKey) {
      action = {
        label: addLabel(sel),
        consequence: addConsequence(),
        why: addWhy,
        go: () =>
          run(choice ? `Running, archiving ${choice.name}` : "Running", () =>
            runItem({
              scope,
              item: ref,
              archiveVoiceId: picked === FREE ? null : (choice?.id ?? null),
            }),
          ),
      };
    } else {
      const name =
        sel.kind === "voice" ? sel.voice.name : "a new designed voice";
      action = {
        label: `Choose ${name}`,
        consequence:
          "Records the choice and plans a slot for it. Nothing is added until you click Add.",
        why: null,
        go: () =>
          run(`Choosing ${name}`, () =>
            chooseVoice({
              scope,
              characterId: item.characterId,
              choice:
                sel.kind === "voice"
                  ? {
                      kind: "clone",
                      voice:
                        item.candidates.find((c) => c.id === sel.voice.id) ??
                        sel.voice,
                    }
                  : { kind: "design" },
            }),
          ),
      };
    }
  } else if (sel.kind === "keep") {
    const voice = sel.voice;
    action = {
      label: `Keep ${voice.name}`,
      consequence:
        "No slot used. Settles this character with its current voice.",
      why: null,
      go: () =>
        run(`Keeping ${voice.name}`, () =>
          pickActiveVoice({ scope, item: ref, voice }),
        ),
    };
  } else if (sel.kind === "active") {
    action = {
      label: activeVoice ? `Use ${activeVoice.name}` : "Use an active voice",
      consequence: activeVoice
        ? `No slot used. Settles this character with ${activeVoice.name}.`
        : "",
      why: activeVoice ? null : "Pick an active voice from the list.",
      go: () =>
        activeVoice &&
        run(`Using ${activeVoice.name}`, () =>
          pickActiveVoice({ scope, item: ref, voice: activeVoice }),
        ),
    };
  } else {
    action = {
      label: "No audio this run",
      consequence:
        "Settles this character with no audio in this issue. Clear undoes it later.",
      why: null,
      go: () => run("No audio this run", () => noAudio({ scope, item: ref })),
    };
  }

  const archiveLabel = (c: ItemView["choices"][number]) => {
    const tags = [
      c.id === item.replaces?.id ? "the voice it replaces" : null,
      c.id === preset ? "as planned" : null,
    ].filter((t): t is string => t !== null);
    const base = `archive ${c.name}${tags.length ? ` (${tags.join(", ")})` : ""}`;
    return c.refusals.length
      ? `${base}, cannot be archived: ${plainList(c.refusals)}`
      : base;
  };

  return (
    <div className="mt-3 space-y-3">
      <fieldset className="min-w-0">
        <legend className="mb-1.5 text-neutral-400">
          Voice<span className="sr-only"> for {item.name}</span>
        </legend>
        <ul className="space-y-1">
          {options.map((o) => {
            const checked = selected === o.key;
            let inside: React.ReactNode = null;
            if (o.kind === "voice" && o.clip !== undefined)
              inside = o.clip ? (
                <audio
                  controls
                  preload="none"
                  src={o.clip}
                  aria-label={`Clip of ${o.voice.name}`}
                  className="h-8 max-w-56"
                />
              ) : (
                <span className="text-neutral-500">No clip to hear.</span>
              );
            else if (o.kind === "keep" && item.voice?.id === o.voice.id)
              inside = (
                <Samples
                  scope={scope}
                  item={item}
                  busy={busy}
                  setNote={setNote}
                />
              );
            else if (o.kind === "active")
              inside = (
                <select
                  name="active-voice"
                  aria-label={`Active voice for ${item.name} (no slot)`}
                  className={SELECT}
                  value={activeId}
                  disabled={busy}
                  onChange={(e) => {
                    setActiveId(e.target.value);
                    setSelected("active");
                  }}
                >
                  <option value="">Pick an active voice…</option>
                  {active.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              );
            return (
              <li
                key={o.key}
                onClick={() => !busy && setSelected(o.key)}
                className={`rounded-sm border px-3 py-2 ${
                  checked
                    ? "border-neutral-300 bg-neutral-800"
                    : "border-neutral-800 hover:border-neutral-600 hover:bg-neutral-800/60"
                }`}
              >
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    className="peer sr-only"
                    name={group}
                    value={o.key}
                    checked={checked}
                    disabled={busy}
                    onChange={() => setSelected(o.key)}
                  />
                  <span
                    aria-hidden
                    className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border peer-focus-visible:ring-2 peer-focus-visible:ring-neutral-300 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-neutral-900 ${
                      checked ? "border-white" : "border-neutral-500"
                    }`}
                  >
                    {checked && (
                      <span className="block size-2 rounded-full bg-white" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 leading-5">
                    <span className="block font-medium text-neutral-100">
                      {titleOf(o)}
                    </span>
                    <span className="block text-neutral-500">
                      {describe(o, o.key === chosenKey)}
                    </span>
                  </span>
                </label>
                {inside && <div className="mt-2 pl-6">{inside}</div>}
              </li>
            );
          })}
        </ul>
      </fieldset>

      {costs && (
        <div className="space-y-2 rounded-md border border-neutral-800 bg-neutral-950/60 p-3">
          <p className="text-neutral-300">Takes a slot.</p>
          {item.outgoing === null && (
            <p className="text-amber-200">
              The plan found no slot for it: every free slot is planned for
              another item. Pick a voice to archive.
            </p>
          )}
          <label
            htmlFor={archiveId}
            className="flex flex-wrap items-center gap-2"
          >
            <span className="text-neutral-400">Slot from</span>
            <select
              id={archiveId}
              name="archive-voice"
              className={SELECT}
              value={picked}
              disabled={busy || !slots}
              onChange={(e) => setPicked(e.target.value)}
            >
              {preset === PICK && (
                <option value={PICK} disabled>
                  Pick a voice to archive…
                </option>
              )}
              {freeOffered && (
                <option value={FREE}>a free slot, nothing archived</option>
              )}
              {item.choices.map((c) => (
                <option
                  key={c.id}
                  value={c.id}
                  disabled={c.refusals.length > 0}
                >
                  {archiveLabel(c)}
                </option>
              ))}
            </select>
          </label>
          {picked === FREE && item.replaces && replacesRefusals.length > 0 && (
            <p className="text-neutral-400">
              {item.replaces.name} stays active: {plainList(replacesRefusals)}.
            </p>
          )}
          {choice && !refused && <Leaves leaves={choice.leaves} />}
        </div>
      )}

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={PRIMARY}
            disabled={busy || action.why !== null}
            title={action.why ?? undefined}
            onClick={action.go ?? undefined}
          >
            {action.label}
          </button>
          {action.why && (
            <span className="text-amber-200">{plain(action.why)}</span>
          )}
        </div>
        {action.why === null && action.consequence && (
          <p className="mt-1 text-neutral-500">{action.consequence}</p>
        )}
      </div>
    </div>
  );
}
