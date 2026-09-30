"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test, after } = require("node:test");
const { temporaryDirectory, removeTemporary } = require("./test-support.cjs");

const directory = temporaryDirectory("log");
process.env.WORKTIME_DATA_ROOT = directory;
process.env.WORKTIME_LOG_LEVEL = "debug";
const common = require("../worktime-common.cjs");
const log = require("../worktime-log.cjs");
after(() => removeTemporary(directory));

test("temporary diagnostics expire and omit URL credentials, parameters and raw failures", () => {
  const flag = path.join(directory, "temporary-diagnostics.json");
  assert.equal(log.diagnosticEnabled(), false);
  fs.writeFileSync(flag, JSON.stringify({ enabled: true, expiresAt: new Date(Date.now() + 60000).toISOString() }));
  log.resetLoggerForTests({ runId: "temporary-detail" });
  log.diagnostic("probe", {
    endpoint: log.diagnosticUrl("https://user:password@oa.test/api/check?token=secret#private"),
    failure: log.diagnosticFailure(new Error("net::ERR_CONNECTION_RESET https://oa.test/?token=secret")),
  });
  const record = log.readTodayRecords().find((item) => item.runId === "temporary-detail");
  assert.equal(record.data.endpoint, "https://oa.test/api/check");
  assert.deepEqual(record.data.failure.codes, ["ERR_CONNECTION_RESET"]);
  assert.doesNotMatch(JSON.stringify(record), /password|secret|private|user:/);
  fs.writeFileSync(flag, JSON.stringify({ enabled: true, expiresAt: "2000-01-01T00:00:00Z" }));
  assert.equal(log.diagnosticEnabled(), false);
  log.diagnostic("expired", {});
  assert.equal(log.readTodayRecords().filter((item) => item.runId === "temporary-detail").length, 1);
  fs.unlinkSync(flag);
});

test("structured records go to daily jsonl and warn copies to the error file", () => {
  log.resetLoggerForTests({ runId: "run-fill", proc: "assistant", cmd: "batch-submit" });
  log.info("fill", "submit.day.ok", "已提交 2020-01-06", {
    date: "2020-01-06", workType: "展会", projectCode: "TEST-P001", hours: "8.0", documentNo: "GSTB-TEST-001",
  }, { durationMs: 1200 });
  log.warn("sync", "api.fallback", "回退页面同步", { kind: "list" });
  const records = log.readTodayRecords().filter((item) => item.runId === "run-fill");
  const errors = log.readTodayRecords("error").filter((item) => item.runId === "run-fill");
  assert.equal(records[0].proc, "assistant");
  assert.equal(records[0].cmd, "batch-submit");
  assert.equal(records[0].event, "submit.day.ok");
  assert.equal(records[0].data.date, "2020-01-06");
  assert.equal(records[0].durationMs, 1200);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].event, "api.fallback");
  assert.ok(fs.existsSync(path.join(common.LOG_ROOT, `app.${common.todayIso()}.jsonl`)));
});

test("sensitive fields and login tokens are stripped before writing", () => {
  log.resetLoggerForTests({ runId: "run-safe" });
  log.info("session", "login.ok", "should not leak", {
    cookie: "secret",
    authorization: "Bearer abc",
    em_auth_code: "leak",
    url: "https://oa.example/login?em_auth_code=ABC123&next=1",
    account: { name: "测试甲", employeeNo: "TEST001" },
  });
  const [record] = log.readTodayRecords().filter((item) => item.runId === "run-safe");
  assert.equal(record.data.account.employeeNo, "TEST001");
  assert.equal(record.data.cookie, undefined);
  assert.equal(record.data.authorization, undefined);
  assert.equal(record.data.em_auth_code, undefined);
  assert.match(record.data.url, /em_auth_code=\*/);
  assert.doesNotMatch(JSON.stringify(record), /ABC123|Bearer abc|secret/);
});

test("session status only logs waiting once until the state changes", () => {
  log.resetLoggerForTests({ runId: "run-session" });
  log.logSessionChange({ state: "waiting", message: "请扫码" });
  log.logSessionChange({ state: "waiting", message: "请扫码", qrVersion: 2 });
  log.logSessionChange({ state: "confirming", message: "已扫码" });
  const events = log.readTodayRecords().filter((item) => item.runId === "run-session").map((item) => item.event);
  assert.deepEqual(events, ["login.waiting", "login.confirming"]);
});

test("old daily files are pruned and diagnostic zip stays local-only", () => {
  log.resetLoggerForTests({ runId: "run-zip" });
  fs.mkdirSync(common.LOG_ROOT, { recursive: true });
  fs.writeFileSync(path.join(common.LOG_ROOT, "app.2020-01-01.jsonl"), "{\"old\":true}\n");
  fs.writeFileSync(path.join(common.LOG_ROOT, "crash.err.log"), "boom\n");
  fs.writeFileSync(path.join(directory, "storage-state.json"), "{\"cookies\":[]}");
  log.info("lifecycle", "service.start", "started", { port: 3088 });
  assert.equal(fs.existsSync(path.join(common.LOG_ROOT, "app.2020-01-01.jsonl")), false);
  const archive = log.buildDiagnosticArchive();
  assert.match(archive.fileName, /^worktime-diagnostics-\d{4}-\d{2}-\d{2}\.zip$/);
  assert.equal(archive.buffer.readUInt32LE(0), 0x04034b50);
  const text = archive.buffer.toString("utf8");
  assert.match(text, /manifest\.json/);
  assert.match(text, /crash\.err\.log/);
  assert.doesNotMatch(text, /storage-state\.json/);
  assert.match(archive.manifest.note, /不含 Cookie/);
});
