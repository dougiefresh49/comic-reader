"use client";

/**
 * The Add content flow's visual pieces (#793), after the fable-5.1 mockup on
 * #791: the step rail, cards with covers, chips, the derived-id line and the
 * rows Confirm writes.
 */
import { useState, type ReactNode } from "react";

type BtnVariant = "default" | "primary" | "ghost";

/** Button classes; `disabled` dims it and drops pointer input. */
export function btn(variant: BtnVariant = "default", size: "md" | "sm" = "md") {
  const base =
    "inline-flex items-center gap-1.5 whitespace-nowrap border font-medium leading-tight transition-colors disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400";
  const sizes = {
    md: "rounded-[7px] px-3 py-[7px] text-sm",
    sm: "rounded-md px-[9px] py-1 text-xs",
  };
  const variants = {
    default:
      "border-neutral-700 bg-neutral-800 text-neutral-100 hover:bg-neutral-700",
    primary:
      "border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-600",
    ghost:
      "border-transparent bg-transparent text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100",
  };
  return `${base} ${sizes[size]} ${variants[variant]}`;
}

export const FIELD =
  "rounded-lg border border-neutral-700 bg-neutral-800 px-[11px] py-2 text-[13px] text-neutral-100 placeholder:text-neutral-500 focus:border-emerald-400 focus:outline-none";

export const MONO = "font-mono text-xs";

// ─── Icons ───────────────────────────────────────────────────────────────────

export function CheckIcon({
  className = "h-3.5 w-3.5",
}: {
  className?: string;
}) {
  return (
    <svg
      aria-hidden
      className={`inline-block flex-none ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
    >
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

export function PlusIcon({
  className = "h-3.5 w-3.5",
}: {
  className?: string;
}) {
  return (
    <svg
      aria-hidden
      className={`inline-block flex-none ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function GlobeIcon({ className }: { className: string }) {
  return (
    <svg
      aria-hidden
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
    </svg>
  );
}

export function DiskIcon({ className }: { className: string }) {
  return (
    <svg
      aria-hidden
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3M12 4v11M7 10l5 5 5-5" />
    </svg>
  );
}

export function PlayIcon({ className }: { className: string }) {
  return (
    <svg
      aria-hidden
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M7 5v14l12-7z" />
    </svg>
  );
}

export function HomeIcon({ className }: { className: string }) {
  return (
    <svg
      aria-hidden
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-neutral-400 border-r-transparent"
    />
  );
}

// ─── Covers and chips ────────────────────────────────────────────────────────

/**
 * A cover or page image; a gradient with the title when there is none or it
 * fails to load. The parent sets the size.
 */
export function Cover({
  src,
  title,
  className = "",
  label = true,
}: {
  src: string | null;
  title: string;
  className?: string;
  /** Show the title on the fallback. */
  label?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={title}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={`bg-neutral-950 object-cover ${className}`}
      />
    );
  }
  return (
    <div
      role="img"
      aria-label={title}
      className={`relative flex items-end overflow-hidden p-[9px] text-[13px] leading-tight font-bold text-white ${className}`}
      style={{ background: "linear-gradient(155deg,#5a5a5a,#2a2a2a)" }}
    >
      <span
        aria-hidden
        className="absolute inset-0 bg-gradient-to-t from-black/65 to-transparent to-55%"
      />
      {label && (
        <span className="relative line-clamp-3 [text-shadow:0_1px_3px_rgba(0,0,0,.8)]">
          {title}
        </span>
      )}
    </div>
  );
}

export type ChipTone =
  | "plain"
  | "ok"
  | "run"
  | "none"
  | "warn"
  | "bad"
  | "site";

export function Chip({
  tone = "plain",
  children,
}: {
  tone?: ChipTone;
  children: ReactNode;
}) {
  const tones: Record<ChipTone, string> = {
    plain: "bg-[#303030] text-neutral-400",
    ok: "bg-[#06281e] text-emerald-400",
    run: "bg-[#1b2a40] text-[#7cb8f0]",
    none: "bg-[#303030] text-neutral-500",
    warn: "bg-[#2e2108] text-amber-400",
    bad: "bg-[#2f0f0f] text-red-300",
    site: "bg-[#0f2d32] text-cyan-300",
  };
  return (
    <span
      className={`inline-flex items-center gap-[5px] rounded-[5px] px-[7px] py-px text-[11px] font-semibold whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

// ─── The step rail ───────────────────────────────────────────────────────────

export interface RailStep {
  key: string;
  label: string;
  value?: ReactNode;
  state: "todo" | "done" | "on";
  /** Set on a done step that can be revisited. */
  onClick?: () => void;
}

export function Rail({ steps }: { steps: RailStep[] }) {
  return (
    <nav
      aria-label="Steps"
      className="mx-auto flex w-full max-w-[1100px] gap-1.5 px-[22px] pt-3"
    >
      {steps.map((s) => {
        const tone =
          s.state === "on"
            ? "border-emerald-400 bg-neutral-900 text-emerald-400"
            : s.state === "done"
              ? "border-emerald-700 text-neutral-400"
              : "border-neutral-700 text-neutral-500";
        const inner = (
          <>
            <span className="text-[11px] font-semibold tracking-[.08em] uppercase">
              {s.label}
            </span>
            <span
              className={`flex max-w-[220px] items-center gap-1.5 truncate text-[12.5px] ${s.state === "todo" ? "" : "text-neutral-100"}`}
            >
              {s.value ?? " "}
            </span>
          </>
        );
        const cls = `flex min-w-[110px] flex-col gap-px rounded-t-lg border-b-2 px-3 py-2 text-left sm:min-w-[140px] ${tone}`;
        return s.onClick ? (
          <button
            key={s.key}
            type="button"
            onClick={s.onClick}
            className={`${cls} hover:bg-neutral-900 hover:text-neutral-100`}
          >
            {inner}
          </button>
        ) : (
          <span
            key={s.key}
            className={cls}
            aria-current={s.state === "on" ? "step" : undefined}
          >
            {inner}
          </span>
        );
      })}
    </nav>
  );
}

// ─── Panel pieces ────────────────────────────────────────────────────────────

/** The book (and issue) the step is about, above the step's heading. */
export function Context({
  cover,
  title,
  ids,
}: {
  cover: string | null;
  title: string;
  ids: string[];
}) {
  return (
    <div className="-mt-1 mb-[18px] flex items-center gap-3 border-b border-[#2a2a2a] pb-3.5">
      <Cover
        src={cover}
        title={title}
        label={false}
        className="h-14 w-[38px] flex-none rounded-[5px]"
      />
      <div>
        <div className="text-[15px] font-semibold">{title}</div>
        <div className="flex gap-1 text-neutral-400">
          {ids.map((id) => (
            <span key={id} className={MONO}>
              {id}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Heading({ title, sub }: { title: string; sub?: string }) {
  return (
    <>
      <h2 className={`text-[19px] font-semibold ${sub ? "mb-1" : "mb-4"}`}>
        {title}
      </h2>
      {sub && <p className="mb-4 text-neutral-400">{sub}</p>}
    </>
  );
}

/**
 * A derived id, shown small, with `edit` on request. Keep stores the edit
 * when `validate` returns null; otherwise its message shows beside the box.
 */
export function IdLine({
  label,
  prefix,
  value,
  hint,
  validate,
  onKeep,
}: {
  label: string;
  /** Shown before the id and not edited, e.g. `book /`. */
  prefix?: string;
  value: string;
  hint: string;
  validate: (draft: string) => string | null;
  onKeep: (next: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    const current = validate(value);
    return (
      <div className="mt-4 flex items-center gap-2 text-xs text-neutral-500">
        <span>{label}</span>
        <span
          className={`${MONO} rounded-[5px] border border-[#2a2a2a] bg-neutral-800 px-[7px] py-0.5 text-neutral-400`}
        >
          {prefix ? `${prefix} ${value}` : value}
        </span>
        <button
          type="button"
          onClick={() => setDraft(value)}
          className="text-neutral-500 underline decoration-dotted hover:text-neutral-100"
        >
          edit
        </button>
        {current && <span className="text-amber-400">{current}</span>}
      </div>
    );
  }
  const problem = validate(draft.trim());
  const keep = () => {
    if (problem) return;
    onKeep(draft.trim());
    setDraft(null);
  };
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <span className="text-xs text-neutral-500">{label}</span>
      {prefix && <span className={`${MONO} text-neutral-500`}>{prefix}</span>}
      <input
        autoFocus
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") keep();
          if (e.key === "Escape") setDraft(null);
        }}
        className={`${FIELD} w-[260px] font-mono`}
      />
      <button
        type="button"
        onClick={keep}
        disabled={problem !== null}
        className={btn("primary", "sm")}
      >
        Keep
      </button>
      <button
        type="button"
        onClick={() => setDraft(null)}
        className={btn("ghost", "sm")}
      >
        Cancel
      </button>
      <span
        className={`text-xs ${problem && draft.trim() !== value ? "text-amber-400" : "text-neutral-500"}`}
      >
        {problem && draft.trim() !== value ? problem : hint}
      </span>
    </div>
  );
}

/** One row of what Confirm writes, or of what Saving has written. */
export function WriteRow({
  k,
  title,
  children,
  pic,
}: {
  k: string;
  title: ReactNode;
  children?: ReactNode;
  pic?: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[90px_1fr_auto] items-center gap-3.5 border-b border-[#2a2a2a] px-4 py-3.5 last:border-b-0 sm:grid-cols-[110px_1fr_auto]">
      <span className="text-[11px] font-semibold tracking-[.08em] text-neutral-500 uppercase">
        {k}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-semibold">{title}</span>
        {children && (
          <span className="flex flex-wrap items-center gap-2 text-[12.5px] text-neutral-400">
            {children}
          </span>
        )}
      </div>
      <div className="w-10">{pic}</div>
    </li>
  );
}

export function WriteList({ children }: { children: ReactNode }) {
  return (
    <ul className="max-w-[860px] overflow-hidden rounded-[11px] border border-neutral-700 bg-neutral-800">
      {children}
    </ul>
  );
}

/** A big choice card (the Pages step and What next). */
export function Choice({
  icon,
  title,
  sub,
  onClick,
  href,
  warn = false,
  disabled = false,
}: {
  icon: ReactNode;
  title: string;
  sub: string;
  onClick?: () => void;
  href?: string;
  warn?: boolean;
  disabled?: boolean;
}) {
  const cls = `flex min-h-[120px] flex-col gap-1.5 rounded-xl border border-neutral-700 bg-neutral-800 px-5 py-[22px] text-left transition ${
    disabled
      ? "cursor-not-allowed opacity-45"
      : `hover:-translate-y-px ${warn ? "hover:border-amber-400" : "hover:border-emerald-400"}`
  } ${warn ? "text-amber-400" : "text-emerald-400"}`;
  const body = (
    <>
      {icon}
      <span className="text-base font-semibold text-neutral-100">{title}</span>
      <span className="text-[12.5px] text-neutral-400">{sub}</span>
    </>
  );
  if (href) {
    return (
      <a href={href} className={cls}>
        {body}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={cls}>
      {body}
    </button>
  );
}
