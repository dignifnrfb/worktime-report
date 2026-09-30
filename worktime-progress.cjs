"use strict";

const PREFIX = "WORKTIME_PROGRESS:";
const DAY_STATES = new Set(["loading", "checking", "submitting", "preview_passed", "skipped", "submitted_pending", "failed", "unknown"]);
const FINISHED = new Set(["preview_passed", "skipped", "submitted_pending", "confirmed", "failed", "unknown"]);

function createBatchProgress(runId, account, mode, dates) {
  return { runId, account, mode, status: "running", total: dates.length, completed: 0, percent: 0,
    currentDate: null, stage: "starting", startedAt: new Date().toISOString(), finishedAt: null, error: null,
    days: dates.map((date) => ({ date, status: "waiting", error: null })) };
}

function recalculate(batch) {
  batch.completed = batch.days.filter((day) => FINISHED.has(day.status)).length;
  batch.percent = batch.total ? Math.floor(batch.completed / batch.total * 100) : 0;
}

function applyProgress(batch, event) {
  if (batch.status !== "running" || event.runId !== batch.runId || !DAY_STATES.has(event.stage)) return;
  const day = batch.days.find((item) => item.date === event.date);
  if (!day || FINISHED.has(day.status)) return;
  day.status = event.stage === "failed" && day.status === "submitting" ? "unknown" : event.stage;
  day.error = typeof event.error === "string" ? event.error.slice(0, 1000) : null;
  batch.currentDate = day.date;
  batch.stage = day.status;
  recalculate(batch);
}

function finishProgress(batch, status, error = null, result = null) {
  if (batch.status !== "running") return;
  for (const day of batch.days) {
    if (result?.skippedDates?.includes(day.date)) day.status = "skipped";
    else if (result?.submittedDates?.includes(day.date)) day.status = "submitted_pending";
    else if (batch.mode === "preview" && result?.processedDates?.includes(day.date)) day.status = "preview_passed";
    if (["loading", "checking", "submitting"].includes(day.status)) {
      day.status = day.status === "submitting" ? "unknown" : "failed";
      day.error = error || "处理结果未能确认。";
    } else if (day.status === "waiting") day.status = "unprocessed";
  }
  batch.status = status;
  batch.error = error;
  batch.stage = status === "completed" ? "finished" : "stopped";
  batch.finishedAt = new Date().toISOString();
  recalculate(batch);
}

function confirmProgress(batch, records) {
  if (!batch) return;
  for (const day of batch.days) {
    if (["submitted_pending", "unknown"].includes(day.status) && records.some((record) =>
      record.workDate === day.date && !record.status.includes("同步中") && record.requestId)) day.status = "confirmed";
  }
  recalculate(batch);
}

function emitProgress(date, stage, error) {
  console.log(PREFIX + JSON.stringify({ runId: process.env.WORKTIME_RUN_ID || "cli", date, stage, ...(error ? { error } : {}) }));
}

module.exports = { PREFIX, createBatchProgress, applyProgress, finishProgress, confirmProgress, emitProgress };
