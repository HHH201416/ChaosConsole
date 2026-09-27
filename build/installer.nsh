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
  Var ChaosSize   ; expected byte count, from the manifest
  Var ChaosGot    ; byte count actually on disk

  !include "${BUILD_RESOURCES_DIR}\versions.nsh"

  ; Byte count of $ChaosFile -> $ChaosGot (0 when it does not exist).
  ; NSIS has no runtime file-size instruction (FileSize only works at compile time),
  ; so open the file and seek to the end. Touches only $9: $0 still holds the list
  ; selection while the page is leaving.
  Function ChaosMeasureFile
    StrCpy $ChaosGot "0"
    ${If} ${FileExists} "$ChaosFile"
      ClearErrors
      FileOpen $9 "$ChaosFile" r
      ${IfNot} ${Errors}
        FileSeek $9 0 END $ChaosGot
        FileClose $9
      ${EndIf}
    ${EndIf}
  FunctionEnd

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
    Call ChaosMeasureFile

    ; Already complete (a previous attempt downloaded it, then the hand-off or the
    ; install failed)? Skip the network entirely and go straight to launching it.
    ${If} $ChaosSize != "0"
    ${AndIf} $ChaosGot == $ChaosSize
      ${NSD_SetText} $ChaosStatus "${CHAOS_STR_LAUNCHING}"
      Goto ChaosLaunch
    ${EndIf}

    ${NSD_SetText} $ChaosStatus "${CHAOS_STR_DOWNLOADING}$ChaosTag ..."

    ; INetC is the only downloader bundled with electron-builder's NSIS that
    ; speaks HTTPS (the stock NSISdl plugin does not, and GitHub is HTTPS-only).
    ; It goes through WinINet, i.e. the same stack as the system browser.
    ; Parameter names are lowercase to match the strings inside the plugin.
    ; Returns "OK" on success, "Cancelled", or an error description otherwise.
    ;
    ; The option syntax from the plugin's documentation, and the two traps in it:
    ;
    ;   [/CAPTION TEXT] [/RESUME RETRY_QUESTION] [/POPUP HOST_ALIAS] [/CANCELTEXT TEXT]
    ;
    ;   1. /RESUME takes an argument, it is not a bare flag. Writing it as a flag
    ;      makes the *next* option its text, shifting everything by one -- the
    ;      caption text then lands in the URL slot and the plugin fails with
    ;      "URL Parts Error" before a single byte moves. Cost us a full debugging
    ;      round; the standalone makensis probe that would have caught it in
    ;      seconds got quarantined by the antivirus on this machine.
    ;   2. /POPUP's argument is a HOST_ALIAS that *replaces* the URL in the dialog
    ;      (it exists so a URL with credentials can be hidden), NOT the Cancel
    ;      button's label -- that is /CANCELTEXT. Passing the word "cancel" here
    ;      only made the dialog print "cancel" where the URL belongs. An empty
    ;      alias shows the real URL, which is what we want.
    ;
    ; /RESUME matters on a bad link: without it a dropped connection ends the
    ; download outright, and since an 86 MB transfer on this kind of link does not
    ; survive many drops, the version page would simply never work. With it the
    ; plugin offers a Retry that continues from the partial file. That partial file
    ; must therefore NOT be deleted when something goes wrong -- see below.
    inetc::get /CAPTION "${CHAOS_STR_DL_TITLE}$ChaosTag" /RESUME "${CHAOS_STR_RESUME}" /POPUP "" /CANCELTEXT "${CHAOS_STR_CANCEL}" "$ChaosUrl" "$ChaosFile"
    Pop $0

    ${If} $0 != "OK"
      ; Keep the partial file on disk: the next click on Install resumes it.
      MessageBox MB_ICONEXCLAMATION|MB_OK "${CHAOS_STR_DL_FAIL}$0${CHAOS_STR_DL_HINT}"
      Abort ; stay on this page so the user can pick something else
    ${EndIf}

    ; The one integrity check we can make: the manifest knows every release asset's
    ; exact size. A truncated (or, after an ignored Range request, concatenated)
    ; file would otherwise be handed to the downloaded installer, which can only
    ; report "installer is corrupted" -- with no hint about what actually happened.
    Call ChaosMeasureFile
    ${If} $ChaosSize != "0"
    ${AndIf} $ChaosGot != $ChaosSize
      ${If} $ChaosGot > $ChaosSize
        ; Bigger than expected = the server ignored Range and the plugin appended.
        ; Nothing salvageable, and a resume would keep appending: drop it.
        Delete "$ChaosFile"
        StrCpy $ChaosGot "0"
        MessageBox MB_ICONEXCLAMATION|MB_OK "${CHAOS_STR_DL_DIRTY}"
      ${Else}
        MessageBox MB_ICONEXCLAMATION|MB_OK "${CHAOS_STR_DL_SHORT}"
      ${EndIf}
      Abort ; stay here; Install again continues from what we have
    ${EndIf}

  ChaosLaunch:

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
    ;
    ; Pass the install mode through. Without it the downloaded installer asks again
    ; and defaults to "all users" -- someone who picked "only me" gets a UAC prompt
    ; out of nowhere, and on a machine that already has the other scope installed it
    ; would even uninstall it first (which is what made this fail on the machine this
    ; was tested on). $installMode is "CurrentUser" or "all" (multiUser.nsh).
    ;
    ; /D=<dir> is deliberately NOT forwarded: NSIS requires it unquoted and last, and
    ; a target path containing spaces (D:\软件与文档\...) does not survive the trip
    ; through cmd/start intact. Worst case the user gets the default directory back.
    ;
    ; The three flags match electron/main.js's 版本回退 path exactly (see the long
    ; comment there). Without them the downloaded installer opens its own wizard and
    ; the user walks through four pages just to install the version they already
    ; picked on this page:
    ;   --updated    按原地升级处理：taskkill 掉还在跑的旧进程，不弹「应用正在运行」
    ;   /S           静默安装。NSIS 在 /S 下会跳过全部页面（自定义页也跳过），
    ;                装完不留任何窗口
    ;   --force-run  装完自动把应用拉起来 —— assisted 安装器里自动启动的条件是
    ;                ${isForceRun} ${andIf} ${Silent}，所以这两个必须成对出现
    StrCpy $0 "/currentuser"
    ${If} $installMode == "all"
      StrCpy $0 "/allusers"
    ${EndIf}
    StrCpy $1 "--updated /S --force-run"
    Exec '"$SYSDIR\cmd.exe" /c ping -n 3 127.0.0.1 >nul & start "" "$ChaosFile" $0 $1'
    Quit
  FunctionEnd

  Page custom ChaosVersionPageCreate ChaosVersionPageLeave
!macroend

!endif ; BUILD_UNINSTALLER
