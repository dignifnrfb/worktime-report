Unicode True
ManifestDPIAware True

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "TextFunc.nsh"

!ifndef STAGE
  !error "STAGE is required"
!endif
!ifndef OUTPUT
  !error "OUTPUT is required"
!endif
!ifndef ICON
  !error "ICON is required"
!endif
!ifndef STOP_SCRIPT
  !error "STOP_SCRIPT is required"
!endif
!ifndef APP_VERSION
  !error "APP_VERSION is required"
!endif
!ifndef CHECK_FILES
  !error "CHECK_FILES is required"
!endif
!ifndef UNINSTALL_FILES
  !error "UNINSTALL_FILES is required"
!endif

!ifndef APP_ID
  !define APP_ID "MechMindWorktimeAssistant"
!endif
!ifndef APP_NAME
  !define APP_NAME "工时助手"
!endif
!ifndef DEFAULT_INSTALL_DIR
  !define DEFAULT_INSTALL_DIR "$LOCALAPPDATA\Programs\MechMindWorktimeAssistant"
!endif

Name "${APP_NAME}"
OutFile "${OUTPUT}"
InstallDir "${DEFAULT_INSTALL_DIR}"
InstallDirRegKey HKCU "Software\MechMind\${APP_ID}" "InstallLocation"
RequestExecutionLevel user
AllowRootDirInstall true
SetCompressor /SOLID lzma
SetCompressorDictSize 64
CRCCheck on
XPStyle on
BrandingText "工时助手 · 本机安全运行"
Icon "${ICON}"
UninstallIcon "${ICON}"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "${APP_NAME}"
VIAddVersionKey /LANG=2052 "FileDescription" "${APP_NAME}安装程序"
VIAddVersionKey /LANG=2052 "CompanyName" "Mech-Mind 内部工具"
VIAddVersionKey /LANG=2052 "LegalCopyright" "仅供公司内部使用"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${APP_VERSION}"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $\"$INSTDIR\launcher.ps1$\""
!define MUI_FINISHPAGE_RUN_TEXT "安装完成后打开工时助手"
!define MUI_FINISHPAGE_LINK "查看本机隐私说明"
!define MUI_FINISHPAGE_LINK_LOCATION "$INSTDIR\PRIVACY.txt"

!insertmacro MUI_PAGE_WELCOME
!define MUI_DIRECTORYPAGE_TEXT_TOP "请选择工时助手的安装位置。支持磁盘根目录、中文和带空格的路径；建议使用独立文件夹，便于管理。个人登录信息保存在当前 Windows 用户下。"
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE DirectoryLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Function DirectoryLeave
  ; NSIS GetFullPathName returns empty for a directory that does not exist yet.
  ; The Windows API also normalizes new destination paths without creating them.
  System::Call 'kernel32::GetFullPathNameW(w "$INSTDIR", i ${NSIS_MAX_STRLEN}, w .r0, p 0) i.r1'
  ${If} $1 == 0
  ${OrIf} $1 >= ${NSIS_MAX_STRLEN}
  ${OrIf} $0 == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "安装路径无效或过长，请选择其他位置。" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  StrCpy $INSTDIR $0
  StrCpy $1 "$WINDIR\"
  StrLen $2 $1
  StrCpy $3 "$INSTDIR\" $2
  ${If} $3 == $1
    MessageBox MB_OK|MB_ICONEXCLAMATION "不能安装到 Windows 系统目录及其子目录。" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  IfFileExists "$INSTDIR\worktime-app.marker" 0 new_install
  FileOpen $4 "$INSTDIR\worktime-app.marker" r
  FileRead $4 $5
  FileClose $4
  ${TrimNewLines} "$5" $5
  StrCmp $5 "MechMindWorktimeAssistant" directory_ok
  StrCpy $9 "worktime-app.marker"
  Goto install_collision
  new_install:
  !include "${CHECK_FILES}"
  Goto directory_ok
  install_collision:
  MessageBox MB_OK|MB_ICONEXCLAMATION "所选位置已有同名文件：$9。为避免覆盖其他程序，请选择一个独立文件夹。" /SD IDOK
  SetErrorLevel 2
  Abort
  directory_ok:
FunctionEnd

Section "安装工时助手" SEC_MAIN
  ; Silent installations skip the directory page, so validate here as well.
  Call DirectoryLeave
  SetShellVarContext current
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=stop-service.ps1 "${STOP_SCRIPT}"
  ReadRegStr $7 HKCU "Software\MechMind\${APP_ID}" "InstallLocation"
  ${If} $7 != ""
  ${AndIf} $7 != $INSTDIR
    IfFileExists "$7\worktime-app.marker" 0 old_service_done
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\stop-service.ps1" -InstallRoot "$7\."'
  ${EndIf}
  old_service_done:
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\stop-service.ps1" -InstallRoot "$INSTDIR\."'

  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $\"$INSTDIR\launcher.ps1$\"' "$INSTDIR\worktime.ico" 0 SW_SHOWMINIMIZED
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $\"$INSTDIR\launcher.ps1$\"' "$INSTDIR\worktime.ico" 0 SW_SHOWMINIMIZED
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\卸载${APP_NAME}.lnk" "$INSTDIR\uninstall.exe" "" "$INSTDIR\worktime.ico"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\使用说明.lnk" "$INSTDIR\user-guide.pdf"

  WriteRegStr HKCU "Software\MechMind\${APP_ID}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "Publisher" "Mech-Mind 内部工具"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayIcon" "$INSTDIR\worktime.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "UninstallString" '$\"$INSTDIR\uninstall.exe$\"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  IfFileExists "$INSTDIR\worktime-app.marker" 0 unsafe_uninstall
  FileOpen $4 "$INSTDIR\worktime-app.marker" r
  FileRead $4 $5
  FileClose $4
  ${un.TrimNewLines} "$5" $5
  StrCmp $5 "MechMindWorktimeAssistant" 0 unsafe_uninstall
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\stop-service.ps1" -InstallRoot "$INSTDIR\."'

  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除钉钉登录状态、个人默认设置和已办缓存？$\n选择“否”可以在重新安装后继续使用。" /SD IDNO IDNO keep_personal_data
  RMDir /r "$LOCALAPPDATA\MechMindWorktimeAssistant"
  keep_personal_data:

  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\卸载${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\使用说明.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  DeleteRegKey HKCU "Software\MechMind\${APP_ID}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"

  ; The generated list contains only shipped files. Never recursively remove
  ; an installation directory: it may be a drive root or contain user files.
  !include "${UNINSTALL_FILES}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Goto uninstall_done
  unsafe_uninstall:
  MessageBox MB_OK|MB_ICONSTOP "未找到有效的工时助手安装标记，卸载已停止，安装目录没有被删除。" /SD IDOK
  SetErrorLevel 2
  uninstall_done:
SectionEnd
