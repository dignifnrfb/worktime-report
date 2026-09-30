"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test, after } = require("node:test");
const { ROOT, temporaryDirectory, removeTemporary, account, writeJson } = require("./test-support.cjs");

const directory = temporaryDirectory("oa-config");
process.env.WORKTIME_DATA_ROOT = directory;
const common = require("../worktime-common.cjs");
const assistant = require("../worktime.cjs");
after(() => removeTemporary(directory));

const origin = "https://oa.mech-mind.com.cn";
const portalLink = `${origin}/wui/index.html#/main/portal/portal-4-3?menuIds=0,4&em_auth_userid=TEST&em_auth_code=TEST-ONLY`;

test("new users and installer defaults use the reachable HTTPS OA address", () => {
  assert.equal(common.loadConfig().baseUrl, origin);
  assert.equal(fs.existsSync(common.CONFIG_PATH), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, "installer/default-worktime.config.json"), "utf8")).baseUrl, origin);
});

test("an existing legacy config migrates once without changing user settings or records", () => {
  const saved = {
    baseUrl: "http://54.223.138.50:8089/", workflowId: 321, account,
    workType: { code: "006", name: "研发" }, hours: "6.5", remark: "保留原备注",
    projectCode: "CUSTOM-PROJECT", skipWeekends: false, extraSetting: { keep: true },
  };
  fs.writeFileSync(common.CONFIG_PATH, "\uFEFF" + JSON.stringify(saved), "utf8");
  fs.writeFileSync(common.EXPORT_PATH, "原有工时记录\r\n", "utf8");
  const loaded = common.loadConfig();
  assert.equal(loaded.baseUrl, origin);
  assert.equal(loaded.workflowId, 321);
  assert.equal(loaded.hours, "6.5");
  assert.deepEqual(loaded.workType, saved.workType);
  assert.deepEqual(JSON.parse(fs.readFileSync(common.CONFIG_PATH, "utf8")), { ...saved, baseUrl: origin });
  assert.equal(fs.readFileSync(common.EXPORT_PATH, "utf8"), "原有工时记录\r\n");
  fs.utimesSync(common.CONFIG_PATH, new Date("2020-01-01"), new Date("2020-01-01"));
  const modifiedAt = fs.statSync(common.CONFIG_PATH).mtimeMs;
  common.loadConfig();
  assert.equal(fs.statSync(common.CONFIG_PATH).mtimeMs, modifiedAt, "Dashboard polling must not keep rewriting the config");
});

test("copied portal links lose temporary auth parameters and still open the worktime routes", () => {
  for (const link of [portalLink, portalLink.replace(origin, "http://54.223.138.50:8089")]) {
    writeJson(common.CONFIG_PATH, { baseUrl: link, workflowId: 321 });
    assert.equal(common.loadConfig().baseUrl, origin);
    assert.deepEqual(JSON.parse(fs.readFileSync(common.CONFIG_PATH, "utf8")), { baseUrl: origin, workflowId: 321 });
    const urls = assistant.createUrls({ baseUrl: link, workflowId: 321 });
    assert.match(urls.add, /#\/main\/workflow\/add\?/);
    assert.match(urls.done, /#\/main\/workflow\/listDone\?/);
    assert.equal(new URL(urls.create).pathname, "/spa/workflow/static4form/index.html");
    assert.match(urls.create, /workflowid=321&/);
    for (const url of Object.values(urls)) {
      assert.equal(new URL(url).origin, origin);
      assert.doesNotMatch(url, /em_auth_|TEST-ONLY|portal-4-3/);
      assert.equal((url.match(/\/wui\/index\.html/g) || []).length <= 1, true);
    }
  }
});

test("custom OA hosts and ports are preserved while the official HTTP address upgrades", () => {
  assert.equal(common.normalizeBaseUrl("http://oa.test:8080/"), "http://oa.test:8080");
  assert.equal(common.normalizeBaseUrl("https://custom.example:8443/wui/index.html?em_auth_code=TEST-ONLY"), "https://custom.example:8443");
  assert.equal(common.normalizeBaseUrl("http://oa.mech-mind.com.cn/wui/index.html"), origin);
});

test("restoring an archived account also migrates its old OA URL", () => {
  const saved = { ...common.DEFAULT_CONFIG, account, hours: "5.5", remark: "甲的默认值" };
  writeJson(common.CONFIG_PATH, saved);
  fs.writeFileSync(common.EXPORT_PATH, "甲的记录", "utf8");
  const other = { ...account, employeeNo: "TEST002", name: "测试乙" };
  common.syncAccount(other);
  const archivePath = path.join(directory, "accounts", Buffer.from(common.accountKey(account)).toString("base64url"), "worktime.config.json");
  writeJson(archivePath, { ...saved, baseUrl: "http://54.223.138.50:8089" });
  common.syncAccount(account);
  const restored = JSON.parse(fs.readFileSync(common.CONFIG_PATH, "utf8"));
  assert.equal(restored.baseUrl, origin);
  assert.equal(restored.hours, "5.5");
  assert.equal(restored.remark, saved.remark);
  assert.equal(restored.account.employeeNo, account.employeeNo);
  assert.equal(fs.readFileSync(common.EXPORT_PATH, "utf8"), "甲的记录");
});

test("invalid OA URLs fail clearly without overwriting the original config", () => {
  for (const baseUrl of ["not-a-url", "file:///tmp/oa", "javascript:alert(1)", "https://user:password@oa.test"]) {
    const saved = { baseUrl, hours: "7.0" };
    writeJson(common.CONFIG_PATH, saved);
    assert.throws(() => common.loadConfig(), /OA 地址/);
    assert.deepEqual(JSON.parse(fs.readFileSync(common.CONFIG_PATH, "utf8")), saved);
  }
});
