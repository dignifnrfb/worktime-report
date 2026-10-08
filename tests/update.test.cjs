"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { test } = require("node:test");
const { UpdateManager, normalizeRepository, compareVersions } = require("../worktime-update.cjs");
const { temporaryDirectory, removeTemporary, writeJson } = require("./test-support.cjs");
const repository = "test-owner/worktime";
const payload = Buffer.from("simulated installer, never executed");
const digest = createHash("sha256").update(payload).digest("hex");
function release(version = "1.4.0") {
  const name = `WorktimeAssistant-Setup-${version}.exe`;
  return { tag_name: `v${version}`, body: "更新说明", draft: false, prerelease: false, assets: [{ name, state: "uploaded", size: payload.length,
    digest: `sha256:${digest}`, browser_download_url: `https://github.com/${repository}/releases/download/v${version}/${name}` }] };
}
function fixture(t, options = {}) {
  const root = temporaryDirectory("update");
  t.after(() => removeTemporary(root));
  const appRoot = path.join(root, "app 中文"), dataRoot = path.join(root, "data 中文");
  fs.mkdirSync(path.join(appRoot, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(appRoot, "VERSION"), "1.3.0");
  fs.writeFileSync(path.join(appRoot, "runtime", "node.exe"), "test marker only");
  fs.writeFileSync(path.join(appRoot, "worktime-app.marker"), "MechMindWorktimeAssistant");
  writeJson(path.join(appRoot, "update-source.json"), { repository });
  const calls = [], launches = [];
  const manager = new UpdateManager({ appRoot, dataRoot, fetchImpl: async (url) => { calls.push(url); return url.includes("/releases/latest") ? Response.json(release()) : new Response(payload); },
    launchInstaller: async (file, asset) => { launches.push({ file, asset }); }, ...options });
  return { manager, root, appRoot, dataRoot, calls, launches };
}

test("repository normalization and numeric versions reject unsupported sources and versions", () => {
  assert.equal(normalizeRepository(" https://github.com/test-owner/worktime.git/ "), repository);
  assert.equal(compareVersions("1.10.0", "1.9.99"), 1);
  for (const value of ["http://github.com/a/b", "https://github.com/a/b?token=x", "a/..", "a/b/c", "https://evil.test/a/b"]) assert.throws(() => normalizeRepository(value));
  for (const value of ["1.2", "v1.2.3-beta", "../../1"]) assert.throws(() => compareVersions(value, "1.3.0"));
});
test("unconfigured startup is non-blocking and makes no network request", async (t) => {
  const f = fixture(t); f.manager.configure("");
  assert.equal((await f.manager.check()).status, "not_configured"); assert.equal(f.calls.length, 0);
});
test("stable release downloads, verifies and launches once while preserving personal files", async (t) => {
  const f = fixture(t); writeJson(path.join(f.dataRoot, "worktime.config.json"), { privateSetting: "keep" });
  const before = fs.readFileSync(path.join(f.dataRoot, "worktime.config.json"), "utf8");
  assert.equal((await f.manager.check()).status, "available");
  assert.equal((await f.manager.download()).status, "ready"); assert.equal(f.manager.snapshot().percent, 100);
  assert.equal((await f.manager.install()).status, "installing");
  await assert.rejects(f.manager.install(), /正在进行/); assert.equal(f.launches.length, 1);
  assert.equal(fs.readFileSync(path.join(f.dataRoot, "worktime.config.json"), "utf8"), before);
});
test("same and older releases never offer a downgrade", async (t) => {
  for (const version of ["1.3.0", "1.2.9"]) {
    const f = fixture(t, { fetchImpl: async () => Response.json(release(version)) });
    assert.equal((await f.manager.check()).status, "up_to_date"); assert.throws(() => f.manager.download(), /先检查/);
  }
});
test("drafts, prereleases, missing installer and foreign asset URLs fail closed", async (t) => {
  for (const change of [r => { r.draft = true; }, r => { r.prerelease = true; }, r => { r.assets = []; }, r => { r.assets[0].browser_download_url = "https://github.com/other/repo/releases/download/v1.4.0/a.exe"; }, r => { r.assets[0].size = 200 * 1024 * 1024; }]) {
    const r = release(); change(r); const f = fixture(t, { fetchImpl: async () => Response.json(r) });
    assert.equal((await f.manager.check()).status, "error"); assert.throws(() => f.manager.download(), /先检查/);
  }
});
test("checksum sidecar is used when API digest is absent and must match the file", async (t) => {
  const r = release(); delete r.assets[0].digest;
  r.assets.push({ name: r.assets[0].name + ".sha256", state: "uploaded", browser_download_url: r.assets[0].browser_download_url + ".sha256" });
  const f = fixture(t, { fetchImpl: async (url) => url.endsWith("latest") ? Response.json(r) : new Response(`${digest} *${r.assets[0].name}\n`) });
  assert.equal((await f.manager.check()).status, "available");
  f.manager.fetchImpl = async (url) => url.endsWith("latest") ? Response.json(r) : new Response(`${digest} *other.exe`);
  assert.equal((await f.manager.check()).status, "error"); assert.throws(() => f.manager.download(), /先检查/);
});
test("missing digest and checksum never allow a download", async (t) => {
  const r = release(); delete r.assets[0].digest;
  const f = fixture(t, { fetchImpl: async () => Response.json(r) });
  assert.match((await f.manager.check()).error, /校验信息/);
});
test("failed recheck clears a formerly available installer", async (t) => {
  const f = fixture(t); await f.manager.check();
  f.manager.fetchImpl = async () => { throw new Error("offline"); };
  assert.equal((await f.manager.check()).status, "error"); assert.throws(() => f.manager.download(), /先检查/);
});
test("network errors, rate limits, private repositories and timeout remain recoverable", async (t) => {
  for (const status of [404, 403, 429, 500]) {
    const f = fixture(t, { fetchImpl: async () => new Response("unavailable", { status }) });
    assert.equal((await f.manager.check()).status, "error"); assert.ok(f.manager.snapshot().error);
  }
  const f = fixture(t, { checkTimeoutMs: 20, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) });
  assert.match((await f.manager.check()).error, /超时/); assert.equal(f.manager.operation, null);
});
test("redirects are limited to HTTPS GitHub hosts and require a location", async (t) => {
  for (const location of ["https://evil.test/install.exe", "http://github.com/file", "https://user:pass@github.com/file", null]) {
    const f = fixture(t); await f.manager.check();
    f.manager.fetchImpl = async () => new Response(null, { status: 302, headers: location ? { location } : {} });
    assert.equal((await f.manager.download()).status, "error"); assert.equal(f.manager.downloadedFile, null);
  }
});
test("valid GitHub asset redirects are accepted", async (t) => {
  const f = fixture(t); await f.manager.check();
  f.manager.fetchImpl = async (url) => url.startsWith("https://github.com/") ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/file" } }) : new Response(payload);
  assert.equal((await f.manager.download()).status, "ready");
});
test("truncated, oversized and corrupt downloads clean partial files and never install", async (t) => {
  for (const body of [payload.subarray(0, 4), Buffer.concat([payload, payload]), Buffer.alloc(payload.length)]) {
    const f = fixture(t); await f.manager.check(); f.manager.fetchImpl = async () => new Response(body);
    assert.equal((await f.manager.download()).status, "error");
    assert.equal(fs.readdirSync(path.join(f.dataRoot, "updates")).length, 0); await assert.rejects(f.manager.install(), /先下载/);
  }
});
test("download emits partial progress and serializes repeated requests", async (t) => {
  const f = fixture(t); await f.manager.check(); let controller;
  f.manager.fetchImpl = async () => new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(payload.subarray(0, 10)); } }));
  const pending = f.manager.download();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.manager.snapshot().downloadedBytes, 10); assert.equal(f.manager.snapshot().percent, Math.floor(10 / payload.length * 100));
  assert.throws(() => f.manager.download(), /正在进行/); assert.throws(() => f.manager.configure(repository), /正在进行/);
  controller.enqueue(payload.subarray(10)); controller.close(); assert.equal((await pending).status, "ready");
});
test("download timeout cleans partial state and allows a later check", async (t) => {
  const f = fixture(t, { downloadTimeoutMs: 20 }); await f.manager.check();
  f.manager.fetchImpl = async (_url, { signal }) => new Response(new ReadableStream({ start(c) { signal.addEventListener("abort", () => c.error(new Error("aborted")), { once: true }); } }));
  assert.match((await f.manager.download()).error, /超时/); assert.equal(f.manager.operation, null);
  assert.equal(fs.readdirSync(path.join(f.dataRoot, "updates")).length, 0);
});
test("busy work, tampering and development mode block installation", async (t) => {
  let busy = false; const f = fixture(t, { isBusy: () => busy }); await f.manager.check(); await f.manager.download();
  busy = true; await assert.rejects(f.manager.install(), /任务结束/); assert.equal(f.manager.snapshot().status, "ready");
  busy = false; fs.writeFileSync(f.manager.downloadedFile, Buffer.alloc(payload.length));
  await assert.rejects(f.manager.install(), /文件已变化/); assert.equal(f.launches.length, 0);
  const dev = fixture(t); await dev.manager.check(); await dev.manager.download(); fs.unlinkSync(path.join(dev.appRoot, "worktime-app.marker"));
  await assert.rejects(dev.manager.install(), /源码运行/);
});
test("concurrent checks share one request and installation locks before verification", async (t) => {
  const f = fixture(t); const first = f.manager.check(); assert.equal(f.manager.check(), first); await first; assert.equal(f.calls.length, 1);
  await f.manager.download(); const install = f.manager.install(); assert.equal(f.manager.installing(), true);
  await assert.rejects(f.manager.install(), /正在进行/); await install; assert.equal(f.launches.length, 1);
});
test("local source override and last installation result survive service restart", (t) => {
  const f = fixture(t); f.manager.configure("new-owner/new-repo");
  writeJson(path.join(f.dataRoot, "updates", "install-result.json"), { success: false, version: "1.4.0", error: "install failed", completedAt: "2026-09-30" });
  const restarted = new UpdateManager({ appRoot: f.appRoot, dataRoot: f.dataRoot });
  assert.equal(restarted.snapshot().repository, "new-owner/new-repo"); assert.equal(restarted.snapshot().lastInstall.error, "install failed");
  assert.equal(restarted.snapshot().status, "idle");
});

test("Windows update helper preserves the install path and restarts only after a completed attempt", { skip: process.platform !== "win32" }, (t) => {
  const { spawnSync } = require("node:child_process");
  for (const scenario of ["success", "failed", "timeout", "tampered"]) {
    const f = fixture(t);
    const updateFile = path.join(f.dataRoot, "updates", "WorktimeAssistant-Setup-1.4.0.exe");
    fs.mkdirSync(path.dirname(updateFile), { recursive: true });
    fs.writeFileSync(updateFile, scenario === "tampered" ? "changed" : payload);
    fs.writeFileSync(path.join(f.appRoot, "launcher.ps1"), "# mock only");
    const runner = path.join(f.root, "helper-runner.ps1");
    const capture = path.join(f.root, "calls.jsonl");
    fs.writeFileSync(runner, `param([string]$Helper,[string]$AppRoot,[string]$DataRoot,[string]$Installer,[string]$Hash,[string]$Scenario,[string]$Capture)
$ErrorActionPreference = 'Stop'
function Start-Process {
  param([string]$FilePath,[string[]]$ArgumentList,[string]$WindowStyle,[switch]$PassThru)
  @{file=$FilePath;arguments=$ArgumentList;window=$WindowStyle} | ConvertTo-Json -Compress | Add-Content -LiteralPath $Capture -Encoding UTF8
  if ($FilePath -eq $Installer) {
    if ($Scenario -eq 'success') { Set-Content -LiteralPath (Join-Path $AppRoot 'VERSION') -Value '1.4.0' -Encoding ASCII }
    $mock = [pscustomobject]@{ExitCode=$(if ($Scenario -eq 'failed') { 5 } else { 0 }); Scenario=$Scenario}
    $mock | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($timeout) return $this.Scenario -ne 'timeout' }
    return $mock
  }
}
& $Helper -InstallerPath $Installer -InstallRoot $AppRoot -DataRoot $DataRoot -ExpectedSha256 $Hash -ExpectedVersion '1.4.0'
if ($LASTEXITCODE) { exit $LASTEXITCODE }
`, "utf8");
    const child = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner,
      "-Helper", path.resolve(__dirname, "../installer/apply-update.ps1"), "-AppRoot", f.appRoot, "-DataRoot", f.dataRoot, "-Installer", updateFile,
      "-Hash", digest, "-Scenario", scenario, "-Capture", capture], { encoding: "utf8", windowsHide: true, timeout: 45000 });
    assert.equal(child.error, undefined);
    const result = JSON.parse(fs.readFileSync(path.join(f.dataRoot, "updates", "install-result.json"), "utf8").replace(/^\uFEFF/, ""));
    assert.equal(result.success, scenario === "success", JSON.stringify(result));
    assert.equal(child.status, scenario === "success" ? 0 : 1, child.stderr);
    const calls = fs.existsSync(capture) ? fs.readFileSync(capture, "utf8").replace(/^\uFEFF/, "").trim().split(/\r?\n/).map(line => JSON.parse(line.replace(/^\uFEFF/, ""))) : [];
    const installers = calls.filter(call => call.file === updateFile);
    assert.equal(installers.length, scenario === "tampered" ? 0 : 1);
    if (installers.length) assert.deepEqual(installers[0].arguments, ["/S", `/D=${f.appRoot}`]);
    assert.equal(calls.filter(call => call.file === "powershell.exe").length, scenario === "timeout" ? 0 : 1);
    assert.ok(calls.every(call => call.window === "Hidden"));
  }
});

test("a surviving service reads helper failures while timed-out installations remain locked", async (t) => {
  for (const requiresAttention of [false, true]) {
    const f = fixture(t); await f.manager.check(); await f.manager.download(); await f.manager.install();
    const resultFile = path.join(f.dataRoot, "updates", "install-result.json");
    writeJson(resultFile, { success: false, version: "1.4.0", completedAt: new Date(Date.now() - 10000).toISOString(), error: "previous failure" });
    assert.equal(f.manager.snapshot().status, "installing", "An old result must not unlock this attempt");
    writeJson(resultFile, { success: false, version: "1.4.0", completedAt: new Date(Date.now() + 100).toISOString(), error: "installer failed", requiresAttention });
    assert.equal(f.manager.snapshot().status, requiresAttention ? "attention_required" : "error");
    assert.equal(f.manager.snapshot().lastInstall.error, "installer failed");
    assert.equal(f.manager.installing(), requiresAttention);
  }
});

test("completed installation on a surviving old service requests restart and the new service clears the lock", async (t) => {
  const f = fixture(t); await f.manager.check(); await f.manager.download(); await f.manager.install();
  fs.writeFileSync(path.join(f.appRoot, "VERSION"), "1.4.0");
  writeJson(path.join(f.dataRoot, "updates", "install-result.json"), { success: true, version: "1.4.0", completedAt: new Date(Date.now() + 100).toISOString() });
  assert.equal(f.manager.snapshot().status, "restart_required");
  assert.equal(f.manager.snapshot().currentVersion, "1.3.0", "The old runtime must not pretend it has restarted");
  assert.match(f.manager.installationMessage(), /已安装完成.*重新打开/);
  assert.equal(f.manager.installing(), true);
  await assert.rejects(f.manager.install(), /正在进行/);
  const restarted = new UpdateManager({ appRoot: f.appRoot, dataRoot: f.dataRoot, fetchImpl: async () => Response.json(release()) });
  assert.equal((await restarted.check()).status, "up_to_date");
  assert.equal(restarted.installing(), false);
  assert.equal(restarted.snapshot().lastInstall.success, true);
});

test("installation success with a mismatching installed version requests inspection", async (t) => {
  const f = fixture(t); await f.manager.check(); await f.manager.download(); await f.manager.install();
  writeJson(path.join(f.dataRoot, "updates", "install-result.json"), { success: true, version: "1.4.0", completedAt: new Date(Date.now() + 100).toISOString() });
  assert.equal(f.manager.snapshot().status, "attention_required");
  assert.match(f.manager.installationMessage(), /版本不一致/);
  assert.equal(f.manager.installing(), true);
});

test("missing installation results stop indefinite waiting without authorizing another installer", async (t) => {
  const f = fixture(t); await f.manager.check(); await f.manager.download(); await f.manager.install();
  f.manager.installStartedAt -= 150_001;
  assert.equal(f.manager.snapshot().status, "attention_required");
  assert.match(f.manager.installationMessage(), /未收到安装完成结果/);
  await assert.rejects(f.manager.install(), /正在进行/);
  assert.equal(f.launches.length, 1);
  // A late verified outcome replaces the unknown result without relaunching.
  fs.writeFileSync(path.join(f.appRoot, "VERSION"), "1.4.0");
  writeJson(path.join(f.dataRoot, "updates", "install-result.json"), { success: true, version: "1.4.0", completedAt: new Date().toISOString() });
  assert.equal(f.manager.snapshot().status, "restart_required");
});

test("operation-lock checks detect an ordinary helper failure before a dashboard poll", async (t) => {
  const f = fixture(t); await f.manager.check(); await f.manager.download(); await f.manager.install();
  writeJson(path.join(f.dataRoot, "updates", "install-result.json"), { success: false, version: "1.4.0", completedAt: new Date(Date.now() + 100).toISOString(), error: "Access denied", requiresAttention: false });
  assert.equal(f.manager.installing(), false);
  assert.equal(f.manager.snapshot().status, "error");
  assert.match(f.manager.snapshot().error, /Access denied/);
});

test("a missing helper fails immediately before starting PowerShell", async (t) => {
  const f = fixture(t, { launchInstaller: undefined });
  await f.manager.check(); await f.manager.download();
  await assert.rejects(f.manager.install(), /安装助手文件缺失/);
  assert.equal(f.manager.snapshot().status, "error");
  assert.equal(f.manager.installing(), false);
});

test("the real hidden Windows helper executes and records checksum failure without starting an installer", { skip: process.platform !== "win32" }, async (t) => {
  const f = fixture(t, { launchInstaller: undefined });
  fs.copyFileSync(path.resolve(__dirname, "../installer/apply-update.ps1"), path.join(f.appRoot, "apply-update.ps1"));
  await f.manager.check(); await f.manager.download();
  f.manager.state.status = "installing";
  f.manager.installStartedAt = Date.now();
  // Intentionally wrong helper checksum: the simulated installer cannot run.
  await f.manager.launch(f.manager.downloadedFile, { ...f.manager.asset, sha256: "0".repeat(64) });
  const resultFile = path.join(f.dataRoot, "updates", "install-result.json");
  for (let attempt = 0; attempt < 100 && !fs.existsSync(resultFile); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(resultFile), true, "PowerShell must execute the real helper rather than silently exit before -File");
  const result = JSON.parse(fs.readFileSync(resultFile, "utf8").replace(/^\uFEFF/, ""));
  assert.equal(result.success, false);
  assert.match(result.error, /checksum changed/);
  assert.equal(result.version, f.manager.asset.version);
  assert.equal(f.manager.snapshot().status, "error");
  assert.equal(f.manager.installing(), false);
});

test("the real hidden helper survives its Node parent exiting and preserves literal Windows paths", { skip: process.platform !== "win32" }, async (t) => {
  const { spawnSync } = require("node:child_process");
  const f = fixture(t);
  const appRoot = path.join(f.root, "app ' & % Space 中文");
  fs.mkdirSync(appRoot);
  fs.writeFileSync(path.join(appRoot, "VERSION"), "1.3.0");
  fs.writeFileSync(path.join(appRoot, "apply-update.ps1"), `param([string]$InstallerPath,[string]$InstallRoot,[string]$DataRoot,[string]$ExpectedSha256,[string]$ExpectedVersion)
Start-Sleep -Milliseconds 1200
@{ appRoot=$InstallRoot; dataRoot=$DataRoot; file=$InstallerPath; version=$ExpectedVersion; completedAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $DataRoot 'helper-survived.json') -Encoding UTF8
`);
  const file = path.join(f.dataRoot, "not-an-installer.exe");
  fs.mkdirSync(f.dataRoot, { recursive: true });
  const parent = path.join(f.root, "launch-parent.cjs");
  fs.writeFileSync(parent, `const {UpdateManager}=require(${JSON.stringify(path.resolve(__dirname, "../worktime-update.cjs"))});
const manager=new UpdateManager({appRoot:${JSON.stringify(appRoot)},dataRoot:${JSON.stringify(f.dataRoot)}});
manager.launch(${JSON.stringify(file)},{version:'1.4.0',sha256:'${"0".repeat(64)}'}).then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);});
`);
  const launched = spawnSync(process.execPath, [parent], { windowsHide: true, encoding: "utf8", timeout: 15000 });
  assert.equal(launched.status, 0, launched.stderr || launched.error?.message);
  const exitedAt = Date.now();
  const outcome = path.join(f.dataRoot, "helper-survived.json");
  for (let attempt = 0; attempt < 100 && !fs.existsSync(outcome); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(outcome), true, "The helper must continue after the old Node service exits");
  const result = JSON.parse(fs.readFileSync(outcome, "utf8").replace(/^\uFEFF/, ""));
  assert.equal(result.appRoot, appRoot);
  assert.equal(result.dataRoot, f.dataRoot);
  assert.equal(result.file, file);
  assert.equal(result.version, "1.4.0");
  assert.ok(Date.parse(result.completedAt) >= exitedAt);
});

test("an exited helper without a result requests inspection instead of endless installation", { skip: process.platform !== "win32" }, async (t) => {
  const f = fixture(t, { launchInstaller: undefined });
  fs.writeFileSync(path.join(f.appRoot, "apply-update.ps1"), "exit 1\n");
  await f.manager.check(); await f.manager.download(); await f.manager.install();
  for (let attempt = 0; attempt < 60 && f.manager.snapshot().status === "installing"; attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(f.manager.snapshot().status, "attention_required");
  assert.match(f.manager.installationMessage(), /安装助手已退出/);
  assert.equal(f.manager.installing(), true);
});
