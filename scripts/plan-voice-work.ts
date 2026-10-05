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
 *   DRY_RUN=1 pnpm exec tsx --conditions=react-server --env-file=.env scripts/plan-voice-work.ts --check
 *     `carryOut` and `settle` end to end (one case per #351 review finding
 *     plus the happy path), and archive then restore (#458), against an
 *     in-memory Supabase fake whose writes can be made to fail and a fake
 *     ElevenLabs account. Touches no network and no production row.
 */
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

type Args = {
  book: string;
  issue: string;
  carryOut?: string;
  check: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    book: "tmnt-mmpr-iii",
    issue: "issue-1",
    check: false,
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
    else if (a === "--check") args.check = true;
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
      if (item.operation)
        console.log(
          `    operation in flight: ${item.operation.phase}; reconcile it before anything else`,
        );
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
type Op = "select" | "insert" | "update" | "upsert" | "delete";
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
  /** Unique keys per table; an insert that repeats one fails with 23505. */
  unique = new Map<string, string[]>([
    ["casting_tasks", ["book_id", "issue_id", "character_id"]],
  ]);
  /** Storage objects by `<bucket>/<path>`. */
  objects = new Map<string, Uint8Array>();

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
    const storage = {
      from: (bucket: string) => ({
        download: (path: string) => {
          const bytes = this.objects.get(`${bucket}/${path}`);
          return Promise.resolve(
            bytes
              ? { data: new Blob([bytes as BlobPart]), error: null }
              : { data: null, error: { message: "Object not found" } },
          );
        },
      }),
    };
    return {
      from: (table: string) => new FakeQuery(this, table),
      storage,
      fakeDb: this,
    } as never;
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private op: Op = "select";
  private payload: Row = {};
  private filters: Filter[] = [];
  private mode: "many" | "single" | "maybe" = "many";
  private returning = false;
  private conflict: string[] = [];
  private ignoreDuplicates = false;
  private max = Infinity;
  private skip = 0;

  constructor(
    private db: FakeDb,
    private table: string,
  ) {}

  select() {
    this.returning = this.op !== "select";
    return this;
  }
  // Payloads are copied, as a real write serializes them.
  insert(row: Row) {
    this.op = "insert";
    this.payload = structuredClone(row);
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.payload = structuredClone(patch);
    return this;
  }
  /** `ignoreDuplicates` keeps a row that already holds the conflict key, as `ON CONFLICT DO NOTHING` does. */
  upsert(row: Row, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.op = "upsert";
    this.payload = structuredClone(row);
    this.conflict = (opts?.onConflict ?? "id").split(",");
    this.ignoreDuplicates = opts?.ignoreDuplicates ?? false;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  /** `col->>key` reads a key of a JSON column as text, as PostgREST does. */
  eq(col: string, v: unknown) {
    const [c, key] = col.split("->>");
    this.filters.push((r) =>
      key === undefined
        ? r[c!] === v
        : (r[c!] as Record<string, unknown> | null)?.[key] === v,
    );
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
  /** `col.eq.x`, `col.is.null` and `col.lt.x` terms; a nested group (the alias scope) filters nothing. */
  or(expr: string) {
    if (expr.includes("(")) return this;
    const terms = expr.split(",").map((t) => {
      const [col, op, ...rest] = t.split(".");
      return { col: col!, op, v: rest.join(".") };
    });
    this.filters.push((r) =>
      terms.some(({ col, op, v }) =>
        op === "eq"
          ? r[col] === v
          : op === "is"
            ? (r[col] ?? null) === null
            : op === "lt"
              ? typeof r[col] === "string" && (r[col] as string) < v
              : false,
      ),
    );
    return this;
  }
  order() {
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  range(from: number, to: number) {
    this.skip = from;
    this.max = to - from + 1;
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
      const keys = this.db.unique.get(this.table);
      if (
        this.op === "insert" &&
        keys &&
        rows.some((r) => keys.every((k) => r[k] === this.payload[k]))
      )
        return {
          data: null,
          error: { code: "23505", message: "duplicate key" },
        };
      if (this.op === "delete") {
        for (const r of matched) rows.splice(rows.indexOf(r), 1);
      } else if (this.op === "insert") {
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
        if (hit) {
          if (!this.ignoreDuplicates) Object.assign(hit, this.payload);
        } else rows.push({ ...this.payload });
      }
      if (!this.returning) return { data: null, error: null };
    }
    out = out
      .slice(this.skip, this.skip + this.max)
      .map((r) => structuredClone(r));
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

const BOOK = "check-book";

// ── carryOut check: a fake world, a fake ElevenLabs account ───────────────

const CLIPS = "comic-voice-clips";
const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");
type AddMode = "ok" | "refuse" | "timeout-lands" | "timeout-lost" | "5xx-lands";

/** The ElevenLabs account behind `deps.fetch`: slots, voices, counters. */
function fakeAccount(limit: number) {
  const timeout = () =>
    Object.assign(new Error("The operation timed out."), {
      name: "TimeoutError",
    });
  const acct = {
    voices: [] as {
      voice_id: string;
      name: string;
      labels: Record<string, string>;
    }[],
    adds: 0,
    deletes: 0,
    addMode: "ok" as AddMode,
    /** One entry per coming `GET /v1/voices`: "fail" answers 503. */
    lists: [] as ("ok" | "fail")[],
    /** While set, an add waits on it: the run is mid-add. */
    gate: null as Promise<void> | null,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const method = init?.method ?? "GET";
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (path === "/v1/user/subscription")
        return json({
          voice_slots_used: acct.voices.length,
          voice_limit: limit,
          voice_add_edit_counter: acct.adds,
          max_voice_add_edits: 95,
        });
      if (path === "/v1/voices" && method === "GET") {
        if (acct.lists.shift() === "fail")
          return json({ detail: "list unavailable" }, 503);
        return json({ voices: acct.voices });
      }
      if (method === "DELETE") {
        const id = path.split("/").pop()!;
        acct.deletes++;
        acct.voices = acct.voices.filter((v) => v.voice_id !== id);
        return json({ status: "ok" });
      }
      if (path === "/v1/text-to-voice/design")
        return json({ previews: [{ generated_voice_id: "preview-1" }] });
      let name = "";
      let labels: Record<string, string> = {};
      if (path === "/v1/voices/add") {
        const form = init!.body as FormData;
        name = String(form.get("name"));
        labels = JSON.parse(String(form.get("labels"))) as typeof labels;
      } else if (path === "/v1/text-to-voice") {
        const body = JSON.parse(String(init!.body)) as {
          voice_name: string;
          labels?: typeof labels;
        };
        name = body.voice_name;
        labels = body.labels ?? {};
      } else throw new Error(`fake account: no answer for ${method} ${path}`);
      acct.adds++;
      if (acct.gate) await acct.gate;
      if (acct.addMode === "refuse")
        return json({ detail: "voice_limit_reached" }, 400);
      if (acct.voices.length >= limit) return json({ detail: "full" }, 400);
      const voice_id = `el-new-${acct.adds}`;
      if (acct.addMode !== "timeout-lost")
        acct.voices.push({ voice_id, name, labels });
      if (acct.addMode.startsWith("timeout")) throw timeout();
      if (acct.addMode === "5xx-lands")
        return json({ detail: "upstream error" }, 502);
      return json({ voice_id });
    }) as typeof fetch,
  };
  return acct;
}

interface WorldVoice {
  id: string;
  name: string;
  status: "active" | "archived";
  character?: string;
  castAs?: string[];
}

/** One book, one issue, the characters, and voices with verified bucket copies. */
function world(opts: {
  characters: string[];
  voices: WorldVoice[];
  limit?: number;
  unrelated?: string[];
}) {
  const db = new FakeDb();
  db.rows("issues").push({
    book_id: BOOK,
    id: "issue-1",
    number: 1,
    created_at: "2026-10-01T00:00:00Z",
  });
  for (const c of opts.characters) {
    const name = c[0]!.toUpperCase() + c.slice(1);
    db.rows("characters").push({
      id: c,
      display_name: name,
      aliases: [],
      form_of: null,
    });
    db.rows("bubbles").push({
      id: `b-${c}`,
      book_id: BOOK,
      issue_id: "issue-1",
      character_id: c,
      speaker: name,
      voice_description: `${name} sounds like a test.`,
      ignored: false,
      silent: false,
    });
  }
  const acct = fakeAccount(
    opts.limit ??
      opts.voices.filter((v) => v.status === "active").length +
        (opts.unrelated?.length ?? 0) +
        1,
  );
  for (const v of opts.voices) {
    const clip = new TextEncoder().encode(`clip of ${v.id}`);
    db.objects.set(`${CLIPS}/${v.id}/sample.mp3`, clip);
    const elId = v.status === "active" ? `el-${v.id}` : null;
    db.rows("voices").push({
      id: v.id,
      display_name: v.name,
      status: v.status,
      current_elevenlabs_id: elId,
      source_clip_path: `${v.id}/sample.mp3`,
      source_clip_md5: md5(clip),
      design_prompt: null,
      description: `${v.name}, a test voice.`,
      labels: { accent: "american" },
      consumers: ["comic"],
      keep_active: false,
      character_id: v.character ?? null,
      appearance_id: null,
      starting_pick: true,
      created_at: "2026-10-01T00:00:00Z",
      archived_at: v.status === "archived" ? "2026-10-01T00:00:00Z" : null,
      operation_claim: null,
      operation_claimed_at: null,
    });
    if (elId) acct.voices.push({ voice_id: elId, name: v.name, labels: {} });
    for (const c of v.castAs ?? [])
      db.rows("castlist").push({
        book_id: BOOK,
        issue_id: "issue-1",
        character: c,
        character_id: c,
        voice_uuid: v.id,
        in_issue: true,
        no_audio: false,
      });
  }
  for (const name of opts.unrelated ?? [])
    acct.voices.push({ voice_id: `el-unrelated-${name}`, name, labels: {} });
  return { db, acct, deps: { supabase: db.client(), fetch: acct.fetch } };
}

/** A description stored before its design (#458): a `needs_clip` voice with no appearance. */
const storedDesign = (db: FakeDb, character: string, text: string) =>
  db.rows("voices").push({
    id: randomUUID(),
    display_name: character[0]!.toUpperCase() + character.slice(1),
    status: "needs_clip",
    current_elevenlabs_id: null,
    source_clip_path: null,
    source_clip_md5: null,
    design_prompt: text,
    description: text,
    labels: null,
    consumers: ["comic"],
    keep_active: false,
    character_id: character,
    appearance_id: null,
    starting_pick: null,
    created_at: "2026-10-01T00:00:00Z",
    archived_at: null,
    operation_claim: null,
    operation_claimed_at: null,
  });

const request = (
  db: FakeDb,
  character: string,
  action: "clone" | "design",
  target: string | null = null,
) =>
  db.rows("casting_tasks").push({
    id: randomUUID(),
    book_id: BOOK,
    issue_id: "issue-1",
    character_id: character,
    action,
    target_voice_uuid: target,
    status: "pending",
    completed_at: null,
  });

async function checkCarryOut() {
  const { isDryRun } = await import("~/lib/fakes/dry-run");
  if (!isDryRun()) throw new Error("--check runs only under DRY_RUN=1");
  const lib = (await import(
    "~/lib/voice-requests"
  )) as typeof import("~/lib/voice-requests");
  const slots = await import("~/lib/voice-slots");
  const castLib = await import("~/lib/cast");
  const liveReconcile = (lib as Partial<typeof lib>).reconcile;
  /**
   * The cases below reconcile a run that stopped a moment ago; a record that
   * young reads as a live run (round 5), so age it past the window first.
   */
  const reconcile = liveReconcile
    ? (...a: Parameters<typeof lib.reconcile>) => {
        const db = (a[0].supabase as unknown as { fakeDb: FakeDb }).fakeDb;
        for (const t of db.rows("casting_tasks")) {
          const op = t.operation as { at?: string } | null;
          if (op) op.at = new Date(Date.now() - 3_600_000).toISOString();
        }
        return liveReconcile(...a);
      }
    : undefined;
  const results: { name: string; pass: boolean }[] = [];
  const report = (name: string, lines: string[], pass: boolean) => {
    console.log(`\n${name}: ${pass ? "PASS" : "FAIL"}`);
    for (const l of lines) console.log(`  ${l}`);
    results.push({ name, pass });
  };
  const short = (r: unknown) =>
    JSON.stringify(r, (k, v: unknown) =>
      k === "voice" || k === "target" || k === "replaces" ? undefined : v,
    ).slice(0, 260);
  const itemOf = async (
    deps: { supabase: SupabaseClient; fetch: typeof fetch },
    character: string,
  ) => {
    const plan = await lib.planVoiceWork(deps, BOOK, "issue-1");
    const item = plan.items.find((i) => i.characterId === character);
    if (!item) throw new Error(`no item for ${character}`);
    return item;
  };
  /** The task's status, and the phase of an open operation. */
  const task = (db: FakeDb, c: string) => {
    const row = db.rows("casting_tasks").find((r) => r.character_id === c);
    if (!row) return "none";
    const op = row.operation as { phase?: string } | null | undefined;
    return `${String(row.status)}${op ? ` (open at ${op.phase})` : ""}`;
  };
  /** The character's castlist rows as the new model holds them: the voice reference and "no audio". */
  const cast = (db: FakeDb, c: string) =>
    db
      .rows("castlist")
      .filter((r) => r.character_id === c)
      .map(
        (r) =>
          `${String(r.voice_uuid)}${r.no_audio === true ? " no_audio" : ""}`,
      )
      .join(", ") || "none";
  /** What a tapped bubble of the character plays in issue-1: the render chain's ElevenLabs id, or why it plays none. */
  const plays = async (db: FakeDb, c: string) => {
    const r = castLib.renderVoice(
      await castLib.loadBookCast(db.client(), BOOK),
      c,
      "issue-1",
    );
    return r.ok ? r.elevenLabsId : `none (${r.reason})`;
  };
  const attempt = async <T>(f: () => Promise<T>) => {
    try {
      return await f();
    } catch (err) {
      return { threw: err instanceof Error ? err.message : String(err) };
    }
  };

  {
    const w = world({
      characters: ["zed"],
      voices: [
        {
          id: "zed-1993",
          name: "Zed (1993)",
          status: "archived",
          character: "zed",
        },
      ],
    });
    request(w.db, "zed", "clone", "zed-1993");
    const item = await itemOf(w.deps, "zed");
    const r = await attempt(() =>
      lib.carryOut(w.deps, item, { archiveVoiceId: null }),
    );
    const afterCarry = task(w.db, "zed");
    const settled = await attempt(() =>
      lib.settle(w.db.client(), item, { kind: "accept" }),
    );
    const row = w.db.rows("voices").find((v) => v.id === "zed-1993")!;
    const zedPlays = await plays(w.db, "zed");
    report(
      "happy path: a clone into the free slot, then accept",
      [
        `plan: ${item.action} ${item.target?.display_name}, outgoing ${item.outgoing?.kind}`,
        `carryOut: ${short(r)}`,
        `voices row: ${String(row.status)} ${String(row.current_elevenlabs_id)}; castlist zed: ${cast(w.db, "zed")}; zed plays ${zedPlays}`,
        `task after carryOut: ${afterCarry}; settle accept: ${settled === undefined ? "ok" : short(settled)}; task: ${task(w.db, "zed")}`,
        `ElevenLabs: ${w.acct.adds} add(s), ${w.acct.deletes} delete(s)`,
      ],
      (r as { status?: string }).status === "done" &&
        row.status === "active" &&
        cast(w.db, "zed") === "zed-1993" &&
        zedPlays === row.current_elevenlabs_id &&
        zedPlays === "el-new-1" &&
        afterCarry === "in_progress" &&
        task(w.db, "zed") === "complete" &&
        w.acct.adds === 1 &&
        w.acct.deletes === 0,
    );
  }

  {
    const w = world({
      characters: ["rex"],
      voices: [
        { id: "rex-old", name: "Rex", status: "active", castAs: ["rex"] },
        {
          id: "rex-1993",
          name: "Rex (1993)",
          status: "archived",
          character: "rex",
        },
      ],
      unrelated: ["Rex (1993)"],
    });
    request(w.db, "rex", "clone", "rex-1993");
    w.acct.addMode = "timeout-lost";
    const item = await itemOf(w.deps, "rex");
    const r = await attempt(() =>
      lib.carryOut(w.deps, item, { archiveVoiceId: "rex-old" }),
    );
    const rexPlays = await plays(w.db, "rex");
    report(
      "finding 1: a lost add reply never adopts an unrelated voice with the same name",
      [
        `the account already holds an unregistered voice named "Rex (1993)"; the add times out and makes nothing`,
        `carryOut (add first, archive rex-old after): ${short(r)}`,
        `castlist rex: ${cast(w.db, "rex")}; rex plays ${rexPlays}; ElevenLabs deletes: ${w.acct.deletes} (want 0)`,
      ],
      (r as { status?: string }).status === "needs attention" &&
        w.acct.deletes === 0 &&
        cast(w.db, "rex") === "rex-old" &&
        rexPlays === "el-rex-old",
    );
  }

  {
    const w = world({
      characters: ["zed", "kit"],
      voices: [
        {
          id: "zed-1993",
          name: "Zed (1993)",
          status: "archived",
          character: "zed",
        },
      ],
      limit: 3,
    });
    request(w.db, "zed", "clone", "zed-1993");
    storedDesign(w.db, "kit", "Kit sounds bright.");
    const zed = await itemOf(w.deps, "zed");
    w.acct.addMode = "timeout-lands";
    w.acct.lists = ["ok", "fail"]; // the inventory, then the lookup
    const first = await attempt(() =>
      lib.carryOut(w.deps, zed, { archiveVoiceId: null }),
    );
    w.acct.addMode = "ok";
    const zedNow = await itemOf(w.deps, "zed");
    const second = await attempt(() =>
      lib.carryOut(w.deps, zedNow, { archiveVoiceId: null }),
    );
    const fixed = reconcile
      ? await attempt(() => reconcile(w.deps, zedNow))
      : "reconcile does not exist";
    const zedAdds = w.acct.adds;

    const kit = await itemOf(w.deps, "kit");
    // kit has no castlist row: the write is an update that changes nothing, then this upsert.
    w.db.failNext("castlist", "upsert", () => true, "castlist down");
    const k1 = await attempt(() =>
      lib.carryOut(w.deps, kit, { archiveVoiceId: null }),
    );
    const kitNow = await itemOf(w.deps, "kit");
    const k2 = await attempt(() =>
      lib.carryOut(w.deps, kitNow, { archiveVoiceId: null }),
    );
    const kFixed = reconcile
      ? await attempt(() => reconcile(w.deps, kitNow))
      : "reconcile does not exist";
    const kitRows = w.db
      .rows("voices")
      .filter((v) => v.character_id === "kit").length;
    report(
      "finding 2: an uncertain item is recorded and refuses a second paid create",
      [
        `zed clone: the add times out but lands, and the lookup fails: ${short(first)}`,
        `zed after: state ${zedNow.state}; second carryOut: ${short(second)}`,
        `zed reconcile: ${short(fixed)}; adds for zed: ${zedAdds} (want 1)`,
        `kit design: the voices row lands, the castlist write fails: ${short(k1)}`,
        `kit after: state ${kitNow.state}; second carryOut: ${short(k2)}`,
        `kit reconcile: ${short(kFixed)}; kit voices rows: ${kitRows} (want 1); paid adds in all: ${w.acct.adds} (want 2)`,
      ],
      zedAdds === 1 &&
        (second as { status?: string }).status === "refused" &&
        (fixed as { status?: string }).status === "done" &&
        (k2 as { status?: string }).status === "refused" &&
        (kFixed as { status?: string }).status === "done" &&
        kitRows === 1 &&
        w.acct.adds === 2,
    );
  }

  {
    const w = world({ characters: ["max"], voices: [], limit: 2 });
    const item = await itemOf(w.deps, "max");
    let gemini = 0;
    const log = console.log;
    console.log = (...a: unknown[]) => {
      if (String(a[0]).includes("would spend: gemini")) gemini++;
      log(...a);
    };
    const both = await Promise.all([
      attempt(() => lib.carryOut(w.deps, item, { archiveVoiceId: null })),
      attempt(() => lib.carryOut(w.deps, item, { archiveVoiceId: null })),
    ]);
    console.log = log;
    const statuses = both.map((r) => (r as { status?: string }).status);
    report(
      "finding 3: two concurrent designs for a new character make one voice",
      [
        `max has no voice and no stored description; two carryOut calls at once`,
        `results: ${both.map(short).join(" | ")}`,
        `Gemini descriptions: ${gemini} (want 1); paid creates: ${w.acct.adds} (want 1)`,
      ],
      w.acct.adds === 1 &&
        gemini === 1 &&
        statuses.includes("done") &&
        statuses.includes("refused"),
    );
  }

  {
    const w = world({
      characters: ["rex"],
      voices: [{ id: "rex-old", name: "Rex", status: "active" }],
    });
    const voice = (await slots.readVoice(w.db.client(), "rex-old"))!;
    w.db.failNext(
      "voices",
      "update",
      (p) => p.status === "archived",
      "voices down",
    );
    const archived = await attempt(() =>
      slots.archiveVoice(w.deps, voice, { needs: new Set(), execute: true }),
    );
    const row = (await slots.readVoice(w.db.client(), "rex-old"))!;
    const restored = await attempt(() =>
      slots.restoreVoice(w.deps, row, { execute: true }),
    );
    report(
      "finding 4: a confirmed DELETE with a failed registry write can still be restored",
      [
        `archive: ${short(archived)}`,
        `row after: ${String(row.status)} ${String(row.current_elevenlabs_id)}; ElevenLabs deletes: ${w.acct.deletes}`,
        `restore: ${short(restored)}`,
      ],
      w.acct.deletes === 1 &&
        (restored as { executed?: boolean }).executed === true,
    );
  }

  {
    // kit with no voice gets a row with no_audio and no voice; kit with an
    // archived voice keeps that voice on its row (#429: a skip leaves
    // voice_uuid alone).
    const lines: string[] = [];
    let pass = true;
    for (const voices of [
      [],
      [
        {
          id: "kit-voice",
          name: "Kit",
          status: "archived",
          castAs: ["kit"],
        },
      ] as WorldVoice[],
    ]) {
      const w = world({ characters: ["kit"], voices });
      const before = cast(w.db, "kit");
      const item = await itemOf(w.deps, "kit");
      const r = await attempt(() =>
        lib.settle(w.db.client(), item, { kind: "no audio" }),
      );
      const want = voices.length ? "kit-voice no_audio" : "null no_audio";
      const kitPlays = await plays(w.db, "kit");
      lines.push(
        `${voices.length ? "kit cast with an archived voice" : "kit with no voice"} (${item.action}): castlist before ${before}; settle: ${r === undefined ? "ok" : short(r)}`,
        `  castlist kit after: ${cast(w.db, "kit")} (want ${want}); kit plays ${kitPlays}; task: ${task(w.db, "kit")}`,
      );
      pass &&=
        r === undefined &&
        cast(w.db, "kit") === want &&
        kitPlays === "none (no audio)" &&
        task(w.db, "kit") === "complete";
    }
    report(
      'finding 5: "no audio this run" sets no_audio and leaves the voice reference as it was',
      lines,
      pass,
    );
  }

  {
    // #429 round 3: a pending clone request for a character whose own row in
    // this issue is "no audio" or removed is refused, takes no slot, and does
    // not hold the voices gate.
    const { planCastingTasks } = await import(
      "~/workflows/steps/casting-tasks"
    );
    const lines: string[] = [];
    let pass = true;
    for (const [removed, want] of [
      [false, "no audio in this issue"],
      [true, "removed from this issue"],
    ] as const) {
      const w = world({
        characters: ["zed"],
        voices: [
          { id: "zed-1993", name: "Zed", status: "archived", character: "zed" },
        ],
      });
      w.db.rows("castlist").push({
        book_id: BOOK,
        issue_id: "issue-1",
        character: "zed",
        character_id: "zed",
        voice_uuid: null,
        in_issue: !removed,
        no_audio: !removed,
      });
      request(w.db, "zed", "clone", "zed-1993");
      // The database reads a request with no operation as null.
      for (const t of w.db.rows("casting_tasks")) t.operation ??= null;
      const item = await itemOf(w.deps, "zed");
      const gate = await planCastingTasks(w.db.client(), BOOK, "issue-1");
      lines.push(
        `zed ${want}: refusals [${item.refusals.join("; ")}], needsSlot ${item.needsSlot}; gate unsettled [${gate.unsettled.join(", ")}]`,
      );
      pass &&=
        item.refusals.includes(want) &&
        !item.needsSlot &&
        !gate.unsettled.includes("zed");
    }
    report(
      "#429 round 3: a request for a character its own row silences or removes is refused and holds no gate",
      lines,
      pass,
    );
  }

  {
    const w = world({
      characters: ["rex", "zed"],
      voices: [
        {
          id: "shared",
          name: "Shared",
          status: "active",
          castAs: ["rex", "zed"],
        },
        { id: "parked", name: "Parked", status: "active" },
      ],
      limit: 2,
    });
    request(w.db, "rex", "design");
    request(w.db, "zed", "design");
    const plan = await lib.planVoiceWork(w.deps, BOOK, "issue-1");
    const out = plan.items.map((i) =>
      i.outgoing?.kind === "archive"
        ? i.outgoing.voice.id
        : String(i.outgoing?.kind ?? null),
    );
    report(
      "finding 6: two items never share an outgoing voice",
      [
        `rex and zed both replace "Shared"; no free slot`,
        `outgoing: ${plan.items.map((i, n) => `${i.characterId} -> ${out[n]}`).join(", ")}`,
      ],
      out.length === 2 && out[0] !== out[1],
    );
  }

  // ── round 2 ──

  {
    const w = world({
      characters: ["ann"],
      voices: [
        { id: "ann-voice", name: "Ann", status: "archived", castAs: ["ann"] },
      ],
    });
    const item = await itemOf(w.deps, "ann");
    const r = await attempt(() =>
      lib.carryOut(w.deps, item, { archiveVoiceId: null }),
    );
    const annPlays = await plays(w.db, "ann");
    report(
      "round 2, finding 2: a restore into a free slot for a character with no task row",
      [
        `plan: ${item.action} (${item.source}), outgoing ${item.outgoing?.kind}`,
        `carryOut: ${short(r)}`,
        `castlist ann: ${cast(w.db, "ann")}; ann plays ${annPlays}; task: ${task(w.db, "ann")}; adds: ${w.acct.adds}`,
      ],
      (r as { status?: string }).status === "done" &&
        cast(w.db, "ann") === "ann-voice" &&
        annPlays === "el-new-1" &&
        task(w.db, "ann") === "in_progress" &&
        w.acct.adds === 1,
    );
  }

  {
    const w = world({
      characters: ["rex"],
      voices: [{ id: "rex-old", name: "Rex", status: "active" }],
      limit: 2,
    });
    // The DELETE landed; neither registry write did.
    w.acct.voices = w.acct.voices.filter((v) => v.voice_id !== "el-rex-old");
    w.db.rows("casting_tasks").push({
      id: randomUUID(),
      book_id: BOOK,
      issue_id: "issue-1",
      character_id: "rex",
      action: "design",
      target_voice_uuid: null,
      status: "pending",
      operation: {
        token: "t0",
        rev: "r0",
        phase: "archived",
        archived: "rex-old",
        archivedElevenLabsId: "el-rex-old",
      },
      completed_at: null,
    });
    const key = {
      bookId: BOOK,
      issueId: "issue-1",
      characterId: "rex",
      action: "design" as const,
      target: null,
    };
    const both = reconcile
      ? await Promise.all([
          attempt(() => reconcile(w.deps, key)),
          attempt(() => reconcile(w.deps, key)),
        ])
      : ["reconcile does not exist"];
    const row = w.db.rows("voices").find((v) => v.id === "rex-old")!;
    report(
      "round 2 and 3, reconcile never spends: two concurrent calls at `archived` add nothing and name the voice to restore",
      [
        `the record says rex-old was archived (its DELETE landed, its row still says active)`,
        `results: ${both.map(short).join(" | ")}`,
        `rex-old: ${String(row.status)} ${String(row.current_elevenlabs_id)}; task: ${task(w.db, "rex")}; paid adds: ${w.acct.adds} (want 0)`,
      ],
      w.acct.adds === 0 &&
        row.status === "archived" &&
        task(w.db, "rex") === "pending" &&
        both.some((r) => short(r).includes("restore it from /admin/voices")),
    );
  }

  {
    const w = world({
      characters: ["zed"],
      voices: [
        {
          id: "zed-1993",
          name: "Zed (1993)",
          status: "archived",
          character: "zed",
        },
      ],
    });
    request(w.db, "zed", "clone", "zed-1993");
    w.acct.addMode = "5xx-lands";
    const item = await itemOf(w.deps, "zed");
    const r = await attempt(() =>
      lib.carryOut(w.deps, item, { archiveVoiceId: null }),
    );
    const zedPlays = await plays(w.db, "zed");
    report(
      "round 2, finding 6: a 5xx on the add is uncertain, and the landed voice is matched",
      [
        `the add answers 502 but the voice exists`,
        `carryOut: ${short(r)}`,
        `castlist zed: ${cast(w.db, "zed")}; zed plays ${zedPlays}; adds: ${w.acct.adds} (want 1)`,
      ],
      (r as { status?: string }).status === "done" &&
        cast(w.db, "zed") === "zed-1993" &&
        zedPlays === "el-new-1" &&
        w.acct.adds === 1,
    );
  }

  {
    const w = world({
      characters: ["rex"],
      voices: [
        { id: "rex-old", name: "Rex", status: "active", castAs: ["rex"] },
        {
          id: "rex-1993",
          name: "Rex (1993)",
          status: "archived",
          character: "rex",
        },
      ],
    });
    request(w.db, "rex", "clone", "rex-1993");
    w.db.failNext(
      "voices",
      "update",
      (p) => p.status === "archived",
      "voices down",
    );
    const item = await itemOf(w.deps, "rex");
    const r = await attempt(() =>
      lib.carryOut(w.deps, item, { archiveVoiceId: "rex-old" }),
    );
    const phase = (
      w.db.rows("casting_tasks").find((t) => t.character_id === "rex")
        ?.operation as { phase?: string } | null
    )?.phase;
    const fixed = reconcile
      ? await attempt(() => reconcile(w.deps, item))
      : "reconcile does not exist";
    const old = w.db.rows("voices").find((v) => v.id === "rex-old")!;
    report(
      "round 2, finding 3b: the archive after the add records a confirmed DELETE whose write failed",
      [
        `add first, then archive rex-old; its DELETE lands and the voices update fails`,
        `carryOut: ${short(r)}`,
        `record after: ${String(phase)}; reconcile: ${short(fixed)}`,
        `rex-old after reconcile: ${String(old.status)}; task: ${task(w.db, "rex")}; deletes: ${w.acct.deletes}`,
      ],
      (r as { status?: string }).status === "needs attention" &&
        phase === "retired" &&
        (fixed as { status?: string }).status === "done" &&
        old.status === "archived" &&
        task(w.db, "rex") === "in_progress",
    );
  }

  {
    // A design reruns with no target (a clone names one: round 3, finding 3).
    const w = world({ characters: ["zed"], voices: [] });
    request(w.db, "zed", "design");
    storedDesign(w.db, "zed", "Zed sounds calm.");
    const item = await itemOf(w.deps, "zed");
    await attempt(() => lib.carryOut(w.deps, item, { archiveVoiceId: null }));
    const made = task(w.db, "zed");
    const r = await attempt(() =>
      lib.settle(w.db.client(), item, { kind: "rerun" }),
    );
    const row = w.db.rows("voices").find((v) => v.character_id === "zed")!;
    report(
      'round 2, finding 7: "rerun" puts a made item back to pending and keeps its voice',
      [
        `task after carryOut: ${made}; settle rerun: ${r === undefined ? "ok" : short(r)}`,
        `task: ${task(w.db, "zed")}; zed voice: ${String(row.status)}; deletes: ${w.acct.deletes}`,
      ],
      made === "in_progress" &&
        task(w.db, "zed") === "pending" &&
        row.status === "active" &&
        w.acct.deletes === 0,
    );
  }

  // ── round 3 (decisions row 264: reconcile never spends) ──

  const seedOp = (
    db: FakeDb,
    character: string,
    op: Record<string, unknown>,
    target: string | null = null,
  ) =>
    db.rows("casting_tasks").push({
      id: randomUUID(),
      book_id: BOOK,
      issue_id: "issue-1",
      character_id: character,
      action: target ? "clone" : "design",
      target_voice_uuid: target,
      status: "pending",
      operation: { token: "t0", rev: "r0", ...op },
      completed_at: null,
    });
  const rexKey = {
    bookId: BOOK,
    issueId: "issue-1",
    characterId: "rex",
    action: "design" as const,
    target: null,
  };
  const recon = (deps: { supabase: SupabaseClient; fetch: typeof fetch }) =>
    reconcile
      ? attempt(() => reconcile(deps, rexKey))
      : Promise.resolve("reconcile does not exist");

  {
    const w = world({
      characters: ["rex"],
      voices: [{ id: "rex-old", name: "Rex", status: "active" }],
      limit: 2,
    });
    // The owner already brought rex-old back in /admin/voices.
    const row = w.db.rows("voices").find((v) => v.id === "rex-old")!;
    row.current_elevenlabs_id = "el-owner";
    w.acct.voices = [{ voice_id: "el-owner", name: "Rex", labels: {} }];
    seedOp(w.db, "rex", {
      phase: "archived",
      archived: "rex-old",
      archivedElevenLabsId: "el-rex-old",
    });
    const r = await recon(w.deps);
    report(
      "round 3, finding 1: reconcile after the owner restored the voice adds nothing and leaves the row",
      [
        `reconcile: ${short(r)}`,
        `rex-old: ${String(row.status)} ${String(row.current_elevenlabs_id)}; voice_archives rows: ${w.db.rows("voice_archives").length}; paid adds: ${w.acct.adds} (want 0)`,
      ],
      w.acct.adds === 0 &&
        row.status === "active" &&
        row.current_elevenlabs_id === "el-owner" &&
        w.db.rows("voice_archives").length === 0,
    );
  }

  {
    const w = world({
      characters: ["rex"],
      voices: [{ id: "rex-old", name: "Rex", status: "active" }],
      limit: 2,
    });
    w.acct.voices = []; // the DELETE landed
    seedOp(w.db, "rex", {
      phase: "archiving",
      archived: "rex-old",
      archivedElevenLabsId: "el-rex-old",
    });
    const r = await recon(w.deps);
    const row = w.db.rows("voices").find((v) => v.id === "rex-old")!;
    report(
      "round 3, finding 2 (DELETE landed): reconcile at `archiving` finishes the archive and gives the item back",
      [
        `reconcile: ${short(r)}`,
        `rex-old: ${String(row.status)}; task: ${task(w.db, "rex")}; paid adds: ${w.acct.adds}`,
      ],
      w.acct.adds === 0 &&
        row.status === "archived" &&
        task(w.db, "rex") === "pending" &&
        short(r).includes("restore it from /admin/voices"),
    );
  }

  {
    const w = world({
      characters: ["rex"],
      voices: [
        { id: "rex-old", name: "Rex", status: "active" },
        {
          id: "rex-1993",
          name: "Rex (1993)",
          status: "active",
          character: "rex",
          castAs: ["rex"],
        },
      ],
    });
    seedOp(
      w.db,
      "rex",
      {
        phase: "retiring",
        archived: "rex-old",
        archivedElevenLabsId: "el-rex-old",
        elevenLabsId: "el-rex-1993",
        replaces: "rex-old",
      },
      "rex-1993",
    );
    const r = await recon(w.deps);
    const old = w.db.rows("voices").find((v) => v.id === "rex-old")!;
    report(
      "round 3, finding 2 (DELETE did not land): reconcile at `retiring` ends the item and keeps the old voice",
      [
        `reconcile: ${short(r)}`,
        `rex-old: ${String(old.status)}; task: ${task(w.db, "rex")}; adds ${w.acct.adds}, deletes ${w.acct.deletes}`,
      ],
      (r as { status?: string }).status === "done" &&
        short(r).includes("stays active") &&
        old.status === "active" &&
        task(w.db, "rex") === "in_progress" &&
        w.acct.adds === 0 &&
        w.acct.deletes === 0,
    );
  }

  {
    const w = world({
      characters: ["zed"],
      voices: [
        {
          id: "zed-1993",
          name: "Zed (1993)",
          status: "archived",
          character: "zed",
        },
        {
          id: "zed-2012",
          name: "Zed (2012)",
          status: "archived",
          character: "zed",
        },
      ],
      limit: 2,
    });
    request(w.db, "zed", "clone", "zed-1993");
    const first = await itemOf(w.deps, "zed");
    await attempt(() => lib.carryOut(w.deps, first, { archiveVoiceId: null }));
    const rerun = await attempt(() =>
      lib.settle(w.db.client(), first, {
        kind: "rerun",
        targetVoiceUuid: "zed-2012",
      }),
    );
    const next = await itemOf(w.deps, "zed");
    const r = await attempt(() =>
      lib.carryOut(w.deps, next, { archiveVoiceId: null }),
    );
    const made = w.db.rows("voices").find((v) => v.id === "zed-1993")!;
    report(
      "round 3, finding 3: a rerun of a clone with a new target can be carried out",
      [
        `rerun: ${rerun === undefined ? "ok" : short(rerun)}; next item: ${next.action} ${next.target?.display_name}`,
        `carryOut: ${short(r)}`,
        `castlist zed: ${cast(w.db, "zed")}; zed-1993: ${String(made.status)}; adds ${w.acct.adds}, deletes ${w.acct.deletes}`,
      ],
      (r as { status?: string }).status === "done" &&
        cast(w.db, "zed") === "zed-2012" &&
        made.status === "active" &&
        w.acct.deletes === 0,
    );
  }

  {
    const w = world({
      characters: ["rex"],
      voices: [
        { id: "rex-old", name: "Rex", status: "active", castAs: ["rex"] },
        {
          id: "rex-1993",
          name: "Rex (1993)",
          status: "archived",
          character: "rex",
        },
      ],
      limit: 1,
    });
    request(w.db, "rex", "clone", "rex-1993");
    w.acct.addMode = "timeout-lands";
    w.acct.lists = ["ok", "fail"]; // the inventory, then the lookup
    const item = await itemOf(w.deps, "rex");
    const r = await attempt(() =>
      lib.carryOut(w.deps, item, { archiveVoiceId: "rex-old" }),
    );
    const fixed = reconcile
      ? await attempt(() => reconcile(w.deps, item))
      : "reconcile does not exist";
    const made = w.db.rows("voices").find((v) => v.id === "rex-1993")!;
    report(
      "round 3, finding 4: recovery after an archive-first replacement copies the replaced voice's metadata",
      [
        `carryOut (archive rex-old first, the add's reply is lost): ${short(r)}`,
        `reconcile: ${short(fixed)}`,
        `rex-1993 description: "${String(made.description)}" (want "Rex, a test voice.")`,
      ],
      (fixed as { status?: string }).status === "done" &&
        made.description === "Rex, a test voice.",
    );
  }

  // ── round 4 ──

  for (const lost of [false, true]) {
    const w = world({
      characters: ["rex"],
      voices: [
        { id: "rex-old", name: "Rex", status: "active", castAs: ["rex"] },
        {
          id: "rex-1993",
          name: "Rex (1993)",
          status: "archived",
          character: "rex",
        },
      ],
      limit: 1,
    });
    request(w.db, "rex", "clone", "rex-1993");
    // The DELETE lands; the voices update after it fails once.
    w.db.failNext(
      "voices",
      "update",
      (p) => p.status === "archived",
      "voices down",
    );
    if (lost) {
      w.acct.addMode = "timeout-lands";
      w.acct.lists = ["ok", "fail"]; // the inventory, then the lookup
    }
    const item = await itemOf(w.deps, "rex");
    const r = await attempt(() =>
      lib.carryOut(w.deps, item, { archiveVoiceId: "rex-old" }),
    );
    const fixed = lost
      ? reconcile
        ? await attempt(() => reconcile(w.deps, item))
        : "reconcile does not exist"
      : null;
    const old = w.db.rows("voices").find((v) => v.id === "rex-old")!;
    report(
      `round 4, finding 1 (${lost ? "reconcile" : "carryOut"}): a half-recorded archive-first DELETE is finished`,
      [
        `archive rex-old first; its DELETE lands and the voices update fails${lost ? "; the add's reply is lost" : ""}`,
        `carryOut: ${short(r)}`,
        ...(lost ? [`reconcile: ${short(fixed)}`] : []),
        `rex-old: ${String(old.status)} ${String(old.current_elevenlabs_id)}; task: ${task(w.db, "rex")}`,
      ],
      ((lost ? fixed : r) as { status?: string }).status === "done" &&
        old.status === "archived" &&
        old.current_elevenlabs_id === null &&
        task(w.db, "rex") === "in_progress",
    );
  }

  {
    const w = world({
      characters: ["rex"],
      voices: [{ id: "rex-old", name: "Rex", status: "active" }],
      limit: 2,
    });
    const row = w.db.rows("voices").find((v) => v.id === "rex-old")!;
    row.operation_claim = "archive:live";
    row.operation_claimed_at = new Date().toISOString();
    seedOp(w.db, "rex", {
      phase: "adding",
      archived: "rex-old",
      archivedElevenLabsId: "el-rex-old",
      before: [],
      name: "Rex (1993)",
    });
    const r = await recon(w.deps);
    report(
      "round 4, finding 2: reconcile waits while a run holds the voice's claim",
      [
        `rex-old is claimed by a live run (claimed just now)`,
        `reconcile: ${short(r)}`,
        `rex-old: ${String(row.status)}; task: ${task(w.db, "rex")}; adds ${w.acct.adds}`,
      ],
      short(r).includes("a run is still in progress") &&
        row.status === "active" &&
        task(w.db, "rex") === "pending (open at adding)" &&
        w.acct.adds === 0,
    );
  }

  // ── round 5 ──

  {
    const w = world({ characters: ["kit"], voices: [] });
    storedDesign(w.db, "kit", "Kit sounds bright.");
    let release = () => {};
    w.acct.gate = new Promise<void>((r) => (release = r));
    const item = await itemOf(w.deps, "kit");
    const run = attempt(() =>
      lib.carryOut(w.deps, item, { archiveVoiceId: null }),
    );
    while (w.acct.adds === 0) await new Promise((r) => setImmediate(r));
    const during = liveReconcile
      ? await attempt(() => liveReconcile(w.deps, item, { notAdded: true }))
      : "reconcile does not exist";
    release();
    const r = await run;
    report(
      "round 5, finding 2: reconcile({notAdded}) refuses while a design for a voiceless speaker is mid-add",
      [
        `kit has no voice and no task row; carryOut's add is in flight`,
        `reconcile during the add: ${short(during)}`,
        `carryOut after: ${short(r)}; task: ${task(w.db, "kit")}; creates ${w.acct.adds}`,
      ],
      short(during).includes("a run is still in progress") &&
        (r as { status?: string }).status === "done" &&
        task(w.db, "kit") === "in_progress" &&
        w.acct.adds === 1,
    );
  }

  // ── #458 ──

  {
    // Archive, then restore: the castlist holds the voice's uuid, so a
    // restored voice is picked up by every row that references it.
    const w = world({
      characters: ["rex", "kit"],
      voices: [
        {
          id: "rex-1",
          name: "Rex",
          status: "active",
          character: "rex",
          castAs: ["rex", "kit"],
        },
      ],
    });
    const castBefore = JSON.stringify(w.db.rows("castlist"));
    const before = (await slots.readVoice(w.db.client(), "rex-1"))!;
    const archived = await attempt(() =>
      slots.archiveVoice(w.deps, before, { execute: true }),
    );
    const mid = (await slots.readVoice(w.db.client(), "rex-1"))!;
    const midPlays = await plays(w.db, "rex");
    const restored = await attempt(() =>
      slots.restoreVoice(w.deps, mid, { execute: true }),
    );
    const after = await slots.readVoice(w.db.client(), "rex-1");
    const castAfter = JSON.stringify(w.db.rows("castlist"));
    const rexPlays = await plays(w.db, "rex");
    const kitPlays = await plays(w.db, "kit");
    report(
      "#458: archive then restore changes the ElevenLabs id, not the voice uuid or its castlist rows",
      [
        `before: rex-1 ${before.status} ${String(before.current_elevenlabs_id)}; castlist rex: ${cast(w.db, "rex")}, kit: ${cast(w.db, "kit")}`,
        `archive: ${short(archived)}; then ${mid.status} ${String(mid.current_elevenlabs_id)}, rex plays ${midPlays}`,
        `restore: ${short(restored)}`,
        `after: ${String(after?.id)} ${String(after?.status)} ${String(after?.current_elevenlabs_id)}; castlist unchanged: ${String(castAfter === castBefore)}; rex plays ${rexPlays}, kit plays ${kitPlays}`,
        `ElevenLabs: ${w.acct.adds} add(s), ${w.acct.deletes} delete(s)`,
      ],
      before.current_elevenlabs_id === "el-rex-1" &&
        mid.status === "archived" &&
        mid.current_elevenlabs_id === null &&
        midPlays === "none (not in a slot)" &&
        after?.id === "rex-1" &&
        after.status === "active" &&
        after.current_elevenlabs_id === "el-new-1" &&
        castAfter === castBefore &&
        rexPlays === "el-new-1" &&
        kitPlays === "el-new-1" &&
        w.acct.adds === 1 &&
        w.acct.deletes === 1,
    );
  }

  {
    // A clone request whose target is still waiting for its clip is never
    // run and takes no slot.
    const w = world({ characters: ["zed"], voices: [] });
    const waiting = randomUUID();
    storedDesign(w.db, "zed", "unused");
    const row = w.db.rows("voices").at(-1)!;
    Object.assign(row, {
      id: waiting,
      display_name: "Zed (1993)",
      description: null,
      design_prompt: null,
      appearance_id: randomUUID(),
    });
    request(w.db, "zed", "clone", waiting);
    const item = await itemOf(w.deps, "zed");
    const r = await attempt(() =>
      lib.carryOut(w.deps, item, { archiveVoiceId: null }),
    );
    report(
      "#458: a clone of a needs_clip voice is refused and takes no slot",
      [
        `plan: ${item.action} ${String(item.target?.display_name)} (${String(item.target?.status)}), needsSlot ${String(item.needsSlot)}, refusals ${item.refusals.join("; ")}`,
        `carryOut: ${short(r)}; task: ${task(w.db, "zed")}`,
        `ElevenLabs: ${w.acct.adds} add(s), ${w.acct.deletes} delete(s)`,
      ],
      item.target?.status === "needs_clip" &&
        !item.needsSlot &&
        item.refusals.some((x) => x.includes("waiting for a clip")) &&
        (r as { status?: string }).status === "refused" &&
        task(w.db, "zed") === "pending" &&
        w.acct.adds === 0 &&
        w.acct.deletes === 0,
    );
  }

  {
    // Review round 1, finding 1: two issues design one character's stored
    // row at once. The stored row's claim is taken before the add, so the
    // second run spends nothing.
    const w = world({ characters: ["kit"], voices: [] });
    storedDesign(w.db, "kit", "Kit sounds bright.");
    w.db.rows("issues").push({
      book_id: BOOK,
      id: "issue-2",
      number: 2,
      created_at: "2026-10-02T00:00:00Z",
    });
    w.db.rows("bubbles").push({
      id: "b-kit-2",
      book_id: BOOK,
      issue_id: "issue-2",
      character_id: "kit",
      speaker: "Kit",
      voice_description: "Kit sounds like a test.",
      ignored: false,
      silent: false,
    });
    const one = await itemOf(w.deps, "kit");
    const two = (await lib.planVoiceWork(w.deps, BOOK, "issue-2")).items.find(
      (i) => i.characterId === "kit",
    )!;
    let release = () => {};
    w.acct.gate = new Promise<void>((r) => (release = r));
    const aRun = attempt(() =>
      lib.carryOut(w.deps, one, { archiveVoiceId: null }),
    );
    while (w.acct.adds === 0) await new Promise((r) => setImmediate(r));
    const bRun = attempt(() =>
      lib.carryOut(w.deps, two, { archiveVoiceId: null }),
    );
    const early = await Promise.race([
      bRun,
      new Promise((r) => setTimeout(() => r("still running after 2 s"), 2000)),
    ]);
    release();
    const [a, b] = await Promise.all([aRun, bRun]);
    const kitRows = w.db.rows("voices").filter((v) => v.character_id === "kit");
    report(
      "review 1, finding 1: two issues designing one stored row make one add and one voice",
      [
        `issue-1 carryOut holds the add; issue-2 carryOut meanwhile: ${short(early)}`,
        `issue-1: ${short(a)}`,
        `issue-2: ${short(b)}; task issue-2: ${String(w.db.rows("casting_tasks").find((t) => t.issue_id === "issue-2")?.status ?? "none")}`,
        `kit voices rows: ${kitRows.length} (${kitRows.map((v) => String(v.status)).join(", ")}); ElevenLabs adds: ${w.acct.adds} (want 1)`,
      ],
      (a as { status?: string }).status === "done" &&
        (b as { status?: string }).status === "refused" &&
        short(b).includes("held by another run") &&
        w.acct.adds === 1 &&
        kitRows.length === 1 &&
        kitRows[0]!.status === "active",
    );
  }

  {
    // Review rounds 1 and 2, finding 2: two description saves race for a
    // character with no stored row. The fake runs each query whole, so the
    // two calls interleave at every await: both read none and both insert.
    // Nothing deletes the second row (a run may hold its claim); every
    // reader and the activation take the first by id.
    const w = world({ characters: ["kit"], voices: [] });
    const save = (text: string) =>
      attempt(() =>
        slots.saveDesignDescription(w.db.client(), {
          characterId: "kit",
          displayName: "Kit",
          description: text,
        }),
      );
    const [x, y] = await Promise.all([save("Kit A."), save("Kit B.")]);
    const kitRows = () =>
      w.db.rows("voices").filter((v) => v.character_id === "kit");
    const stored = kitRows();
    const read = await slots.readCharacterVoices(w.db.client(), ["kit"]);
    const first = slots.firstStoredDesign(read, "kit");
    const described = slots.designDescriptions(read).get("kit");
    const activated = await attempt(() =>
      slots.activateDesignedVoice(w.db.client(), {
        display_name: "Kit",
        current_elevenlabs_id: "el-kit",
        description: described ?? null,
        labels: null,
        source_clip_path: null,
        source_clip_md5: null,
        character_id: "kit",
        design_prompt: described ?? null,
      }),
    );
    const after = kitRows().map((v) => `${String(v.id)} ${String(v.status)}`);
    report(
      "review 2, finding 2: racing description saves leave two stored rows; readers and the activation take the first",
      [
        `saves returned ${short(x)} and ${short(y)}; kit stored rows: ${stored.length}`,
        `first stored row: ${String(first?.id)}; description read: ${String(described)}`,
        `activation: ${short(activated)}; rows after: ${after.join(", ")}`,
      ],
      stored.length === 2 &&
        first !== undefined &&
        described === first.description &&
        activated === first.id &&
        kitRows().filter((v) => v.status === "active").length === 1 &&
        kitRows().find((v) => v.status === "active")?.id === first.id &&
        kitRows().filter((v) => v.status === "needs_clip").length === 1,
    );
  }

  {
    // Review round 2, finding 1: run B plans, then run A designs and
    // activates the stored row before B reads it. B then finds no stored row
    // and takes no shared claim; it must still spend nothing. B is in a
    // second book, so A's castlist write does not give it a voice.
    const w = world({ characters: ["kit"], voices: [], limit: 3 });
    storedDesign(w.db, "kit", "Kit sounds bright.");
    const BOOK2 = "check-book-2";
    w.db.rows("issues").push({
      book_id: BOOK2,
      id: "issue-1",
      number: 1,
      created_at: "2026-10-02T00:00:00Z",
    });
    w.db.rows("bubbles").push({
      id: "b-kit-book2",
      book_id: BOOK2,
      issue_id: "issue-1",
      character_id: "kit",
      speaker: "Kit",
      voice_description: "Kit sounds like a test.",
      ignored: false,
      silent: false,
    });
    const b = (await lib.planVoiceWork(w.deps, BOOK2, "issue-1")).items.find(
      (i) => i.characterId === "kit",
    )!;
    const a = await itemOf(w.deps, "kit");
    const aDone = await attempt(() =>
      lib.carryOut(w.deps, a, { archiveVoiceId: null }),
    );
    const bDone = await attempt(() =>
      lib.carryOut(w.deps, b, { archiveVoiceId: null }),
    );
    const active = w.db
      .rows("voices")
      .filter((v) => v.character_id === "kit" && v.status === "active");
    report(
      "review 2, finding 1: a run that planned before another made the designed voice spends nothing",
      [
        `B planned: ${b.action}, hasDescription ${String(b.hasDescription)}; then A: ${short(aDone)}`,
        `B: ${short(bDone)}`,
        `kit active rows: ${active.length}; ElevenLabs adds: ${w.acct.adds} (want 1)`,
      ],
      (aDone as { status?: string }).status === "done" &&
        (bDone as { status?: string }).status === "refused" &&
        short(bDone).includes("already an active designed voice") &&
        w.acct.adds === 1 &&
        active.length === 1,
    );
  }

  const failed = results.filter((r) => !r.pass);
  console.log(
    `\ncarryOut cases: ${results.length - failed.length} of ${results.length} pass; fakes only, no network, no production row`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

if (args.check) await checkCarryOut();
else await planOrCarryOut();
