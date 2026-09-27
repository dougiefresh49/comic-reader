/**
 * Fixture-only acceptance for vision row mappers (#70).
 * No DB calls and no network calls.
 *
 * Usage: pnpm tsx --env-file=.env scripts/check-vision-rows.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  mapBubbleRows,
  mapPanelRows,
  mapSegmentationRow,
  type RoboflowBoxPrediction,
  type RoboflowSegPrediction,
} from "~/workflows/steps/vision-rows";

type Fixture = {
  panel_predictions: {
    image: { width: number; height: number };
    predictions: RoboflowBoxPrediction[];
  };
  bubble_predictions: {
    predictions: RoboflowBoxPrediction[];
  };
  segmentation_predictions: {
    predictions: RoboflowSegPrediction[];
  };
};

const fixturePath = resolve("fixtures/vision/roboflow-issue1-p03.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

const bookId = "tmnt-mmpr-iii";
const issueId = "issue-1";
const pageNumber = 3;
const imgDims = fixture.panel_predictions.image;

const panelRows = mapPanelRows(
  bookId,
  issueId,
  pageNumber,
  fixture.panel_predictions.predictions,
  imgDims,
);
const bubbleRows = mapBubbleRows(
  bookId,
  issueId,
  pageNumber,
  fixture.bubble_predictions.predictions,
);
const segRow = mapSegmentationRow(
  bookId,
  issueId,
  pageNumber,
  imgDims,
  fixture.segmentation_predictions.predictions,
);

console.log(`panels: ${panelRows.length}`);
for (const row of panelRows) {
  console.log(
    `  ${row.panel_id} source=${row.source as string} sort_order=${row.sort_order}`,
  );
}

console.log(`bubbles: ${bubbleRows.length}`);
for (const row of bubbleRows) {
  console.log(
    `  ${row.legacy_id as string} sort_order=${row.sort_order} box_2d.keys=${Object.keys((row.box_2d as object) ?? {}).join(",")}`,
  );
}

console.log(
  `segmentation: 1 row page_number=${segRow.page_number} preds=${Array.isArray(segRow.predictions) ? segRow.predictions.length : "?"}`,
);

const expectedIds = [
  "p03-01",
  "p03-02",
  "p03-03",
  "p03-04",
  "p03-05",
  "p03-06",
];
const actualIds = panelRows.map((r) => r.panel_id);
if (panelRows.length !== 6) {
  console.error(`expected 6 panel rows, got ${panelRows.length}`);
  process.exit(1);
}
for (let i = 0; i < expectedIds.length; i++) {
  if (actualIds[i] !== expectedIds[i]) {
    console.error(
      `panel id mismatch at ${i}: ${actualIds[i]} != ${expectedIds[i]}`,
    );
    process.exit(1);
  }
  if (panelRows[i]!.source !== "roboflow") {
    console.error(`panel ${actualIds[i]} source is not roboflow`);
    process.exit(1);
  }
}

if (bubbleRows.length === 0) {
  console.error("expected bubble rows");
  process.exit(1);
}
for (const row of bubbleRows) {
  if (typeof row.sort_order !== "number") {
    console.error(`bubble ${row.legacy_id as string} missing sort_order`);
    process.exit(1);
  }
}

const rows: object[] = [...panelRows, ...bubbleRows, segRow];
for (const row of rows) {
  if (Object.prototype.hasOwnProperty.call(row, "confidence")) {
    console.error("row has top-level confidence key:", row);
    process.exit(1);
  }
}

console.log("ok");
