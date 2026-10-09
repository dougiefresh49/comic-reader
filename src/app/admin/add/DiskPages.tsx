"use client";

import { useRef, useState } from "react";
import { MONO, btn } from "./ui";

export interface DiskFile {
  file: File;
  /** An object URL for the thumbnail; the owner revokes it. */
  url: string;
}

/**
 * From my computer (#793 states G1, G2): a drop zone, then thumbnails in
 * filename order with remove and Add more. Nothing uploads here; the files
 * wait for Confirm.
 */
export function DiskPages({
  files,
  skipped,
  onAdd,
  onRemove,
}: {
  files: DiskFile[];
  /** How many of the last added files were not JPEG, PNG or WebP. */
  skipped: number;
  onAdd: (list: FileList | null) => void;
  onRemove: (index: number) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const picker = (
    <input
      ref={input}
      type="file"
      multiple
      accept="image/jpeg,image/png,image/webp"
      className="hidden"
      onChange={(e) => {
        onAdd(e.target.files);
        e.target.value = "";
      }}
    />
  );
  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      onAdd(e.dataTransfer.files);
    },
  };
  const skippedLine = skipped > 0 && (
    <p className="mt-2.5 text-[12.5px] text-amber-400">
      Skipped {skipped}: not JPEG, PNG or WebP.
    </p>
  );

  if (files.length === 0) {
    return (
      <>
        <button
          type="button"
          onClick={() => input.current?.click()}
          {...dropProps}
          className={`flex min-h-[220px] w-full max-w-[860px] flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed text-neutral-400 ${over ? "border-emerald-400" : "border-neutral-700"}`}
        >
          <span className="text-base font-semibold text-neutral-100">
            Drop page images here
          </span>
          <span>
            or{" "}
            <span className="text-emerald-400 underline decoration-dotted">
              choose files
            </span>
          </span>
          <span className="text-xs text-neutral-500">
            JPEG, PNG or WebP · sorted by filename
          </span>
        </button>
        {picker}
        {skippedLine}
      </>
    );
  }

  const first = files[0]!.file.name;
  const last = files[files.length - 1]!.file.name;
  return (
    <div
      {...dropProps}
      className={`rounded-xl ${over ? "outline-2 outline-offset-4 outline-emerald-400 outline-dashed" : ""}`}
    >
      <div className="mb-3 flex items-center gap-3">
        <b className="text-[15px] font-semibold">
          {files.length} {files.length === 1 ? "file" : "files"}
        </b>
        <span className={`${MONO} text-neutral-500`}>
          {files.length === 1 ? first : `${first} → ${last}`}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => input.current?.click()}
          className={btn("default", "sm")}
        >
          Add more
        </button>
        {picker}
      </div>
      {skippedLine}
      <ol className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2.5">
        {files.map((f, i) => (
          <li key={f.url} className="group relative flex flex-col gap-[3px]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={f.url}
              alt={f.file.name}
              className="aspect-[2/3] w-full rounded-md bg-neutral-950 object-cover"
            />
            <span className="absolute top-[5px] left-[5px] rounded bg-black/55 px-[5px] py-px font-mono text-[10px] font-semibold text-white">
              {i + 1}
            </span>
            <span className="truncate font-mono text-[10.5px] text-neutral-500">
              {f.file.name}
            </span>
            <button
              type="button"
              onClick={() => onRemove(i)}
              title="Remove"
              aria-label={`Remove ${f.file.name}`}
              className="absolute top-1 right-1 grid h-[18px] w-[18px] place-items-center rounded-[5px] bg-black/60 text-[11px] text-white opacity-0 group-hover:opacity-100 hover:bg-red-700 focus-visible:opacity-100"
            >
              ×
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
