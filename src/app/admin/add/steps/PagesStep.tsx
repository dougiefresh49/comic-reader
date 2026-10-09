"use client";

import { DiskPages } from "../DiskPages";
import { Choice, DiskIcon, GlobeIcon, Heading, btn } from "../ui";
import { Back, Note, Spacer, type Flow, type StepView } from "./shared";

/** E: pages, two ways, or none yet. */
export function pagesStep(f: Flow): StepView | null {
  const { book } = f;
  if (!book) return null;
  const body = (
    <>
      {f.issueContext}
      <Heading title="Pages" sub="Where are they?" />
      <div className="grid max-w-[760px] grid-cols-1 gap-3.5 sm:grid-cols-2">
        <Choice
          icon={<GlobeIcon className="mb-1.5 h-[26px] w-[26px]" />}
          title="Find online"
          sub="Searches the open web for this issue"
          onClick={f.openOnline}
        />
        <Choice
          icon={<DiskIcon className="mb-1.5 h-[26px] w-[26px]" />}
          title="From my computer"
          sub="JPEG, PNG or WebP, in filename order"
          onClick={() => f.setStep("disk")}
        />
      </div>
      {(book.isNew || f.issueIsNew) && (
        <div className="mt-3.5">
          <button
            type="button"
            onClick={() => {
              f.setPages({ kind: "none" });
              f.setStep("confirm");
            }}
            className={btn("ghost")}
          >
            Save without pages →
          </button>
        </div>
      )}
    </>
  );
  const footer = (
    <>
      <Back f={f} to="issue" />
      <Note>Nothing is saved until Confirm.</Note>
      <Spacer />
    </>
  );
  return { body, footer };
}

/**
 * F0–F4 frame: the heading and footer. The search itself (`SourceConfirm`)
 * stays mounted in the shell, so Back from Confirm finds the same result.
 */
export function onlineStep(f: Flow): StepView {
  const { checked } = f;
  const body = (
    <>
      {f.issueContext}
      <Heading title="Find online" />
    </>
  );
  const footer = (
    <>
      <Back f={f} to="pages" />
      <Note>Nothing downloads until Confirm.</Note>
      <Spacer />
      <button
        type="button"
        onClick={() => f.setStep("disk")}
        className={btn("ghost")}
      >
        From my computer instead
      </button>
      <button
        type="button"
        disabled={!checked}
        onClick={() => {
          if (!checked) return;
          f.setPages({ kind: "online", source: checked });
          f.setStep("confirm");
        }}
        className={btn("primary")}
      >
        {checked ? `Use these ${checked.pageCount} pages →` : "Use these pages"}
      </button>
    </>
  );
  return { body, footer };
}

/** G1, G2: from my computer. */
export function diskStep(f: Flow): StepView {
  const { files } = f;
  const body = (
    <>
      {f.issueContext}
      <Heading title="From my computer" />
      <DiskPages
        files={files}
        skipped={f.skipped}
        onAdd={f.addFiles}
        onRemove={f.removeFile}
      />
    </>
  );
  const footer = (
    <>
      <Back f={f} to="pages" />
      <Note>Nothing uploads until Confirm.</Note>
      <Spacer />
      <button type="button" onClick={f.openOnline} className={btn("ghost")}>
        Find online instead
      </button>
      <button
        type="button"
        disabled={files.length === 0}
        onClick={() => {
          f.setPages({ kind: "disk" });
          f.setStep("confirm");
        }}
        className={btn("primary")}
      >
        {files.length > 0
          ? `Use these ${files.length} pages →`
          : "Use these pages"}
      </button>
    </>
  );
  return { body, footer };
}
