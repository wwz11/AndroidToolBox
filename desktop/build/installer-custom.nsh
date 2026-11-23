; 安装/升级：重建快捷方式，但不要触发全桌面图标缓存重建（SHCNE_ASSOCCHANGED 会卡死资源管理器）
!define TOOLBOX_SHCNE_UPDATEITEM 0x00002000
!define TOOLBOX_SHCNE_UPDATEDIR 0x00001000
!define TOOLBOX_SHCNF_PATH_FLUSHNOWAIT 0x2001
!define TOOLBOX_KEEP_USERDATA "$LOCALAPPDATA\AndroidTestToolBox\_keep_userdata"

!macro customInit
  ; 不要在这里 taskkill：onInit 在向导出现前执行。
  ; /T 会把「立即安装」拉起的安装界面当成子进程一起杀掉，结果只看到程序退出。

  ; 卸载旧版会删掉整个安装目录。先把 userdata（登录账号/报告/配置）挪走
  ${if} ${FileExists} "$INSTDIR\userdata"
    CreateDirectory "$LOCALAPPDATA\AndroidTestToolBox"
    RMDir /r "${TOOLBOX_KEEP_USERDATA}"
    ClearErrors
    Rename "$INSTDIR\userdata" "${TOOLBOX_KEEP_USERDATA}"
    ${if} ${Errors}
      CreateDirectory "${TOOLBOX_KEEP_USERDATA}"
      CopyFiles /SILENT "$INSTDIR\userdata\*.*" "${TOOLBOX_KEEP_USERDATA}"
    ${endIf}
  ${endIf}
!macroend

!macro customInstall
  ClearErrors
  ExecWait 'taskkill /F /IM AndroidTestToolBox.exe'
  ClearErrors
  ExecWait 'taskkill /F /IM Toolbox.exe'
  ClearErrors
  ExecWait 'taskkill /F /IM toolbox-api.exe'
  ClearErrors

  ; 装完把升级前的 userdata 放回（新包不会自带这份数据）
  ${if} ${FileExists} "${TOOLBOX_KEEP_USERDATA}"
    ${ifNot} ${FileExists} "$INSTDIR\userdata"
      Rename "${TOOLBOX_KEEP_USERDATA}" "$INSTDIR\userdata"
    ${endIf}
    ${if} ${FileExists} "${TOOLBOX_KEEP_USERDATA}"
      CreateDirectory "$INSTDIR\userdata"
      CopyFiles /SILENT "${TOOLBOX_KEEP_USERDATA}\*.*" "$INSTDIR\userdata"
      RMDir /r "${TOOLBOX_KEEP_USERDATA}"
    ${endIf}
  ${endIf}

  DetailPrint "Refreshing desktop and start menu shortcuts..."

  ; 优先用安装目录内的 AndroidTestToolBox.ico（extraFiles），否则回退到 exe
  StrCpy $0 "$INSTDIR\AndroidTestToolBox.ico"
  ${ifNot} ${FileExists} "$0"
    StrCpy $0 "$appExe"
  ${endIf}

  !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
    ${ifNot} ${isNoDesktopShortcut}
      Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
      CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
      System::Call 'Shell32::SHChangeNotify(i ${TOOLBOX_SHCNE_UPDATEITEM}, i ${TOOLBOX_SHCNF_PATH_FLUSHNOWAIT}, t "$DESKTOP\${SHORTCUT_NAME}.lnk", i 0)'
    ${endIf}
  !endif

  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    !insertmacro createMenuDirectory
    Delete "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    System::Call 'Shell32::SHChangeNotify(i ${TOOLBOX_SHCNE_UPDATEITEM}, i ${TOOLBOX_SHCNF_PATH_FLUSHNOWAIT}, t "$newStartMenuLink", i 0)'
  !endif

  System::Call 'Shell32::SHChangeNotify(i ${TOOLBOX_SHCNE_UPDATEDIR}, i ${TOOLBOX_SHCNF_PATH_FLUSHNOWAIT}, t "$DESKTOP", i 0)'
!macroend
