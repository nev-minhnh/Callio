; The office engine ends with Callio; one left over (a crash) would lock its file.
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /f /im callio-office.exe'
!macroend

; Callio registers itself in "Open with" (ProgIDs, OpenWithProgids, Default apps capabilities)
; under HKCU. The installer delegates to the app so install/uninstall and the in-app
; Settings → File types button all write exactly the same keys.
!macro NSIS_HOOK_POSTINSTALL
  ExecWait '"$INSTDIR\Callio.exe" --register-file-types'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /f /im callio-office.exe'
  ExecWait '"$INSTDIR\Callio.exe" --unregister-file-types'
!macroend
