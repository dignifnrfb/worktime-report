"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, after } = require("node:test");
const { ROOT, temporaryDirectory, removeTemporary, account, writeJson } = require("./test-support.cjs");

const directory = temporaryDirectory("common");
process.env.WORKTIME_DATA_ROOT = directory;
const common = require("../worktime-common.cjs");
const assistant = require("../worktime.cjs");
after(() => removeTemporary(directory));

test("source and installed modes default to the same per-user data directory", () => {
  const env = { ...process.env, LOCALAPPDATA: directory };
  delete env.WORKTIME_DATA_ROOT;
  const actual = execFileSync(process.execPath, ["-e", "process.stdout.write(require('./worktime-common.cjs').DATA_ROOT)"], { cwd: ROOT, env, encoding: "utf8" });
  assert.equal(actual, path.join(directory, "MechMindWorktimeAssistant"));
  assert.equal(common.PROFILE_ROOT, path.join(directory, "browser-profile"));
  assert.equal(common.STATE_PATH, path.join(directory, "storage-state.json"));
});

test("switching accounts archives and restores that account's own defaults and records", () => {
  common.syncAccount(account);
  common.writeJsonAtomic(common.CONFIG_PATH, {
    ...common.loadConfig(), hours: "4.5", remark: "仅属于甲",
    workdayOverrides: { "2020-01-04": "work", "2020-01-06": "rest" },
  });
  fs.writeFileSync(common.EXPORT_PATH, "甲的工时", "utf8");
  writeJson(common.WORK_TYPES_PATH, { account, workTypes: [{ code: "002", name: "展会" }] });
  const other = { ...account, name: "测试乙", employeeNo: "TEST002" };
  common.syncAccount(other);
  assert.equal(common.loadConfig().hours, "8.0");
  assert.deepEqual(common.loadConfig().workdayOverrides, {});
  assert.equal(fs.existsSync(common.EXPORT_PATH), false);
  assert.equal(fs.existsSync(common.WORK_TYPES_PATH), false);
  common.writeJsonAtomic(common.CONFIG_PATH, {
    ...common.loadConfig(), hours: "6", remark: "仅属于乙", workdayOverrides: { "2020-01-05": "work" },
  });
  fs.writeFileSync(common.EXPORT_PATH, "乙的工时", "utf8");
  common.syncAccount(account);
  assert.equal(common.loadConfig().hours, "4.5");
  assert.equal(common.loadConfig().remark, "仅属于甲");
  assert.deepEqual(common.loadConfig().workdayOverrides, { "2020-01-04": "work", "2020-01-06": "rest" });
  assert.equal(fs.readFileSync(common.EXPORT_PATH, "utf8"), "甲的工时");
  assert.equal(JSON.parse(fs.readFileSync(common.WORK_TYPES_PATH, "utf8")).account.employeeNo, "TEST001");
  common.syncAccount(other);
  assert.equal(common.loadConfig().hours, "6");
  assert.deepEqual(common.loadConfig().workdayOverrides, { "2020-01-05": "work" });
  assert.equal(fs.readFileSync(common.EXPORT_PATH, "utf8"), "乙的工时");
});

test("updating metadata for the same employee preserves their saved settings", () => {
  common.syncAccount({ ...account, name: "测试乙", employeeNo: "TEST002", department: "新测试组" });
  assert.equal(common.loadConfig().hours, "6");
  assert.equal(fs.readFileSync(common.EXPORT_PATH, "utf8"), "乙的工时");
  assert.equal(common.accountsMatch({ employeeNo: "001", name: "同名" }, { employeeNo: "002", name: "同名" }), false);
});

test("OA user IDs isolate same-name accounts without employee numbers", (t) => {
  const saved = fs.readFileSync(common.CONFIG_PATH);
  t.after(() => fs.writeFileSync(common.CONFIG_PATH, saved));
  const first = { name: "同名测试", organization: "同一公司", oaUserId: "101" };
  const second = { ...first, oaUserId: "102" };
  assert.notEqual(common.accountKey(first), common.accountKey(second));
  assert.equal(common.accountsMatch(first, second), false);
  common.syncAccount(first);
  common.writeJsonAtomic(common.CONFIG_PATH, { ...common.loadConfig(), workdayOverrides: { "2020-01-04": "work" } });
  common.syncAccount(second);
  assert.deepEqual(common.loadConfig().workdayOverrides, {});
  common.syncAccount(first);
  assert.deepEqual(common.loadConfig().workdayOverrides, { "2020-01-04": "work" });
});

test("pending submissions remain visible until OA returns the completed record", () => {
  const pending = { workDate: "2020-01-01", status: "已提交·同步中" };
  const old = { workDate: "2020-01-02", status: "归档" };
  assert.deepEqual(common.mergePendingRecords([], [pending, old]), [pending]);
  const complete = { ...pending, status: "归档", requestId: "123" };
  assert.deepEqual(common.mergePendingRecords([complete], [pending]), [complete]);
});

test("dates are validated, deduplicated, and future dates rejected", () => {
  assert.throws(() => assistant.validateDate("2026-02-30"), /无效日期/);
  assert.throws(() => assistant.normalizeTargetDates(["9999-01-01"], { skipWeekends: false }), /未来日期/);
  assert.deepEqual(assistant.normalizeTargetDates(["2020-01-07", "2020-01-06", "2020-01-06"], { skipWeekends: true }), ["2020-01-06", "2020-01-07"]);
});

test("manual calendar overrides take precedence over both legacy weekend settings", () => {
  for (const skipWeekends of [true, false]) {
    const config = { skipWeekends, workdayOverrides: { "2020-01-04": "work", "2020-01-06": "rest" } };
    assert.equal(common.isWorkday("2020-01-04", config), true);
    assert.equal(common.isWorkday("2020-01-06", config), false);
    assert.equal(common.isWorkday("2020-01-05", config), !skipWeekends);
    assert.equal(common.isWorkday("2020-01-07", config), true);
    assert.deepEqual(assistant.normalizeTargetDates(["2020-01-06", "2020-01-04", "2020-01-07", "2020-01-04"], config), ["2020-01-04", "2020-01-07"]);
    assert.throws(() => assistant.normalizeTargetDates(["2020-01-06"], config), /休息日/);
    delete config.workdayOverrides["2020-01-04"];
    delete config.workdayOverrides["2020-01-06"];
    assert.equal(common.isWorkday("2020-01-04", config), !skipWeekends);
    assert.equal(common.isWorkday("2020-01-06", config), true);
  }
});

test("calendar overrides cannot bypass invalid dates, future dates, or batch limits", () => {
  const config = { skipWeekends: true, workdayOverrides: { "9999-01-01": "work", "2026-02-30": "work" } };
  assert.throws(() => assistant.normalizeTargetDates(["9999-01-01"], config), /未来日期/);
  assert.throws(() => assistant.normalizeTargetDates(["2026-02-30"], config), /无效日期/);
  const dates = Array.from({ length: 32 }, (_, index) => new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10));
  assert.throws(() => assistant.normalizeTargetDates(dates, config), /31/);
  assert.equal(common.isWorkday("2020-01-04", { skipWeekends: true }), false);
  assert.equal(common.isWorkday("2020-01-04", { skipWeekends: false }), true);
});

test("done records accept Chinese punctuation and whitespace", () => {
  const record = assistant.parseDoneRecord({
    title: "工时填报（单据编号： GSTB-TEST-001，工时日期： 2020-01-06）",
    onclick: "openSPA4Single('?requestid=12345')", row: "2020-01-06 12:30:00 归档",
  });
  assert.equal(record.workDate, "2020-01-06");
  assert.equal(record.documentNo, "GSTB-TEST-001");
  assert.equal(record.requestId, "12345");
});

test("hours and work type codes must be usable before opening a form", () => {
  for (const hours of ["0", "-1", "24.1", "NaN", "Infinity"]) {
    assert.throws(() => assistant.validateSettings({ ...common.DEFAULT_CONFIG, hours }), /工时/);
  }
  for (const hours of ["8", "8.00", "7.5", "0.5"]) assistant.validateSettings({ ...common.DEFAULT_CONFIG, hours });
  assert.throws(() => assistant.validateSettings({ ...common.DEFAULT_CONFIG, workType: { name: "展会", code: "" } }), /有效类别/);
});

test("CLI fills only verified catalog choices and uses the catalog's project ID", () => {
  const config = { ...common.DEFAULT_CONFIG, account };
  writeJson(common.WORK_TYPES_PATH, { account, sourceTotal: 1, workTypes: [config.workType] });
  writeJson(common.PROJECTS_PATH, { account, sourceTotal: 1, projects: [{ code: config.projectCode, id: "verified-id", name: "测试项目" }] });
  assert.equal(assistant.resolveCatalogSelections({ ...config, projectId: "wrong-id" }).projectId, "verified-id");
  assert.throws(() => assistant.resolveCatalogSelections({ ...config, workType: { code: "999", name: "不存在" } }), /工作类型不在/);
  assert.throws(() => assistant.resolveCatalogSelections({ ...config, account: { employeeNo: "OTHER", name: "其他人" } }), /缓存不可用/);
});

test("special and swapped OA project rows keep the real project number", () => {
  const swapped = common.normalizeProjects([{
    randomFieldId: "【新增第二批采购】Caterpillar(美国)-BHS-大型金属件上下料",
    xmbm: "【新增第二批采购】Caterpillar(美国)-BHS-大型金属件上下料",
    xmmc: "F230604594-2",
  }]);
  assert.deepEqual(swapped, [{
    id: "【新增第二批采购】Caterpillar(美国)-BHS-大型金属件上下料",
    code: "F230604594-2",
    name: "【新增第二批采购】Caterpillar(美国)-BHS-大型金属件上下料",
  }]);
  const special = common.normalizeProjects([
    { randomFieldId: "SO#20220830-00002", xmbm: "SO#20220830-00002", xmmc: "国联江森-智能读表" },
    { randomFieldId: "P230604540-1 -S", xmbm: "P230604540-1 -S", xmmc: "售后项目" },
  ]);
  assert.deepEqual(special.map((project) => project.code), ["SO#20220830-00002", "P230604540-1 -S"]);
  assert.ok(common.projectKeysMatch("T1908-PA103", "T1908\u2010PA103"));
  assert.ok(common.projectKeysMatch("P230604540-1 -S", "P230604540-1-S"));
});

test("a selected project can be submitted without a complete local project catalog", () => {
  const config = { ...common.DEFAULT_CONFIG, account, projectCode: "SO#20220830-00002", projectId: "SO#20220830-00002", projectName: "国联江森" };
  writeJson(common.WORK_TYPES_PATH, { account, sourceTotal: 1, workTypes: [config.workType] });
  if (fs.existsSync(common.PROJECTS_PATH)) fs.unlinkSync(common.PROJECTS_PATH);
  const resolved = assistant.resolveCatalogSelections(config);
  assert.equal(resolved.projectCode, "SO#20220830-00002");
  assert.equal(resolved.projectId, "SO#20220830-00002");
});

test("verified leave needs no project and strips stale project fields before CLI filling", () => {
  const config = { ...common.DEFAULT_CONFIG, account, workType: { code: "004", name: "休假" } };
  writeJson(common.WORK_TYPES_PATH, { account, sourceTotal: 1, workTypes: [config.workType] });
  if (fs.existsSync(common.PROJECTS_PATH)) fs.unlinkSync(common.PROJECTS_PATH);
  const resolved = assistant.resolveCatalogSelections(config);
  assert.deepEqual([resolved.projectCode, resolved.projectId, resolved.projectName], ["", "", ""]);
  assistant.validateSettings(resolved);
  assert.throws(() => assistant.validateSettings({ ...resolved, hours: "0" }), /工时/);
  assert.throws(() => assistant.resolveCatalogSelections({ ...config, workType: { code: "006", name: "休假" } }), /工作类型不在/);
  assert.throws(() => assistant.resolveCatalogSelections({ ...config, account: { name: "其他人", employeeNo: "OTHER" } }), /缓存不可用/);
  assert.throws(() => assistant.validateSettings({ ...resolved, workType: common.DEFAULT_CONFIG.workType }), /项目号/);
});
