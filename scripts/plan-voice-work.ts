/**
 * The voice work library (#351) from the command line.
 *
 *   pnpm exec tsx --conditions=react-server --env-file=.env scripts/plan-voice-work.ts [--book <id>] [--issue <id>]
 *     Prints `planVoiceWork` (default tmnt-mmpr-iii / issue-1). Reads only:
 *     SELECTs, bucket downloads, and the ElevenLabs slot count; any other
 *     ElevenLabs request throws before it is sent.
 *
 *   LIVE_API_OK=1 pnpm exec tsx --conditions=react-server --env-file=.env scripts/plan-voice-work.ts --carry-out <characterId> [--book <id>] [--issue <id>]
 *     PAID, PRODUCTION: one real `carryOut` with no archive. Refuses unless
 *     LIVE_API_OK=1 is set, the plan shows a free slot, and the item is a
 *     clone or a restore that the plan lets run.
 *
 *   DRY_RUN=1 pnpm exec tsx --conditions=react-server --env-file=.env scripts/plan-voice-work.ts --check-301
 *     The three #301 double-failure cases against an in-memory Supabase fake
 *     whose writes can be made to fail and a fake ElevenLabs transport that
 *     counts paid creates. Touches no network and no production row.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

type Args = {
  book: string;
  issue: string;
  carryOut?: string;
  check301: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    book: "tmnt-mmpr-iii",
    issue: "issue-1",
    check301: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--book") args.book = value();
    else if (a === "--issue") args.issue = value();
    else if (a === "--carry-out") args.carryOut = value();
    else if (a === "--check-301") args.check301 = true;
    else if (a !== "--") throw new Error(`unknown argument ${a}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// ── plan and carry out ─────────────────────────────────────────────────────

const SLOT_COUNT_PATH = "/v1/user/subscription";

/** Lets only the slot-count GET through; everything else throws unsent. */
function slotCountOnly(calls: string[]): typeof fetch {
  return (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url.pathname}`);
    if (method !== "GET" || url.pathname !== SLOT_COUNT_PATH)
      throw new Error(
        `plan-voice-work: refused ${method} ${url.pathname}; the plan calls only the slot count`,
      );
    return globalThis.fetch(input, init);
  };
}

async function planOrCarryOut() {
  const { supabase } = await import("./lib/supabase.js");
  const { planVoiceWork, carryOut } = await import("~/lib/voice-requests");
  type Plan = Awaited<ReturnType<typeof planVoiceWork>>;

  const print = (plan: Plan, calls: string[]) => {
    const s = plan.status;
    console.log(`voice work for ${plan.bookId}/${plan.issueId}`);
    console.log(
      `slots: ${s.voice_slots_used} of ${s.voice_limit} used, ${plan.freeNow} free; add/edit ${s.voice_add_edit_counter} of ${s.max_voice_add_edits} used, ${plan.addEditHeadroom} left`,
    );
    console.log(
      `items: ${plan.items.length} (${plan.unsettled} unsettled); ${plan.adds} add(s), ${plan.archives} archive(s) planned; plan ${plan.ok ? "ok" : "refused"}`,
    );
    for (const r of plan.refusals) console.log(`  plan refusal: ${r}`);
    for (const item of plan.items) {
      console.log(
        `- ${item.characterId} "${item.name}": ${item.action} (${item.source}), ${item.state}, ${item.lines} line(s)`,
      );
      if (item.target)
        console.log(
          `    target: ${item.target.display_name} [${item.target.id}] ${item.target.status}`,
        );
      if (item.replaces)
        console.log(
          `    replaces: ${item.replaces.display_name} [${item.replaces.id}]`,
        );
      if (item.candidates.length > 0)
        console.log(
          `    voice-lab candidates: ${item.candidates.map((c) => `${c.name}${c.labDefault ? " (default)" : ""}`).join(", ")}`,
        );
      const o = item.outgoing;
      if (o?.kind === "free slot") console.log("    outgoing: the free slot");
      if (o?.kind === "archive") {
        console.log(
          `    outgoing: archive ${o.voice.display_name} [${o.voice.id}], ${o.order}`,
        );
        for (const r of o.refusals) console.log(`      archive refused: ${r}`);
        for (const c of o.leavesWithoutVoice)
          console.log(
            `      leaves without a voice: ${c.bookId}/${c.issueId} ${c.character}`,
          );
      }
      for (const r of item.refusals) console.log(`    refused: ${r}`);
      for (const w of item.warnings) console.log(`    note: ${w}`);
    }
    console.log(
      `spare voices the policy could archive: ${plan.spare.length ? plan.spare.map((v) => v.display_name).join(", ") : "none"}`,
    );
    const reasons = new Map<string, number>();
    for (const r of plan.refusedVoices)
      for (const why of r.refusals)
        reasons.set(why, (reasons.get(why) ?? 0) + 1);
    console.log(
      `active voices the policy refuses: ${plan.refusedVoices.length} (${[
        ...reasons,
      ]
        .map(([why, n]) => `${why}: ${n}`)
        .join(", ")})`,
    );
    console.log(`ElevenLabs requests: ${calls.join(", ") || "none"}`);
  };

  const calls: string[] = [];
  const planDeps = { supabase, fetch: slotCountOnly(calls) };
  const plan = await planVoiceWork(planDeps, args.book, args.issue);
  print(plan, calls);
  if (!args.carryOut) return;

  console.log(`\n--carry-out ${args.carryOut}`);
  if (process.env.LIVE_API_OK !== "1")
    throw new Error("refused: --carry-out spends; set LIVE_API_OK=1");
  const item = plan.items.find((i) => i.characterId === args.carryOut);
  if (!item) throw new Error(`refused: no item ${args.carryOut} in the plan`);
  if (item.action === "design")
    throw new Error(
      "refused: --carry-out runs only a clone or a restore, not a design",
    );
  if (!item.needsSlot)
    throw new Error(
      `refused: the item is ${item.state}${item.refusals.length ? `, ${item.refusals.join("; ")}` : ""}`,
    );
  if (plan.freeNow < 1 || item.outgoing?.kind !== "free slot")
    throw new Error(
      "refused: the plan shows no free slot for this item; --carry-out never archives",
    );
  const result = await carryOut({ supabase }, item, { archiveVoiceId: null });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "done") process.exitCode = 1;
}

// ── #301 check: in-memory Supabase and a counting ElevenLabs transport ─────

type Row = Record<string, unknown>;
type Op = "select" | "insert" | "update" | "upsert";
type Filter = (row: Row) => boolean;
interface Fault {
  table: string;
  op: Op;
  when: (payload: Row, rows: Row[]) => boolean;
  times: number;
  message: string;
}

class FakeDb {
  tables = new Map<string, Row[]>();
  faults: Fault[] = [];
  log: string[] = [];

  rows(table: string): Row[] {
    let t = this.tables.get(table);
    if (!t) this.tables.set(table, (t = []));
    return t;
  }

  /** Fails the next `times` writes that match. */
  failNext(
    table: string,
    op: Op,
    when: Fault["when"],
    message: string,
    times = 1,
  ) {
    this.faults.push({ table, op, when, times, message });
  }

  fault(table: string, op: Op, payload: Row, rows: Row[]): string | null {
    const f = this.faults.find(
      (x) =>
        x.times > 0 &&
        x.table === table &&
        x.op === op &&
        x.when(payload, rows),
    );
    if (!f) return null;
    f.times--;
    return f.message;
  }

  client(): SupabaseClient {
    return { from: (table: string) => new FakeQuery(this, table) } as never;
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private op: Op = "select";
  private payload: Row = {};
  private filters: Filter[] = [];
  private mode: "many" | "single" | "maybe" = "many";
  private returning = false;
  private conflict: string[] = [];
  private max = Infinity;

  constructor(
    private db: FakeDb,
    private table: string,
  ) {}

  select() {
    this.returning = this.op !== "select";
    return this;
  }
  insert(row: Row) {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.payload = patch;
    return this;
  }
  upsert(row: Row, opts?: { onConflict?: string }) {
    this.op = "upsert";
    this.payload = row;
    this.conflict = (opts?.onConflict ?? "id").split(",");
    return this;
  }
  eq(col: string, v: unknown) {
    this.filters.push((r) => r[col] === v);
    return this;
  }
  is(col: string, v: null) {
    this.filters.push((r) => (r[col] ?? null) === v);
    return this;
  }
  not(col: string, _op: "is", _v: null) {
    this.filters.push((r) => r[col] != null);
    return this;
  }
  in(col: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[col]));
    return this;
  }
  /** `a.eq.x,b.eq.y` only; a nested group (the alias scope) filters nothing. */
  or(expr: string) {
    if (expr.includes("(")) return this;
    const terms = expr.split(",").map((t) => t.split(".eq."));
    this.filters.push((r) => terms.some(([c, v]) => r[c!] === v));
    return this;
  }
  order() {
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  range() {
    return this;
  }
  single() {
    this.mode = "single";
    return this;
  }
  maybeSingle() {
    this.mode = "maybe";
    return this;
  }

  private run(): { data: unknown; error: unknown } {
    const rows = this.db.rows(this.table);
    const matched = rows.filter((r) => this.filters.every((f) => f(r)));
    let out: Row[] = matched;
    if (this.op !== "select") {
      const err = this.db.fault(this.table, this.op, this.payload, matched);
      const what = `${this.op} ${this.table} ${JSON.stringify(this.payload)}`;
      if (err) {
        this.db.log.push(`${what} -> FAILED (${err})`);
        return { data: null, error: { message: err } };
      }
      this.db.log.push(`${what} -> ok`);
      if (this.op === "insert") {
        const row = {
          id: randomUUID(),
          created_at: new Date().toISOString(),
          ...this.payload,
        };
        rows.push(row);
        out = [row];
      } else if (this.op === "update") {
        for (const r of matched) Object.assign(r, this.payload);
      } else {
        const hit = rows.find((r) =>
          this.conflict.every((c) => r[c] === this.payload[c]),
        );
        if (hit) Object.assign(hit, this.payload);
        else rows.push({ ...this.payload });
      }
      if (!this.returning) return { data: null, error: null };
    }
    out = out.slice(0, this.max).map((r) => ({ ...r }));
    if (this.mode === "many") return { data: out, error: null };
    if (this.mode === "single" && out.length !== 1)
      return { data: null, error: { message: "not exactly one row" } };
    return { data: out[0] ?? null, error: null };
  }

  then<A = { data: unknown; error: unknown }, B = never>(
    ok?: ((v: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(ok, bad);
  }
}

/** Answers Voice Design from fixtures and counts the paid creates. */
function countingTransport() {
  const t = {
    creates: 0,
    calls: [] as string[],
    fetch: (path: string, init: RequestInit): Promise<Response> => {
      t.calls.push(`${init.method ?? "GET"} ${path}`);
      const json = (body: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      if (path === "/v1/text-to-voice/design")
        return json({ previews: [{ generated_voice_id: "preview-1" }] });
      if (path === "/v1/text-to-voice") {
        t.creates++;
        return json({ voice_id: `fake-voice-${t.creates}` });
      }
      throw new Error(`fake transport: no answer for ${path}`);
    },
  };
  return t;
}

const BOOK = "check-book";

function seed(characters: string[]): FakeDb {
  const db = new FakeDb();
  for (const id of characters) {
    for (const issue of ["issue-1", "issue-2"])
      db.rows("bubbles").push({
        id: `${issue}-${id}`,
        book_id: BOOK,
        issue_id: issue,
        speaker: id[0]!.toUpperCase() + id.slice(1),
        ignored: false,
        silent: false,
      });
    db.rows("character_appearances").push({
      id: `${id}-voice-design`,
      character_id: id,
      voice_id: null,
      voice_status: null,
      voice_description: `A test voice for ${id}.`,
      voice_created_at: null,
    });
  }
  return db;
}

const onlyVoiceId = (p: Row) => Object.keys(p).length === 1 && "voice_id" in p;
const readyUpdate = (p: Row) => p.voice_status === "ready";
const appearance = (db: FakeDb, id: string) =>
  db.rows("character_appearances").find((r) => r.id === `${id}-voice-design`)!;

async function check301() {
  const { isDryRun } = await import("~/lib/fakes/dry-run");
  if (!isDryRun()) throw new Error("--check-301 runs only under DRY_RUN=1");
  const { designCharacterVoice, findCharactersNeedingVoices } = await import(
    "~/lib/voices-registry"
  );
  const writes = { dryRun: false };
  const results: { name: string; pass: boolean }[] = [];
  const run = async (
    db: FakeDb,
    t: ReturnType<typeof countingTransport>,
    issueId: string,
    id: string,
  ) => {
    try {
      const r = await designCharacterVoice(
        db.client(),
        { bookId: BOOK, issueId, characterId: id },
        { ...writes, fetch: t.fetch },
      );
      return `returned ${r.outcome}${r.voiceId ? ` ${r.voiceId}` : ""}`;
    } catch (err) {
      return `threw: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  const report = (name: string, lines: string[], pass: boolean) => {
    console.log(`\n${name}: ${pass ? "PASS" : "FAIL"}`);
    for (const l of lines) console.log(`  ${l}`);
    results.push({ name, pass });
  };

  {
    const db = seed(["rex"]);
    const t = countingTransport();
    db.failNext(
      "character_appearances",
      "update",
      onlyVoiceId,
      "write 1 down",
      2,
    );
    db.failNext("character_appearances", "update", readyUpdate, "write 2 down");
    const a = await run(db, t, "issue-1", "rex");
    const castAfterA = db
      .rows("castlist")
      .find((r) => r.issue_id === "issue-1" && r.character_id === "rex");
    const voiceIdAfterA = appearance(db, "rex").voice_id;
    const found = await findCharactersNeedingVoices(
      db.client(),
      BOOK,
      "issue-1",
      writes,
    );
    const voiceIdAfterB = appearance(db, "rex").voice_id;
    const other = await findCharactersNeedingVoices(
      db.client(),
      BOOK,
      "issue-2",
      writes,
    );
    const c = other.needDesign.includes("rex")
      ? await run(db, t, "issue-2", "rex")
      : "not in issue-2's need-design list";
    report(
      "case 1: appearance voice_id write fails twice, castlist row commits",
      [
        `run 1 issue-1 (first voice_id write, ready update and its voice_id retry all fail): ${a}`,
        `after run 1: castlist voice_uuid=${String(castAfterA?.voice_uuid ?? null)}, appearance voice_id=${String(voiceIdAfterA)}`,
        `run 2 issue-1 get-chars: wrote castlist voice back to [${found.repaired.join(", ")}], need design [${found.needDesign.join(", ")}], appearance voice_id=${String(voiceIdAfterB)}`,
        `run 3 issue-2 (no castlist row): need design [${other.needDesign.join(", ")}]; design step ${c}`,
        `paid creates: ${t.creates} (want 1)`,
      ],
      t.creates === 1 &&
        voiceIdAfterA === null &&
        Boolean(castAfterA?.voice_uuid) &&
        voiceIdAfterB === "fake-voice-1" &&
        !found.needDesign.includes("rex"),
    );
  }

  {
    const db = seed(["rex"]);
    const t = countingTransport();
    db.failNext("castlist", "upsert", () => true, "castlist down");
    db.failNext("character_appearances", "update", onlyVoiceId, "write 1 down");
    db.failNext("character_appearances", "update", readyUpdate, "write 2 down");
    const a = await run(db, t, "issue-1", "rex");
    const voices = db.rows("voices").length;
    const voiceIdAfterA = appearance(db, "rex").voice_id;
    const b = await run(db, t, "issue-1", "rex");
    const cast = db
      .rows("castlist")
      .find((r) => r.issue_id === "issue-1" && r.character_id === "rex");
    report(
      "case 2: voices insert lands, castlist upsert and both appearance writes fail",
      [
        `run 1 issue-1: ${a}`,
        `after run 1: ${voices} voices row(s), appearance voice_id=${String(voiceIdAfterA)} (the voice_id-only retry)`,
        `run 2 issue-1 (writes healthy): ${b}`,
        `after run 2: castlist voice_id=${String(cast?.voice_id ?? null)}`,
        `paid creates: ${t.creates} (want 1)`,
      ],
      t.creates === 1 &&
        a.startsWith("threw") &&
        voiceIdAfterA === "fake-voice-1" &&
        b.startsWith("returned stored id") &&
        cast?.voice_id === "fake-voice-1",
    );
  }

  {
    const db = seed(["rex", "zed"]);
    const t = countingTransport();
    db.failNext(
      "character_appearances",
      "update",
      (p, rows) => onlyVoiceId(p) && rows.some((r) => r.character_id === "rex"),
      "write 1 down",
    );
    const outcomes: string[] = [];
    for (const id of ["rex", "zed"]) {
      const r = await run(db, t, "issue-1", id);
      outcomes.push(`${id}: ${r}`);
      if (r.startsWith("threw")) break; // the ingest loop stops on a throw
    }
    const rex = appearance(db, "rex");
    const again = await run(db, t, "issue-1", "rex");
    report(
      "case 3: first voice_id write fails, the ready update stores it",
      [
        ...outcomes.map((o) => `ingest loop ${o}`),
        `rex appearance after: voice_id=${String(rex.voice_id)} voice_status=${String(rex.voice_status)}`,
        `rerun rex: ${again}`,
        `paid creates: ${t.creates} (want 2, one per character)`,
      ],
      t.creates === 2 &&
        outcomes.length === 2 &&
        outcomes.every((o) => o.includes("returned created")) &&
        rex.voice_status === "ready" &&
        again.startsWith("returned registered"),
    );
  }

  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n#301 cases: ${results.length - failed.length} of ${results.length} pass; no network, no production row`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

if (args.check301) await check301();
else await planOrCarryOut();
