"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");

const MAX_INSTALLER_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_HOSTS = new Set(["github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

function normalizeRepository(value) {
  let repository = String(value || "").trim();
  if (!repository) return "";
  if (repository.startsWith("https://github.com/")) {
    const url = new URL(repository);
    if (url.search || url.hash || url.username || url.password || url.port) throw new Error("请填写 GitHub 仓库地址或“账号/仓库名”。");
    repository = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || repository.endsWith("/.") || repository.endsWith("/..")) {
    throw new Error("请填写 GitHub 仓库地址或“账号/仓库名”。");
  }
  return repository;
}

function parseVersion(value) {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(String(value));
  if (!match) throw new Error("更新版本格式无效，只支持正式发布的数字版本。");
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

function validateGithubUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !DOWNLOAD_HOSTS.has(url.hostname) || url.port || url.username || url.password) throw new Error("更新下载地址不属于 GitHub，已停止下载。");
  return url;
}

function validateAssetUrl(value, repository, tag, fileName) {
  const expected = `https://github.com/${repository}/releases/download/${tag}/${fileName}`;
  if (String(value) !== expected) throw new Error("更新文件不属于指定仓库的该版本，已停止。");
  return expected;
}

async function fileDigest(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

class UpdateManager {
  constructor({ appRoot, dataRoot, isBusy = () => false, fetchImpl = fetch, launchInstaller, checkTimeoutMs = 12_000, downloadTimeoutMs = 180_000 }) {
    this.appRoot = appRoot;
    this.dataRoot = dataRoot;
    this.isBusy = isBusy;
    this.fetchImpl = fetchImpl;
    this.launchInstaller = launchInstaller || ((file, asset) => this.launch(file, asset));
    this.checkTimeoutMs = checkTimeoutMs;
    this.downloadTimeoutMs = downloadTimeoutMs;
    this.operation = null;
    this.asset = null;
    this.downloadedFile = null;
    this.currentVersion = fs.existsSync(path.join(appRoot, "VERSION")) ? fs.readFileSync(path.join(appRoot, "VERSION"), "utf8").trim() : "0.0.0";
    parseVersion(this.currentVersion);
    this.state = { status: "idle", currentVersion: this.currentVersion, latestVersion: null, checkedAt: null, error: null,
      releaseNotes: "", releaseUrl: null, downloadedBytes: 0, totalBytes: 0, percent: 0 };
    try { this.repository = this.readRepository(); } catch (error) { this.repository = ""; this.state.error = error.message; }
    if (!this.repository) this.state.status = "not_configured";
    this.lastInstall = this.readLastInstall();
  }

  readRepository() {
    for (const file of [path.join(this.dataRoot, "update-source.json"), path.join(this.appRoot, "update-source.json")]) {
      if (fs.existsSync(file)) return normalizeRepository(JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")).repository);
    }
    return "";
  }

  readLastInstall() {
    try {
      const result = JSON.parse(fs.readFileSync(path.join(this.dataRoot, "updates", "install-result.json"), "utf8").replace(/^\uFEFF/, ""));
      return { success: result.success === true, version: String(result.version || ""), completedAt: String(result.completedAt || ""), requiresAttention: result.requiresAttention === true,
        error: result.success ? null : String(result.error || "上次更新未完成。") };
    } catch { return null; }
  }

  installedMode() {
    try { return fs.readFileSync(path.join(this.appRoot, "worktime-app.marker"), "utf8").trim() === "MechMindWorktimeAssistant" && fs.existsSync(path.join(this.appRoot, "runtime", "node.exe")); } catch { return false; }
  }

  snapshot() {
    // An installer failure may leave this service alive. Read the helper result
    // so a failed attempt does not permanently lock the existing installation.
    if (this.installing() && this.installStartedAt) {
      const result = this.readLastInstall();
      if (result && result.version === this.asset?.version && Date.parse(result.completedAt) >= this.installStartedAt) {
        this.lastInstall = result;
        if (!result.success) {
          this.state.error = result.requiresAttention ? "安装超时，请先检查安装进程和版本，再重新启动工时助手。" : `更新未完成：${result.error}`;
          if (!result.requiresAttention) this.state.status = "error";
        }
      }
    }
    return { ...this.state, repository: this.repository, canInstall: this.installedMode(), lastInstall: this.lastInstall };
  }
  installing() { return this.state.status === "installing"; }

  configure(repository) {
    if (this.operation || this.installing()) throw Object.assign(new Error("更新操作正在进行，请稍后修改来源。"), { statusCode: 409 });
    let normalized;
    try { normalized = normalizeRepository(repository); } catch (error) { error.statusCode = 400; throw error; }
    fs.mkdirSync(this.dataRoot, { recursive: true });
    const file = path.join(this.dataRoot, "update-source.json");
    fs.writeFileSync(file + ".tmp", JSON.stringify({ repository: normalized }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
    this.repository = normalized;
    this.asset = null;
    this.downloadedFile = null;
    Object.assign(this.state, { status: normalized ? "idle" : "not_configured", latestVersion: null, checkedAt: null, error: null, releaseNotes: "", releaseUrl: null, downloadedBytes: 0, totalBytes: 0, percent: 0 });
    return this.snapshot();
  }

  async response(url, signal) {
    let target = validateGithubUrl(url);
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await this.fetchImpl(target.href, { signal, redirect: "manual", headers: {
        "User-Agent": `MechMindWorktimeAssistant/${this.currentVersion}`, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
      } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error("更新下载跳转缺少地址，已停止。");
        target = validateGithubUrl(new URL(location, target).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404) throw new Error("未找到可访问的正式版本；请核对仓库、发布状态及私有仓库权限。");
        if ([403, 429].includes(response.status)) throw new Error("GitHub 暂时限制访问，请稍后手动检查更新。");
        throw new Error(`更新服务返回 ${response.status}，本次更新已停止。`);
      }
      return response;
    }
    throw new Error("更新下载跳转次数过多，已停止。");
  }

  async textResponse(url, signal, limit = 1024 * 1024) {
    const response = await this.response(url, signal);
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > limit) throw new Error("更新信息过大，已停止读取。");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  check() {
    if (this.operation) return this.operation;
    if (this.installing()) return Promise.resolve(this.snapshot());
    if (!this.repository) { this.state.status = "not_configured"; return Promise.resolve(this.snapshot()); }
    this.state.status = "checking";
    this.state.error = null;
    this.asset = null;
    this.downloadedFile = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.checkTimeoutMs);
    this.operation = (async () => {
      try {
        const release = JSON.parse(await this.textResponse(`https://api.github.com/repos/${this.repository}/releases/latest`, controller.signal));
        if (release.draft || release.prerelease) throw new Error("更新来源返回测试版或草稿，已停止。");
        const version = parseVersion(release.tag_name).join(".");
        const fileName = `WorktimeAssistant-Setup-${version}.exe`;
        Object.assign(this.state, { latestVersion: version, checkedAt: new Date().toISOString(), releaseNotes: String(release.body || "").slice(0, 6000), releaseUrl: `https://github.com/${this.repository}/releases/tag/${release.tag_name}` });
        if (compareVersions(version, this.currentVersion) <= 0) { this.asset = null; this.downloadedFile = null; this.state.status = "up_to_date"; return this.snapshot(); }
        const asset = release.assets?.find((item) => item.name === fileName && item.state === "uploaded");
        if (!asset || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_INSTALLER_BYTES) throw new Error("新版缺少有效安装包，请联系发布者补齐文件。");
        const url = validateAssetUrl(asset.browser_download_url, this.repository, release.tag_name, fileName);
        let sha256 = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || "")?.[1]?.toLowerCase();
        if (!sha256) {
          const checksum = release.assets.find((item) => item.name === fileName + ".sha256" && item.state === "uploaded");
          if (!checksum) throw new Error("新版缺少 SHA-256 校验信息，已停止下载。");
          const checksumUrl = validateAssetUrl(checksum.browser_download_url, this.repository, release.tag_name, checksum.name);
          const text = (await this.textResponse(checksumUrl, controller.signal, 1024)).trim();
          const match = /^([a-f0-9]{64})\s+\*?([^\r\n]+)$/i.exec(text);
          if (!match || match[2] !== fileName) throw new Error("新版校验文件与安装包不匹配。");
          sha256 = match[1].toLowerCase();
        }
        this.asset = { version, fileName, url, bytes: asset.size, sha256 };
        this.downloadedFile = null;
        Object.assign(this.state, { status: "available", totalBytes: asset.size, downloadedBytes: 0, percent: 0 });
      } catch (error) {
        this.state.status = "error";
        this.state.error = controller.signal.aborted ? "检查更新超时，仍可继续使用工时助手。" : error.message;
        this.state.checkedAt = new Date().toISOString();
      } finally { clearTimeout(timer); this.operation = null; }
      return this.snapshot();
    })();
    return this.operation;
  }

  download() {
    if (this.operation || this.installing()) throw Object.assign(new Error("更新操作正在进行，请勿重复操作。"), { statusCode: 409 });
    if (!this.asset || compareVersions(this.asset.version, this.currentVersion) <= 0) throw Object.assign(new Error("请先检查并选择可用的新版本。"), { statusCode: 400 });
    const asset = { ...this.asset };
    this.state.status = "downloading";
    Object.assign(this.state, { error: null, downloadedBytes: 0, percent: 0 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.downloadTimeoutMs);
    this.operation = (async () => {
      const folder = path.join(this.dataRoot, "updates");
      const target = path.join(folder, asset.fileName);
      const partial = target + ".part";
      let handle;
      try {
        fs.mkdirSync(folder, { recursive: true });
        const response = await this.response(asset.url, controller.signal);
        handle = await fs.promises.open(partial, "w", 0o600);
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > asset.bytes || bytes > MAX_INSTALLER_BYTES) throw new Error("下载的安装包大小异常，已停止。");
          hash.update(chunk);
          await handle.writeFile(chunk);
          this.state.downloadedBytes = bytes;
          this.state.percent = Math.floor(bytes / asset.bytes * 100);
        }
        await handle.close(); handle = null;
        if (bytes !== asset.bytes || hash.digest("hex") !== asset.sha256) throw new Error("安装包校验失败，请重新检查更新后下载。");
        await fs.promises.rename(partial, target);
        this.downloadedFile = target;
        this.state.status = "ready";
      } catch (error) {
        this.downloadedFile = null;
        this.state.status = "error";
        this.state.error = controller.signal.aborted ? "下载更新超时，本次未安装；可稍后重新下载。" : error.message;
      } finally {
        await handle?.close().catch(() => {});
        await fs.promises.rm(partial, { force: true }).catch(() => {});
        clearTimeout(timer); this.operation = null;
      }
      return this.snapshot();
    })();
    return this.operation;
  }

  async install() {
    if (this.operation || this.installing()) throw Object.assign(new Error("更新操作正在进行，请勿重复操作。"), { statusCode: 409 });
    if (this.isBusy()) throw Object.assign(new Error("正在填报、同步或登录，请任务结束后再安装更新。"), { statusCode: 409 });
    if (!this.installedMode()) throw Object.assign(new Error("当前是源码运行，请使用安装版进行覆盖升级。"), { statusCode: 400 });
    if (this.state.status !== "ready" || !this.downloadedFile || !this.asset) throw Object.assign(new Error("请先下载并校验新版安装包。"), { statusCode: 400 });
    this.state.status = "installing";
    this.installStartedAt = Date.now();
    try {
      if (fs.statSync(this.downloadedFile).size !== this.asset.bytes || await fileDigest(this.downloadedFile) !== this.asset.sha256) throw new Error("下载文件已变化，校验失败，本次未安装。");
      if (this.isBusy()) throw new Error("任务状态已变化，请任务结束后再安装更新。");
      await this.launchInstaller(this.downloadedFile, this.asset);
    } catch (error) { this.state.status = "error"; this.state.error = error.message; throw error; }
    return this.snapshot();
  }

  launch(file, asset) {
    return new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", path.join(this.appRoot, "apply-update.ps1"),
        "-InstallerPath", file, "-InstallRoot", this.appRoot, "-DataRoot", this.dataRoot, "-ExpectedSha256", asset.sha256, "-ExpectedVersion", asset.version],
      { windowsHide: true, detached: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
  }
}

module.exports = { UpdateManager, normalizeRepository, parseVersion, compareVersions, validateGithubUrl, fileDigest };
