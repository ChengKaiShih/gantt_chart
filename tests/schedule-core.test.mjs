import test from "node:test";
import assert from "node:assert/strict";
import {
  computeCPM,
  deriveSummaryDates,
  inclusiveDuration,
} from "../dist/schedule-core.js";

test("工期以起訖日期均計入的日曆日計算", () => {
  assert.equal(inclusiveDuration("2026-01-01", "2026-01-01"), 1);
  assert.equal(inclusiveDuration("2026-01-01", "2026-01-10"), 10);
});

test("上階工項彙整下階工項日期", () => {
  const result = deriveSummaryDates([
    { id: "p", level: 0, start: "", finish: "" },
    { id: "a", level: 1, start: "2026-02-01", finish: "2026-02-10" },
    { id: "b", level: 1, start: "2026-01-20", finish: "2026-03-01" },
  ]);
  assert.equal(result[0].start, "2026-01-20");
  assert.equal(result[0].finish, "2026-03-01");
});

test("FS網圖找出最長路徑與浮時", () => {
  const result = computeCPM([
    { id: "a", level: 0, start: "2026-01-01", finish: "2026-01-10", predecessors: [] },
    { id: "b", level: 0, start: "2026-01-11", finish: "2026-01-30", predecessors: [{ taskId: "a", type: "FS", lag: 0 }] },
    { id: "c", level: 0, start: "2026-01-01", finish: "2026-01-05", predecessors: [] },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.projectDuration, 30);
  assert.equal(result.metrics.get("a").critical, true);
  assert.equal(result.metrics.get("b").critical, true);
  assert.equal(result.metrics.get("c").totalFloat, 25);
});

test("循環關係會被拒絕", () => {
  const result = computeCPM([
    { id: "a", level: 0, start: "2026-01-01", finish: "2026-01-03", predecessors: [{ taskId: "b", type: "FS", lag: 0 }] },
    { id: "b", level: 0, start: "2026-01-04", finish: "2026-01-06", predecessors: [{ taskId: "a", type: "FS", lag: 0 }] },
  ]);
  assert.equal(result.ok, false);
});
