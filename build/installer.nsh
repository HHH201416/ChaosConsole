; ==================================================================
;  Custom installer page: pick which version to install.
;
;  Pulled in via package.json -> build.nsis.include. electron-builder's
;  assistedInstaller.nsh inserts !customPageAfterChangeDir right after the
;  "choose install location" page and before the file-copy step, which is
;  exactly where this belongs.
;
;  Behaviour:
;    * Pick the entry marked "bundled"  -> do nothing special, the normal
;      install proceeds (no network needed).
;    * Pick any other entry             -> download that version's installer
;      from GitHub Releases, hand control over to it, and quit this
;      installer without installing the bundled build.
;
;  The version list (and every localized string) comes from build/versions.nsh,
;  which scripts/nsis-manifest.js regenerates on each build. This file is kept
;  deliberately ASCII-only: makensis decides the source encoding from a UTF-8
;  BOM, and a hand-edited file is exactly where that gets lost.
; ==================================================================

; electron-builder compiles this script TWICE: the first pass runs with
; BUILD_UNINSTALLER defined and produces the uninstaller, which has no pages
; at all. Keep everything out of that pass.
!ifndef BUILD_UNINSTALLER

; ------------------------------------------------------------------
;  Everything must live inside the macro below. Not style - a hard requirement.
;
;  electron-builder splices this file into its *common script header*, which
;  lands BEFORE the template does !include "MUI2.nsh". A macro body is only
;  expanded where it is inserted, and customPageAfterChangeDir is inserted after
;  MUI2 is ready - which is the only point where MUI's page macros and
;  nsDialogs-based page functions can legally be defined.
;
;  Getting this wrong fails in two escalating ways:
;    1. !insertmacro MUI_HEADER_TEXT at the top level -> "macro named
;       MUI_HEADER_TEXT not found", build aborts.
;    2. Even with that removed, pulling nsDialogs in before MUI2 compiles fine
;       but the produced installer never shows a window - it just sits there
;       as a windowless process.
;  Both were reproduced with a standalone makensis harness before landing this.
; ------------------------------------------------------------------
!macro customPageAfterChangeDir

  !include "nsDialogs.nsh"
  !include "LogicLib.nsh"

  ; The Vars must come before versions.nsh: it references them inside the two
  ; generated functions, and NSIS resolves $Vars where the file is parsed.
  Var ChaosList
  Var ChaosStatus
  Var ChaosUrl
  Var ChaosTag
  Var ChaosFile

  !include "${BUILD_RESOURCES_DIR}\versions.nsh"

  Function ChaosVersionPageCreate
    !insertmacro MUI_HEADER_TEXT "${CHAOS_STR_PAGE_TITLE}" "${CHAOS_STR_PAGE_SUB}"

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 20u "${CHAOS_STR_PROMPT}"
    Pop $0

    ${NSD_CreateListBox} 0 22u 100% 96u ""
    Pop $ChaosList
    Call ChaosFillVersionList
    ; index 0 is the bundled build - preselect it so the "just install" path
    ; needs no interaction
    ${NSD_LB_SetSelectionIndex} $ChaosList 0

    ${NSD_CreateLabel} 0 124u 100% 36u "${CHAOS_STR_HINT}"
    Pop $ChaosStatus

    nsDialogs::Show
  FunctionEnd

  Function ChaosVersionPageLeave
    ${NSD_LB_GetSelectionIndex} $ChaosList $0
    Call ChaosPickVersion

    ; Empty url means the bundled build - fall through to the normal install
    ${If} $ChaosUrl == ""
      Return
    ${EndIf}

    StrCpy $ChaosFile "$TEMP\ChaosConsole-Setup-$ChaosTag.exe"
    ; Overwrite anything left over from an earlier attempt
    Delete "$ChaosFile"

    ${NSD_SetText} $ChaosStatus "${CHAOS_STR_DOWNLOADING}$ChaosTag ..."

    ; INetC is the only downloader bundled with electron-builder's NSIS that
    ; speaks HTTPS (the stock NSISdl plugin does not, and GitHub is HTTPS-only).
    ; It goes through WinINet, i.e. the same stack as the system browser.
    ; Parameter names are lowercase to match the strings inside the plugin.
    ; Returns "OK" on success, "Cancelled", or an error description otherwise.
    inetc::get /caption "${CHAOS_STR_DL_TITLE}$ChaosTag" /popup "${CHAOS_STR_CANCEL}" "$ChaosUrl" "$ChaosFile"
    Pop $0

    ${If} $0 != "OK"
      MessageBox MB_ICONEXCLAMATION|MB_OK "${CHAOS_STR_DL_FAIL}$0${CHAOS_STR_DL_HINT}"
      ${If} ${FileExists} "$ChaosFile"
        Delete "$ChaosFile"
      ${EndIf}
      Abort ; stay on this page so the user can pick something else
    ${EndIf}

    ${NSD_SetText} $ChaosStatus "${CHAOS_STR_LAUNCHING}"

    ; Two things force this odd-looking launch:
    ;
    ;  1. electron-builder ships a "only one installer instance at a time" mutex
    ;     (allowOnlyOneInstallerInstance.nsh). A second installer that finds the
    ;     mutex held brings the first window to front and then Abort's *silently*
    ;     - the user would see nothing installed and no explanation.
    ;  2. NSIS has no "run this after I exit" hook, and the mutex only goes away
    ;     when this process is gone.
    ;
    ; So hand off to a detached cmd that waits a couple of seconds (plenty for us
    ; to exit and drop the lock) and then starts the downloaded installer.
    ; The cost is a console window flashing for ~2s.
    Exec '"$SYSDIR\cmd.exe" /c ping -n 3 127.0.0.1 >nul & start "" "$ChaosFile"'
    Quit
  FunctionEnd

  Page custom ChaosVersionPageCreate ChaosVersionPageLeave
!macroend

!endif ; BUILD_UNINSTALLER
