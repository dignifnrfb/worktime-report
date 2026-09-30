"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SCRATCH = path.join(ROOT, "diagnostics", "regression");

function temporaryDirectory(prefix) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  return fs.mkdtempSync(path.join(SCRATCH, `${prefix}-`));
}

function removeTemporary(directory) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), SCRATCH, "Only remove a test's own scratch directory");
  fs.rmSync(resolved, { recursive: true, force: true });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

const workTypes = [
  { code: "008", name: "项目-海外" }, { code: "007", name: "项目-国内" },
  { code: "006", name: "研发" }, { code: "005", name: "office work" },
  { code: "004", name: "休假" }, { code: "003", name: "培训" }, { code: "002", name: "展会" },
];
const account = { name: "测试甲", employeeNo: "TEST001", department: "测试组", organization: "测试公司" };
const defaults = {
  workType: workTypes[6], projectCode: "TEST-P001", projectId: "project-1", projectName: "测试项目",
  hours: "8.0", remark: "", skipWeekends: true,
};

function dashboard(overrides = {}) {
  return {
    account, defaults, workTypes,
    workTypeCatalog: { count: 7, sourceTotal: 7, fetchedAt: new Date().toISOString() },
    projectCatalog: { count: 1, sourceTotal: 1, fetchedAt: new Date().toISOString() },
    session: { connected: true, busy: null, lastSyncedAt: new Date().toISOString() },
    records: [], ...overrides,
  };
}

module.exports = { ROOT, temporaryDirectory, removeTemporary, writeJson, workTypes, account, defaults, dashboard };
