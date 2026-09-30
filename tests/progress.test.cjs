"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createBatchProgress, applyProgress, finishProgress, confirmProgress } = require("../worktime-progress.cjs");
const dates = ["2020-01-06", "2020-01-07", "2020-01-08"];
const owner = { name: "测试甲", employeeNo: "TEST001" };
function create(mode = "submit") { return createBatchProgress("test-run", owner, mode, dates); }
function event(batch, date, stage, error) { applyProgress(batch, { runId: "test-run", date, stage, error }); }

test("progress distinguishes checked from submitted and confirms only synced OA records", () => {
  const batch = create();
  event(batch, dates[0], "checking");
  assert.equal(batch.percent, 0);
  event(batch, dates[0], "submitting");
  event(batch, dates[0], "submitted_pending");
  event(batch, dates[1], "skipped");
  event(batch, dates[2], "submitted_pending");
  finishProgress(batch, "completed");
  assert.equal(batch.percent, 100);
  assert.equal(batch.days[0].status, "submitted_pending");
  confirmProgress(batch, [{ workDate: dates[0], requestId: "", status: "已提交·同步中" }]);
  assert.equal(batch.days[0].status, "submitted_pending");
  confirmProgress(batch, [{ workDate: dates[0], requestId: "123", status: "2-归档" }]);
  assert.equal(batch.days[0].status, "confirmed");
});

test("preview, skipped dates, and partial failure retain accurate counts and untouched later dates", () => {
  const batch = create("preview");
  event(batch, dates[0], "preview_passed");
  event(batch, dates[1], "checking");
  event(batch, dates[1], "failed", "日期校验失败");
  finishProgress(batch, "failed", "日期校验失败");
  assert.deepEqual(batch.days.map((day) => day.status), ["preview_passed", "failed", "unprocessed"]);
  assert.equal(batch.percent, 66);
  assert.equal(batch.days[1].error, "日期校验失败");
  const skipped = create();
  dates.forEach((date) => event(skipped, date, "skipped"));
  finishProgress(skipped, "completed");
  assert.equal(skipped.completed, 3);
});

test("timeout while submitting is unknown and late or wrong-run events cannot overwrite it", () => {
  const batch = create();
  event(batch, dates[0], "submitted_pending");
  event(batch, dates[1], "submitting");
  finishProgress(batch, "timed_out", "操作超时");
  event(batch, dates[1], "submitted_pending");
  finishProgress(batch, "completed", null, { submittedDates: dates });
  assert.deepEqual(batch.days.map((day) => day.status), ["submitted_pending", "unknown", "unprocessed"]);
  assert.equal(batch.status, "timed_out");
  const other = create();
  applyProgress(other, { runId: "another-run", date: dates[0], stage: "submitted_pending" });
  event(other, "2099-01-01", "submitted_pending");
  assert.equal(other.percent, 0);
});

test("a submission error is conservatively kept for reconciliation, and initial failure names no date", () => {
  const batch = create();
  event(batch, dates[0], "submitting");
  event(batch, dates[0], "failed", "响应无法确认");
  finishProgress(batch, "failed", "响应无法确认");
  assert.equal(batch.days[0].status, "unknown");
  const initial = create();
  finishProgress(initial, "failed", "登录过期");
  assert.ok(initial.days.every((day) => day.status === "unprocessed"));
  assert.equal(initial.completed, 0);
});
