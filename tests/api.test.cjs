"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { test, before, after } = require("node:test");
const { ROOT, temporaryDirectory, removeTemporary, writeJson, account, workTypes, defaults } = require("./test-support.cjs");

const directory = temporaryDirectory("api");
const appDirectory = path.join(directory, "app");
const dataDirectory = path.join(directory, "data");
fs.mkdirSync(appDirectory);
process.env.WORKTIME_DATA_ROOT = dataDirectory;
for (const name of ["dashboard-server.cjs", "worktime-common.cjs", "worktime-log.cjs", "worktime-progress.cjs", "worktime-update.cjs", "VERSION"]) fs.copyFileSync(path.join(ROOT, name), path.join(appDirectory, name));
writeJson(path.join(appDirectory, "update-source.json"), { repository: "" });
fs.writeFileSync(path.join(appDirectory, "worktime.cjs"), `
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const payload = args.find(x => x.startsWith('--payload='));
const data = payload ? JSON.parse(Buffer.from(payload.slice(10), 'base64url')) : {};
if (args[0] !== 'session-check') fs.appendFileSync(path.join(process.env.WORKTIME_DATA_ROOT, 'calls.jsonl'), JSON.stringify({command: args[0], data}) + '\\n');
if (args[0] === 'session-check') setTimeout(() => {
  const modeFile = path.join(process.env.WORKTIME_DATA_ROOT, 'session-test.json');
  const status = fs.existsSync(modeFile) ? JSON.parse(fs.readFileSync(modeFile, 'utf8')) : { state: 'connected', message: 'OA 登录有效' };
  require('./worktime-common.cjs').writeLoginStatus(status);
  process.exitCode = status.state === 'connected' ? 0 : 1;
}, 100);
else if (args[0] === 'hold') setTimeout(() => console.log('finished'), 10000);
else if (args[0] === 'partial') {
  console.log('WORKTIME_RESULT:' + JSON.stringify({submittedDates: ['2020-01-06'], skippedDates: []}));
  console.error('模拟第二天失败'); process.exitCode = 1;
} else if (data.scenario) {
  const emit = (date, stage, error) => console.log('WORKTIME_PROGRESS:' + JSON.stringify({runId: process.env.WORKTIME_RUN_ID, date, stage, error}));
  emit(data.dates[0], data.scenario === 'timeout' ? 'submitting' : 'loading');
  if (data.scenario === 'timeout') setTimeout(() => emit(data.dates[0], 'submitted_pending'), 10000);
  else {
    setTimeout(() => emit(data.dates[0], 'checking'), 40);
    setTimeout(() => emit(data.dates[0], args[0] === 'batch-preview' ? 'preview_passed' : 'submitted_pending'), 80);
    setTimeout(() => emit(data.dates[1], 'skipped'), 100);
    setTimeout(() => {
      emit(data.dates[2], 'checking');
      if (data.scenario === 'failure') {
        const bytes = Buffer.from('WORKTIME_PROGRESS:' + JSON.stringify({runId: process.env.WORKTIME_RUN_ID, date: data.dates[2], stage: 'failed', error: '日期校验失败'}) + '\\n');
        const cut = bytes.indexOf(Buffer.from('校')) + 1;
        process.stdout.write(bytes.subarray(0, cut));
        setTimeout(() => { process.stdout.write(bytes.subarray(cut)); console.error('模拟校验失败'); process.exitCode = 1; }, 30);
      } else { emit(data.dates[2], args[0] === 'batch-preview' ? 'preview_passed' : 'submitted_pending'); }
    }, 120);
  }
} else if (data.dates) {
  console.log('已跳过重复日期');
  console.log('WORKTIME_RESULT:' + JSON.stringify({submittedDates: [], skippedDates: data.dates, processedDates: []}));
} else console.log('模拟同步完成');
`, "utf8");
writeJson(path.join(dataDirectory, "worktime.config.json"), { ...defaults, account });
writeJson(path.join(dataDirectory, "storage-state.json"), { cookies: [] });
writeJson(path.join(dataDirectory, "login-status.json"), { state: "connected", account });
writeJson(path.join(dataDirectory, "work-types.json"), { account, workTypes, sourceTotal: 7, fetchedAt: new Date().toISOString() });
writeJson(path.join(dataDirectory, "projects.json"), { account, projects: [{ code: defaults.projectCode, id: defaults.projectId, name: defaults.projectName }], sourceTotal: 1, fetchedAt: new Date().toISOString() });
const service = require(path.join(appDirectory, "dashboard-server.cjs"));
let base;

before(async () => {
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  base = `http://127.0.0.1:${service.server.address().port}`;
});
after(async () => {
  await delay(350);
  service.server.closeAllConnections();
  await new Promise((resolve) => service.server.close(resolve));
  removeTemporary(directory);
});

async function post(route, body, headers = {}) {
  if (["/api/preview", "/api/submit", "/api/defaults"].includes(route) && body && typeof body === "object" && !Array.isArray(body) && !Object.hasOwn(body, "account")) body = { ...body, account };
  const response = await fetch(base + route, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("health and dashboard identify the app and expose all synced work types", async () => {
  assert.equal((await (await fetch(base + "/health")).json()).app, "MechMindWorktimeAssistant");
  const dashboard = await (await fetch(base + "/api/dashboard")).json();
  assert.equal(dashboard.workTypes.length, 7);
  assert.equal(dashboard.session.connected, false, "An existing file is not a verified session");
  assert.equal(dashboard.session.state, "verifying");
  assert.equal((await post("/api/session/check", {})).body.state, "connected");
  assert.equal(service.buildDashboard().session.connected, true);
});

test("a website on another origin cannot submit or change local data", async () => {
  const result = await post("/api/submit", { dates: ["2020-01-06"], confirm: true }, { Origin: "https://unrelated.example" });
  assert.equal(result.status, 403);
  assert.equal(fs.existsSync(path.join(dataDirectory, "calls.jsonl")), false);
  const status = await new Promise((resolve, reject) => {
    const request = http.get(base + "/health", { headers: { Host: "unrelated.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
  });
  assert.equal(status, 403);
});

test("the local development origin is accepted", async () => {
  const response = await fetch(base + "/api/dashboard", { headers: { Origin: "http://127.0.0.1:3000" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://127.0.0.1:3000");
});

test("malformed requests and future dates fail before starting the assistant", async () => {
  for (const body of [null, [], "bad"]) assert.equal((await post("/api/preview", body)).status, 400);
  assert.equal((await post("/api/preview", { dates: ["2026-02-30"] })).status, 400);
  assert.equal((await post("/api/preview", { dates: ["9999-01-01"] })).status, 400);
  assert.equal((await post("/api/submit", { dates: ["2020-01-06"] })).status, 400);
  assert.equal(fs.existsSync(path.join(dataDirectory, "calls.jsonl")), false);
});

test("name/code mismatches are rejected and selected project IDs are canonicalized", async () => {
  const invalid = await post("/api/preview", { dates: ["2020-01-06"], settings: { workType: { name: "研发", code: "002" } } });
  assert.equal(invalid.status, 400);
  const valid = await post("/api/preview", { dates: ["2020-01-06"], settings: { workType: { name: "研发", code: "006" }, projectId: "incorrect-id" } });
  assert.equal(valid.status, 200);
  const calls = fs.readFileSync(path.join(dataDirectory, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.at(-1).data.settings.projectId, "project-1");
  assert.deepEqual(calls.at(-1).data.account, account);
  assert.deepEqual(calls.at(-1).data.settings.workType, { name: "研发", code: "006" });
  assert.deepEqual(valid.body.result.submittedDates, []);
  assert.deepEqual(valid.body.result.skippedDates, ["2020-01-06"]);
  assert.doesNotMatch(valid.body.message, /WORKTIME_RESULT/);
});

test("UTF-8 split between request chunks is saved without corruption", async () => {
  const bytes = Buffer.from(JSON.stringify({ account, settings: { remark: "中文备注" } }), "utf8");
  const split = bytes.indexOf(Buffer.from("中")) + 1;
  const response = await new Promise((resolve, reject) => {
    const request = http.request(base + "/api/defaults", { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    request.on("error", reject);
    request.write(bytes.subarray(0, split));
    setTimeout(() => request.end(bytes.subarray(split)), 20);
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.dashboard.defaults.remark, "中文备注");
});

test("preview can use a selected project without a complete local project catalog", async () => {
  const file = path.join(dataDirectory, "projects.json");
  const saved = fs.readFileSync(file);
  try {
    fs.unlinkSync(file);
    const result = await post("/api/preview", {
      dates: ["2020-01-06"],
      settings: { projectCode: "SO#20220830-00002", projectId: "SO#20220830-00002", projectName: "国联江森" },
    });
    assert.equal(result.status, 200);
  } finally {
    fs.writeFileSync(file, saved);
  }
});

test("missing or incomplete catalogs block filling before the assistant starts", async () => {
  const file = path.join(dataDirectory, "work-types.json");
  const saved = fs.readFileSync(file);
  try {
    fs.unlinkSync(file);
    assert.equal((await post("/api/preview", { dates: ["2020-01-06"] })).status, 400);
    writeJson(file, { account, workTypes, sourceTotal: 8 });
    assert.equal((await post("/api/preview", { dates: ["2020-01-06"] })).status, 400);
  } finally {
    fs.writeFileSync(file, saved);
  }
});

test("partial failure retains its actual submission result", async () => {
  await assert.rejects(service.runAssistant(["partial"]), (error) => {
    assert.match(error.message, /第二天失败/);
    assert.deepEqual(error.result.submittedDates, ["2020-01-06"]);
    return true;
  });
});

test("timing out does not release the action lock before the child closes", async () => {
  await assert.rejects(service.runAssistant(["hold"], 20), /操作超时/);
  await assert.rejects(service.runAssistant(["list"]), (error) => error.statusCode === 409);
  for (let attempt = 0; attempt < 50 && service.buildDashboard().session.busy; attempt++) await delay(20);
  assert.equal(service.buildDashboard().session.busy, null);
  assert.match((await service.runAssistant(["list"])).message, /同步完成/);
});

test("reopening validates saved login and distinguishes expiry from a network failure", async () => {
  const modeFile = path.join(dataDirectory, "session-test.json");
  for (const status of [
    { state: "error", reason: "expired", message: "OA 登录已过期，请重新扫码登录。" },
    { state: "unavailable", message: "暂时无法验证 OA 登录，请检查网络后重试。" },
    { state: "connected", message: "OA 登录有效。" },
  ]) {
    writeJson(modeFile, status);
    const pending = post("/api/session/check", {});
    await delay(40);
    assert.equal(service.buildDashboard().session.connected, false);
    assert.equal(service.buildDashboard().session.state, "verifying");
    const result = await pending;
    assert.equal(result.body.state, status.state);
    assert.equal(result.body.reason, status.reason);
    assert.equal(service.buildDashboard().session.connected, status.state === "connected");
    assert.ok(fs.existsSync(path.join(dataDirectory, "storage-state.json")));
  }
});

test("calendar updates persist, merge, and restore defaults without changing records or fill settings", async (t) => {
  const common = require(path.join(appDirectory, "worktime-common.cjs"));
  const original = fs.readFileSync(common.CONFIG_PATH);
  const csv = "工时日期,状态\n2020-01-06,归档\n";
  fs.writeFileSync(common.EXPORT_PATH, csv, "utf8");
  t.after(() => {
    fs.writeFileSync(common.CONFIG_PATH, original);
    fs.unlinkSync(common.EXPORT_PATH);
  });
  const previousDefaults = service.buildDashboard().defaults;
  const update = (dates, mode) => post("/api/calendar", { account, dates, mode });
  const work = await update(["2020-01-04", "2020-01-04", "9999-01-01"], "work");
  assert.equal(work.status, 200);
  assert.match(work.body.message, /2 天/);
  const rest = await update(["2020-01-06", "2024-02-29"], "rest");
  assert.equal(rest.status, 200);
  assert.deepEqual(rest.body.dashboard.workdayOverrides, {
    "2020-01-04": "work", "9999-01-01": "work", "2020-01-06": "rest", "2024-02-29": "rest",
  });
  assert.deepEqual(common.loadConfig().workdayOverrides, rest.body.dashboard.workdayOverrides);
  assert.deepEqual(service.buildDashboard().defaults, previousDefaults);
  assert.equal(rest.body.dashboard.records[0].workDate, "2020-01-06");
  assert.equal(fs.readFileSync(common.EXPORT_PATH, "utf8"), csv);
  const restored = await update(["2020-01-04", "2020-01-06", "2020-01-07"], "default");
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.body.dashboard.workdayOverrides, { "9999-01-01": "work", "2024-02-29": "rest" });
  assert.deepEqual(common.loadConfig().workdayOverrides, restored.body.dashboard.workdayOverrides);
  assert.deepEqual(service.buildDashboard().defaults, previousDefaults);
  const savedDefaults = await post("/api/defaults", { settings: { hours: "7.5" } });
  assert.deepEqual(savedDefaults.body.dashboard.workdayOverrides, restored.body.dashboard.workdayOverrides);
});

test("invalid calendar requests and stale accounts leave the saved configuration untouched", async () => {
  const file = path.join(dataDirectory, "worktime.config.json");
  const original = fs.readFileSync(file, "utf8");
  for (const body of [null, [], "bad", {},
    { dates: [], mode: "work" }, { dates: ["2026-02-30"], mode: "rest" },
    { dates: [123], mode: "work" }, { dates: ["2020-01-04"], mode: "invalid" },
    { dates: Array(32).fill("2020-01-04"), mode: "work" },
  ]) assert.equal((await post("/api/calendar", body && { ...body, account })).status, 400);
  for (const owner of [undefined, {}, { ...account, employeeNo: "TEST002" }]) {
    assert.equal((await post("/api/calendar", { dates: ["2020-01-04"], mode: "work", account: owner })).status, 409);
  }
  assert.equal((await post("/api/calendar", { dates: ["2020-01-04"], mode: "work", account }, { Origin: "https://unrelated.example" })).status, 403);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("filling rejects stale or missing account identity before launching an OA session", async () => {
  const calls = fs.readFileSync(path.join(dataDirectory, "calls.jsonl"), "utf8");
  for (const owner of [null, {}, { ...account, employeeNo: "TEST002" }]) {
    for (const route of ["/api/preview", "/api/submit"]) {
      assert.equal((await post(route, { account: owner, dates: ["2020-01-06"], confirm: true })).status, 409);
    }
  }
  assert.equal(fs.readFileSync(path.join(dataDirectory, "calls.jsonl"), "utf8"), calls);
});

test("automatic refresh after submit syncs done records without reloading the project catalog", async () => {
  const callsFile = path.join(dataDirectory, "calls.jsonl");
  const before = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8") : "";
  assert.equal((await post("/api/submit", { dates: ["2020-01-06"], confirm: true })).status, 200);
  let commands = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(50);
    commands = fs.readFileSync(callsFile, "utf8").slice(before.length).trim().split("\n")
      .filter(Boolean).map((line) => JSON.parse(line).command);
    if (commands.includes("startup-sync")) break;
  }
  assert.ok(commands.includes("batch-submit"));
  assert.ok(commands.includes("startup-sync"));
  assert.ok(!commands.includes("projects"));
});

test("preview and submit requests write structured logs that share a run id", async () => {
  for (let attempt = 0; attempt < 50 && service.buildDashboard().session.busy; attempt++) await delay(20);
  const preview = await post("/api/preview", { dates: ["2020-01-06"] });
  assert.equal(preview.status, 200);
  const logger = require(path.join(appDirectory, "worktime-log.cjs"));
  const records = logger.readTodayRecords();
  const requestLog = records.find((record) => record.event === "preview.request");
  const startLog = records.find((record) => record.event === "assistant.start" && record.cmd === "batch-preview");
  const doneLog = records.find((record) => record.event === "assistant.ok" && record.cmd === "batch-preview");
  assert.ok(requestLog);
  assert.deepEqual(requestLog.data.dates, ["2020-01-06"]);
  assert.ok(startLog && doneLog);
  assert.equal(startLog.runId, doneLog.runId);
  assert.ok(!JSON.stringify(records).includes("storage-state"));
});

test("diagnostic archive contains recent logs and excludes the login session", async () => {
  const response = await fetch(base + "/api/diagnostics");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /zip/);
  const zip = Buffer.from(await response.arrayBuffer());
  assert.ok(zip.length > 30);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const text = zip.toString("utf8");
  assert.match(text, /manifest\.json/);
  assert.doesNotMatch(text, /storage-state\.json|login-qr\.png|browser-profile/);
  assert.ok(!fs.existsSync(path.join(dataDirectory, "logs", "storage-state.json")));
});

test("calendar writes stay locked while another action is running, including delayed request bodies", async () => {
  const file = path.join(dataDirectory, "worktime.config.json");
  const original = fs.readFileSync(file, "utf8");
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(base + "/api/calendar", { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    request.on("error", reject);
    request.write('{"account":');
  });
  await delay(20);
  const action = assert.rejects(service.runAssistant(["hold"], 250), /操作超时/);
  request.end(JSON.stringify(account) + ',"dates":["2020-01-04"],"mode":"work"}');
  assert.equal(await response, 409);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  await action;
  for (let attempt = 0; attempt < 50 && service.buildDashboard().session.busy; attempt++) await delay(20);
});

test("leave preview and defaults ignore old projects but retain catalog and account checks", async (t) => {
  const configFile = path.join(dataDirectory, "worktime.config.json");
  const saved = fs.readFileSync(configFile);
  t.after(() => fs.writeFileSync(configFile, saved));
  const settings = { workType: { code: "004", name: "休假" }, projectCode: "OLD", projectId: "OLD", projectName: "旧项目" };
  const result = await post("/api/preview", { dates: ["2020-01-06"], settings });
  assert.equal(result.status, 200);
  const call = fs.readFileSync(path.join(dataDirectory, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse).at(-1);
  assert.deepEqual([call.data.settings.projectCode, call.data.settings.projectId, call.data.settings.projectName], ["", "", ""]);
  assert.equal((await post("/api/defaults", { settings })).status, 200);
  assert.equal((await post("/api/defaults", { settings, account: { employeeNo: "OTHER" } })).status, 409);
  assert.equal(service.buildDashboard().defaults.projectCode, "");
  assert.equal((await post("/api/preview", { dates: ["2020-01-06"], settings: { ...settings, workType: { code: "006", name: "休假" } } })).status, 400);
  assert.equal((await post("/api/preview", { dates: ["2020-01-06"], account: { employeeNo: "OTHER" }, settings })).status, 409);
  assert.equal((await post("/api/preview", { dates: ["2020-01-06"], settings: { workType: defaults.workType, projectCode: "", projectId: "", projectName: "" } })).status, 400);
});

async function progressBatch(scenario, command = "batch-submit", timeout = 1000, owner = account) {
  const payload = { account: owner, dates: ["2020-01-06", "2020-01-07", "2020-01-08", "2020-01-09"], scenario };
  const done = service.runAssistant([command, "--payload=" + Buffer.from(JSON.stringify(payload)).toString("base64url")], timeout);
  return { done: done.then((value) => ({ value }), (error) => ({ error })) };
}

test("dashboard streams UTF-8 progress before completion and retains partial failure on reopen", async () => {
  const { done } = await progressBatch("failure");
  let snapshot;
  for (let attempt = 0; attempt < 50; attempt++) {
    snapshot = await (await fetch(base + "/api/dashboard")).json();
    if (snapshot.batchProgress?.days[0].status === "loading") break;
    await delay(10);
  }
  assert.equal(snapshot.batchProgress.status, "running");
  assert.equal(snapshot.batchProgress.mode, "submit");
  const outcome = await done;
  assert.ok(outcome.error);
  snapshot = await (await fetch(base + "/api/dashboard")).json();
  assert.deepEqual(snapshot.batchProgress.days.map((day) => day.status), ["submitted_pending", "skipped", "failed", "unprocessed"]);
  assert.equal(snapshot.batchProgress.days[2].error, "日期校验失败");
  assert.equal(snapshot.batchProgress.percent, 75);
  assert.equal((await (await fetch(base + "/api/dashboard")).json()).batchProgress.runId, snapshot.batchProgress.runId);
  assert.doesNotMatch(outcome.error.message, /WORKTIME_PROGRESS:/);
});

test("preview progress stays separate from submissions and previous results remain account-isolated", async (t) => {
  const configFile = path.join(dataDirectory, "worktime.config.json");
  const saved = fs.readFileSync(configFile);
  t.after(() => fs.writeFileSync(configFile, saved));
  const { done } = await progressBatch("preview", "batch-preview");
  assert.equal(service.buildDashboard().previousBatchProgress.status, "failed");
  await done;
  const completed = service.buildDashboard().batchProgress;
  assert.equal(completed.mode, "preview");
  assert.equal(completed.days[0].status, "preview_passed");
  writeJson(configFile, { ...defaults, account: { ...account, employeeNo: "OTHER" } });
  assert.equal(service.buildDashboard().batchProgress, null);
  fs.writeFileSync(configFile, saved);
  assert.equal(service.buildDashboard().batchProgress.runId, completed.runId);
});

test("batch timeout records the in-flight date as unknown and keeps the operation locked until exit", async () => {
  const { done } = await progressBatch("timeout", "batch-submit", 150);
  const outcome = await done;
  assert.match(outcome.error.message, /超时/);
  const batch = service.buildDashboard().batchProgress;
  assert.equal(batch.status, "timed_out");
  assert.equal(batch.days[0].status, "unknown");
  assert.ok(batch.days.slice(1).every((day) => day.status === "unprocessed"));
  for (let attempt = 0; attempt < 50 && service.buildDashboard().session.busy; attempt++) await delay(10);
  assert.equal(service.buildDashboard().session.busy, null);
});

test("OA synchronization omitting employee numbers preserves active and completed progress without exposing it to another OA user", async (t) => {
  const configFile = path.join(dataDirectory, "worktime.config.json");
  const saved = fs.readFileSync(configFile);
  t.after(() => fs.writeFileSync(configFile, saved));
  const owner = { ...account, oaUserId: "stable-test-oa" };
  writeJson(configFile, { ...defaults, account: owner });
  const { done } = await progressBatch("preview", "batch-preview", 1000, owner);
  const started = service.buildDashboard().batchProgress;
  assert.equal(started.status, "running");
  writeJson(configFile, { ...defaults, account: { ...owner, employeeNo: "" } });
  assert.equal(service.buildDashboard().batchProgress.runId, started.runId);
  await done;
  assert.equal(service.buildDashboard().batchProgress.status, "completed");
  assert.equal((await (await fetch(base + "/api/dashboard")).json()).batchProgress.runId, started.runId);
  writeJson(configFile, { ...defaults, account: { ...owner, oaUserId: "other-test-oa" } });
  assert.equal(service.buildDashboard().batchProgress, null);
});


test("update API reports source status without contacting OA and requires download confirmation", async () => {
  service.updates.configure("");
  assert.equal((await post("/api/updates/check", {})).status, 202);
  assert.equal(service.buildDashboard().update.status, "not_configured");
  assert.equal((await post("/api/updates/download", {})).status, 400);
  assert.equal((await post("/api/updates/install", {confirm: true})).status, 400);
  assert.equal((await post("/api/updates/source", {repository: "https://evil.test/a/b"})).status, 400);
  assert.equal((await post("/api/updates/source", {repository: "test-owner/worktime"})).body.repository, "test-owner/worktime");
  service.updates.configure("");
});

test("installation state blocks OA jobs and default or calendar writes", async () => {
  service.updates.state.status = "installing";
  try {
    for (const route of ["/api/refresh", "/api/login/start", "/api/defaults", "/api/calendar", "/api/preview", "/api/submit"]) assert.equal((await post(route, {})).status, 409);
    await assert.rejects(service.runAssistant(["list"]), /安装更新/);
    assert.equal(service.buildDashboard().update.status, "installing");
  } finally { service.updates.state.status = "not_configured"; }
});
