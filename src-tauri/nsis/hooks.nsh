; NSIS pre-install hook for seamless Electron -> Tauri v2 (Rust) migration on Windows.
; Silently uninstalls the legacy electron-builder installation (if present) so users
; do not end up with duplicate "Gens Launcher" entries or stale Electron shortcuts.
!macro NSIS_HOOK_PREINSTALL
  ; 1. Default electron-builder per-user installation path
  IfFileExists "$LOCALAPPDATA\Programs\gens-launcher\Uninstall Gens Launcher.exe" 0 +2
    ExecWait '"$LOCALAPPDATA\Programs\gens-launcher\Uninstall Gens Launcher.exe" /S'

  ; 2. Alternate product-name folder if customized
  IfFileExists "$LOCALAPPDATA\Programs\Gens Launcher\Uninstall Gens Launcher.exe" 0 +2
    ExecWait '"$LOCALAPPDATA\Programs\Gens Launcher\Uninstall Gens Launcher.exe" /S'
!macroend
