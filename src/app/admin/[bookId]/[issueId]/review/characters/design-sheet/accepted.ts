// The design sheet's last accepted take per character, held in the browser
// for as long as the page is open: the Voice tab's staged row names its take
// from it, and reopening the sheet picks up where Accept left off. Never
// sent anywhere; the staged `create_design` move is the record.

import type { CreateDesignMove } from "~/lib/casting-moves";
import type { Take } from "./actions";

export interface Accepted {
  move: CreateDesignMove;
  /** The take picked, from 1. */
  take: number;
  takes: Take[];
}

const accepted = new Map<string, Accepted>();

export function rememberAccepted(a: Accepted) {
  accepted.set(a.move.character_id, a);
}

/** The sheet state behind a staged design move, when this page made it. */
export function acceptedFor(move: CreateDesignMove): Accepted | undefined {
  const a = accepted.get(move.character_id);
  return a?.move.generated_voice_id === move.generated_voice_id ? a : undefined;
}
