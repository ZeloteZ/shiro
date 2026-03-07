!macro customUnInstall
  ; Remove custom URI protocol registration on uninstall.
  DeleteRegKey HKCU "Software\\Classes\\shiro"
!macroend
