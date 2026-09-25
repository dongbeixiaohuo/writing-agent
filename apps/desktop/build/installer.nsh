!ifndef BUILD_UNINSTALLER

!include "getProcessInfo.nsh"

Var /GLOBAL pid
Var /GLOBAL waUpgradeNoticeShown
Var /GLOBAL waOrphanInstallPath
Var /GLOBAL waPreviousInstallDetected

!macro customInit
  StrCpy $waUpgradeNoticeShown "0"
  StrCpy $waOrphanInstallPath ""
  StrCpy $waPreviousInstallDetected "0"

  ReadRegStr $R8 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion"
  StrCmp $R8 "" 0 wa_upgrade_prompt_registered
  ReadRegStr $R8 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion"
  StrCmp $R8 "" wa_upgrade_prompt_shortcut wa_upgrade_prompt_registered

  wa_upgrade_prompt_registered:
    StrCpy $waUpgradeNoticeShown "1"
    StrCpy $waPreviousInstallDetected "1"
    IfSilent wa_upgrade_prompt_done
    StrCmp $R8 "${VERSION}" wa_upgrade_prompt_repair wa_upgrade_prompt_upgrade

  wa_upgrade_prompt_upgrade:
    MessageBox MB_OK|MB_ICONINFORMATION "检测到已安装 Writing Agent $R8。$\r$\n$\r$\n安装程序将升级到 ${VERSION}，并保留项目、设置和模型凭据。无需手工卸载旧版本。"
    Goto wa_upgrade_prompt_done

  wa_upgrade_prompt_repair:
    MessageBox MB_OK|MB_ICONINFORMATION "已安装 Writing Agent ${VERSION}。$\r$\n$\r$\n继续安装将修复当前版本，项目、设置和模型凭据会保留。"
    Goto wa_upgrade_prompt_done

  wa_upgrade_prompt_shortcut:
    IfFileExists "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" 0 wa_upgrade_prompt_done
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "$$paths=@([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'),'Writing Agent.lnk'),[IO.Path]::Combine([Environment]::GetFolderPath('Programs'),'Writing Agent.lnk')); $$link=$$paths | Where-Object { Test-Path -LiteralPath $$_ } | Select-Object -First 1; if($$null -ne $$link){$$shell=New-Object -ComObject WScript.Shell; [Console]::Out.Write($$shell.CreateShortcut($$link).TargetPath)}"`
    Pop $R6
    Pop $R7
    StrCmp $R6 "0" 0 wa_upgrade_prompt_done
    StrCmp $R7 "" wa_upgrade_prompt_done
    IfFileExists "$R7" 0 wa_upgrade_prompt_done
    Push "$R7"
    Call GetFileParent
    Pop $R9
    IfFileExists "$R9\Uninstall Writing Agent.exe" 0 wa_upgrade_prompt_done
    StrCpy $waOrphanInstallPath "$R9"
    StrCpy $INSTDIR "$R9"
    StrCpy $waUpgradeNoticeShown "1"
    StrCpy $waPreviousInstallDetected "1"
    IfSilent wa_upgrade_prompt_done
    MessageBox MB_OK|MB_ICONINFORMATION "检测到这个电脑上已有 Writing Agent，但旧安装记录不完整。$\r$\n$\r$\n安装程序将从原位置升级到 ${VERSION}，并保留项目、设置和模型凭据。无需手工卸载旧版本。"

  wa_upgrade_prompt_done:
!macroend

!macro customPageAfterChangeDir
  Page custom waCheckSelectedExistingInstall
!macroend

Function waCheckSelectedExistingInstall
  IfSilent wa_selected_install_done
  StrCmp $waUpgradeNoticeShown "1" wa_selected_install_done
  ReadRegStr $R8 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"
  StrCmp $R8 "" 0 wa_selected_install_done
  ReadRegStr $R8 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"
  StrCmp $R8 "" 0 wa_selected_install_done
  IfFileExists "$INSTDIR\${PRODUCT_FILENAME}.exe" 0 wa_selected_install_done
  IfFileExists "$INSTDIR\Uninstall Writing Agent.exe" 0 wa_selected_install_done
  StrCpy $waOrphanInstallPath "$INSTDIR"
  StrCpy $waUpgradeNoticeShown "1"
  StrCpy $waPreviousInstallDetected "1"
  MessageBox MB_OK|MB_ICONINFORMATION "检测到所选位置已有 Writing Agent，但旧安装记录不完整。$\r$\n$\r$\n安装程序将安全移除旧程序文件、升级到 ${VERSION}，并保留项目、设置和模型凭据。"

  wa_selected_install_done:
  Abort
FunctionEnd

Function waShowUpgradeRemovalPhase
  IfSilent wa_upgrade_removal_phase_done
  StrCmp $waPreviousInstallDetected "1" 0 wa_upgrade_removal_phase_done

  GetDlgItem $R0 $HWNDPARENT 1037
  SendMessage $R0 0x000C 0 "STR:正在升级 Writing Agent"
  GetDlgItem $R0 $HWNDPARENT 1038
  SendMessage $R0 0x000C 0 "STR:步骤 1/2：正在移除旧版本"
  SetDetailsPrint textonly
  DetailPrint "步骤 1/2：正在安全移除旧版本，项目和设置会保留。"
  SetDetailsPrint none
  FindWindow $R0 "#32770" "" $HWNDPARENT
  GetDlgItem $R1 $R0 1006
  SendMessage $R1 0x000C 0 "STR:1. 正在安全移除旧版本… 项目与设置会保留。"
  Sleep 600

  wa_upgrade_removal_phase_done:
FunctionEnd

Function waShowUpgradeInstallPhase
  IfSilent wa_upgrade_install_phase_done
  StrCmp $waPreviousInstallDetected "1" 0 wa_upgrade_install_phase_done

  GetDlgItem $R0 $HWNDPARENT 1037
  SendMessage $R0 0x000C 0 "STR:正在升级 Writing Agent"
  GetDlgItem $R0 $HWNDPARENT 1038
  SendMessage $R0 0x000C 0 "STR:步骤 2/2：正在安装 Writing Agent ${VERSION}"
  SetDetailsPrint textonly
  DetailPrint "步骤 2/2：旧版本已安全移除，正在安装 Writing Agent ${VERSION}。"
  SetDetailsPrint none
  FindWindow $R0 "#32770" "" $HWNDPARENT
  GetDlgItem $R1 $R0 1006
  SendMessage $R1 0x000C 0 "STR:1. 旧版本已移除    2. 正在安装新版本…"

  wa_upgrade_install_phase_done:
FunctionEnd

Function waValidateRegisteredRemoval
  IfErrors wa_registered_removal_launch_failed
  StrCmp $R0 "0" wa_registered_removal_valid
  MessageBox MB_OK|MB_ICONSTOP "无法安全移除旧版 Writing Agent（错误码：$R0）。安装已停止，项目、设置和模型凭据不会删除。请关闭正在运行的 Writing Agent 后重试。"
  SetErrorLevel 2
  Quit

  wa_registered_removal_launch_failed:
    MessageBox MB_OK|MB_ICONSTOP "无法启动旧版 Writing Agent 的卸载程序。安装已停止，项目、设置和模型凭据不会删除。请关闭正在运行的 Writing Agent 后重试。"
    SetErrorLevel 2
    Quit

  wa_registered_removal_valid:
FunctionEnd

!macro customUnInstallCheck
  Call waValidateRegisteredRemoval
  StrCmp $installMode "all" wa_registered_removal_wait_for_current_user
  Call waShowUpgradeInstallPhase
  wa_registered_removal_wait_for_current_user:
!macroend

!macro customUnInstallCheckCurrentUser
  Call waValidateRegisteredRemoval
  Call waShowUpgradeInstallPhase
!macroend

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  Call waShowUpgradeRemovalPhase
  StrCmp $waOrphanInstallPath "" wa_orphan_cleanup_done
  IfFileExists "$waOrphanInstallPath\Uninstall Writing Agent.exe" 0 wa_orphan_cleanup_failed
  InitPluginsDir
  CopyFiles /SILENT "$waOrphanInstallPath\Uninstall Writing Agent.exe" "$PLUGINSDIR\orphan-uninstaller.exe"
  ClearErrors
  ExecWait '"$PLUGINSDIR\orphan-uninstaller.exe" /S /KEEP_APP_DATA /currentuser --updated _?=$waOrphanInstallPath' $R5
  IfErrors wa_orphan_cleanup_failed
  StrCmp $R5 "0" wa_orphan_cleanup_success wa_orphan_cleanup_failed

  wa_orphan_cleanup_success:
    StrCpy $waOrphanInstallPath ""
    Call waShowUpgradeInstallPhase
    Goto wa_orphan_cleanup_done

  wa_orphan_cleanup_failed:
    MessageBox MB_OK|MB_ICONSTOP "无法安全移除旧版 Writing Agent。旧程序和用户数据均未继续改动；请关闭正在运行的 Writing Agent 后重试。"
    Abort

  wa_orphan_cleanup_done:
!macroend

!endif
