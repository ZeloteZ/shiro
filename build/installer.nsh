!macro customInstall
  ; Recreate the URI protocol registration after upgrades or reinstalls.
  WriteRegStr HKCU "Software\Classes\shiro" "" "URL:Shiro"
  WriteRegStr HKCU "Software\Classes\shiro" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\shiro\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\shiro\shell" "" "open"
  WriteRegStr HKCU "Software\Classes\shiro\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  ; Remove custom URI protocol registration on uninstall.
  DeleteRegKey HKCU "Software\\Classes\\shiro"
!macroend
