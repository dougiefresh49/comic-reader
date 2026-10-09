"use client";

import { ISSUE_ID, issueState } from "../model";
import { Chip, Context, Cover, Heading, IdLine, btn } from "../ui";
import {
  Back,
  CARD_META,
  CARD_NAME,
  CARD_OFF,
  Note,
  PlusCircle,
  SelDot,
  Spacer,
  card,
  cardNew,
  type Flow,
  type StepView,
} from "./shared";

/** D, D2: which issue. One with pages, or in the pipeline, is not pickable. */
export function issueStep(f: Flow): StepView | null {
  const { book, bookIssues, existingIssue, next, number } = f;
  if (!book) return null;
  const newNumber = existingIssue ? next : number;
  const body = (
    <>
      <Context cover={book.cover} title={book.name} ids={[book.id]} />
      <Heading
        title="Which issue?"
        sub={
          bookIssues.length > 0
            ? "An issue with pages is not picked here."
            : "No issues yet."
        }
      />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
        {bookIssues.map((iss) => {
          const state = issueState(iss);
          const pickable = state === "empty";
          const selected = pickable && iss.number === number;
          const inner = (
            <>
              {selected && <SelDot />}
              <Cover
                src={iss.cover}
                title={`Issue ${iss.number}`}
                className={`aspect-[2/2.6] w-full ${pickable ? "" : "grayscale-[.6]"}`}
              />
              <span className={CARD_NAME}>Issue {iss.number}</span>
              <span className={CARD_META}>
                {state === "empty" ? (
                  <Chip tone="none">no pages</Chip>
                ) : state === "unfinished" ? (
                  <Chip tone="warn">
                    {iss.storedPages} pages stored · unfinished
                  </Chip>
                ) : state === "pipeline" ? (
                  <Chip tone="run">in pipeline</Chip>
                ) : (
                  <Chip tone="ok">
                    {Math.max(iss.pageCount, iss.storedPages)} pages
                  </Chip>
                )}
              </span>
            </>
          );
          return pickable ? (
            <button
              key={iss.id}
              type="button"
              onClick={() => f.pickIssue(iss.number)}
              className={card(selected)}
            >
              {inner}
            </button>
          ) : (
            <div key={iss.id} className={CARD_OFF}>
              {inner}
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => f.pickIssue(newNumber)}
          className={cardNew(!existingIssue)}
        >
          {!existingIssue && <SelDot />}
          <PlusCircle />
          Issue {newNumber}
          <Chip tone="none">{newNumber === next ? "next · new" : "new"}</Chip>
        </button>
      </div>
      <IdLine
        key={`${book.id}/${number}`}
        label={`Issue ${number}`}
        prefix={`${book.id} /`}
        value={f.issueId}
        hint="issue-, then a number"
        validate={f.issueIdProblem}
        onKeep={(id) => f.pickIssue(Number(ISSUE_ID.exec(id)![1]))}
      />
    </>
  );
  const footer = (
    <>
      <Back f={f} to={f.bookChoice === "new" ? "newBook" : "book"} />
      <Note>Nothing is saved until Confirm.</Note>
      <Spacer />
      <button
        type="button"
        onClick={() => f.setStep("pages")}
        className={btn("primary")}
      >
        Next: Pages →
      </button>
    </>
  );
  return { body, footer };
}
