# 工时填报

工时助手的源码和 Windows 安装包发布仓库。

[下载安装包](https://github.com/dignifnrfb/worktime-report/releases/latest) · [发布记录](https://github.com/dignifnrfb/worktime-report/releases)

Windows 本机工时工具：钉钉扫码登录公司 OA，核对已办工时，选择日期批量预演、提交和调整工作日。

## 安装和更新

从本仓库 Releases 下载 `WorktimeAssistant-Setup-版本.exe`。运行安装包，选择原安装位置即可覆盖升级；同一 Windows 用户的数据会保留，不必先卸载。

1.3.0 开始，每次启动检查本仓库的正式发布版本。“版本与更新”中可查看说明、下载进度、确认安装并重启。任务正在填报、同步或登录时无法安装。1.2.x 首次升级需要手动安装 1.3.0。

1.3.1 修复跨月补报时可能误选同一日号、随后等待超时的问题。日期选择根据 OA 日历实际年月切换，支持跨年；日期未生效时显示目标和实际日期。保留完整日期核对、重复填报校验及失败停止后续日期的行为。

1.3.2 修复更新后长期显示“正在安装”的问题。安装已完成但旧服务仍在运行时提示重新打开；安装助手缺失、退出或未返回结果时给出对应提示。旧页面等待新服务过久时提示检查安装结果，恢复连接后自动清除。安装结果不明确时不会自动再次启动安装。

GitHub 网络失败不影响普通填报。只安装数字正式版本，下载后核对大小及 SHA-256。安装失败不自动重试。

## 日常使用

先确认当前 OA 账户，等同步完成，再选择日期与工作类型。休假（004）无需选择项目；其他类型需选择项目搜索结果。先预演，再确认提交，进度显示日期、阶段和失败原因。

“已发起·待确认”需要同步核对，查到 OA 记录后才显示确认。进度达到 100% 不等于 OA 已确认全部成功。失败后停止后续日期，不自动重试。

真实 OA 休假项目字段规则尚待验收。如果 OA 仍要求项目，助手明确停止，不填入普通工作项目或绕过校验。

随包提供 [五页使用说明](output/pdf/工时助手使用说明.pdf)，开始菜单也可打开。

## 隐私

程序只监听 `127.0.0.1`。个人配置、OA 会话、项目缓存、工时记录和日志保存在 `%LOCALAPPDATA%\MechMindWorktimeAssistant`，不会提交到本仓库。更新检查只读取 GitHub 发布信息，不发送工时或 OA 账户。发布凭据只在 GitHub Actions 中使用，不放入安装包。

## 开发和发布

Windows 下需要 Node.js 24、pnpm 11.7.0、NSIS 3.12。安装依赖并验证：

```powershell
pnpm --dir dashboard install --frozen-lockfile
pnpm --dir dashboard run typecheck:portable
pnpm --dir dashboard run lint:portable
pnpm --dir dashboard run test:regression
powershell -NoProfile -File installer/build-installer.ps1 -Version 1.3.2 -GitHubRepository 账号/仓库名
powershell -NoProfile -File tests/installer.test.ps1
```

测试使用模拟 OA、GitHub 响应和隔离数据，不提交真实工时。覆盖更新下载、校验、忙碌时停止安装、安装助手和覆盖升级保留数据。

发布下一版时修改 `VERSION`，添加 `release-notes/版本.md`，更新使用说明。创建 `v版本` 标签或在 Actions 中运行发布流程。流程验证版本、运行测试、构建安装包和 `.sha256`，先上传到草稿，再发布为稳定版本。发布任务失败时检查 Actions；上传失败的草稿不会供软件检查到，不自动重新发布。

仓库及 Release 安装包需公开可下载，普通使用者才能免 GitHub 登录更新。私有仓库需另行设计访问授权。
