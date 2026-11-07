; ==================================================================
;  卸载器：数据清理选项页 + 清理残留（10.0.2）
;
;  这个文件只在卸载器那一趟编译里生效（BUILD_UNINSTALLER），由
;  installer.nsh 末尾 !include 进来。
;
;  两个必须做对的地方（10.0.2 第一次构建连挂两次，都是这里）：
;
;  1) 用 UninstPage，不能用 Page。
;     卸载器里写 `Page custom ...` 时，页面不会登记进卸载页面栈，页面函数同时
;     被判成「没人引用」：
;         warning 6010: uninstall function "un.ChaosUnDataPageCreate" not referenced
;     electron-builder 把 warning 当错误（`Error: warning treated as error`），
;     构建直接失败，而且报错信息只说函数没被引用，不提 Page 写错了 —— 很容易
;     误判成「钩子没生效」去换钩子（第一次就是这么绕了一圈）。
;
;  2) 整段必须包在 !macro customUninstallPage 里。
;     electron-builder 把自定义 include 拼到 common header（MUI2 之前），
;     `MUI_HEADER_TEXT` / nsDialogs 的宏只有到页面列表处才存在。宏体延后展开，
;     展开点正好在 assistedInstaller.nsh:78 的 !insertmacro 处 —— MUI2 已就绪。
;     定义提到宏外，轻则「macro not found」，重则编译通过但窗口永远不显示。
;
;  顺序代价：页面在卸载进度之后，所以文案是「程序已删掉，剩下的数据怎么办」，
;  而不是「卸载前先选」。语义仍然成立，而且这是用户唯一能看清「还剩什么」的时机。
;
;  编码：必须是 UTF-8 BOM，否则 makensis 按 ANSI(GBK) 读，中文全乱码。
; ==================================================================

!ifdef BUILD_UNINSTALLER

!macro customUninstallPage

  !include "nsDialogs.nsh"
  !include "LogicLib.nsh"

  ; 1 = 删除用户数据；其它 = 保留。
  ; 静默卸载 /S 不显示本页，变量为空 → 不删数据：没人点过的东西不该被删。
  Var ChaosUnDelData
  Var ChaosUnDataBox
  Var ChaosUnScope

  Function un.ChaosUnDataPageCreate
    !insertmacro MUI_HEADER_TEXT "卸载完成 · 用户数据" "程序文件已删除，下面这些数据还在本机"

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 24u "程序文件、开始菜单与桌面快捷方式已经删掉了。用户数据不在这条路径上，需要你确认怎么处理。"
    Pop $0

    ${NSD_CreateCheckbox} 0 26u 100% 14u "同时删除用户数据（对话、岗位、知识库、生成的文件）"
    Pop $ChaosUnDataBox
    ; 默认勾选：把「卸载 = 清干净」当默认预期
    ${NSD_Check} $ChaosUnDataBox
    ${NSD_OnClick} $ChaosUnDataBox un.ChaosUnDataToggle

    ${NSD_CreateLabel} 0 44u 100% 30u "会清除：$APPDATA\chaos-console（含 data 子目录）"
    Pop $ChaosUnScope

    ${NSD_CreateLabel} 0 78u 100% 44u "不会动：本地 Ollama 模型（%USERPROFILE%\.ollama）、你自己另存的文件。取消勾选则数据原样保留，重装后可以直接接着用。"
    Pop $0

    StrCpy $ChaosUnDelData "1"

    nsDialogs::Show
  FunctionEnd

  Function un.ChaosUnDataToggle
    ${NSD_GetState} $ChaosUnDataBox $ChaosUnDelData
    ${If} $ChaosUnDelData == "1"
      ${NSD_SetText} $ChaosUnScope "会清除：$APPDATA\chaos-console（含 data 子目录），以及早期版本留下的 $APPDATA\chaosconsole"
    ${Else}
      ${NSD_SetText} $ChaosUnScope "保留数据：$APPDATA\chaos-console 原样留下，重装后可直接接着用"
    ${EndIf}
  FunctionEnd

  Function un.ChaosUnDataPageLeave
    ${NSD_GetState} $ChaosUnDataBox $ChaosUnDelData
    ${If} $ChaosUnDelData != "1"
      Return
    ${EndIf}

    ; 当前名字
    RMDir /r "$APPDATA\chaos-console"
    ; 8.x 早期版本用的目录名 —— 本机实测确实存在，不清会留一份看不见的残留
    RMDir /r "$APPDATA\chaosconsole"
    ; 部分 Electron 版本把缓存写到 Local
    RMDir /r "$LOCALAPPDATA\chaos-console"
    RMDir /r "$LOCALAPPDATA\chaosconsole"

    ; 删完验一次：占着文件（比如开着 %APPDATA% 资源管理器窗口）会删不掉，
    ; 这种情况必须说出来，不能让用户以为已经清干净了。
    ${If} ${FileExists} "$APPDATA\chaos-console\*.*"
      MessageBox MB_ICONEXCLAMATION|MB_OK "用户数据没能全部删除：$APPDATA\chaos-console 里还有文件被占用。$\r$\n关掉资源管理器窗口或杀毒软件后，手动删掉这个文件夹即可。"
    ${EndIf}
  FunctionEnd

  ; 卸载器必须用 UninstPage，不能用 Page ——
  ; 用 Page 时页面不会登记进卸载页面栈，同时页面函数被判「未引用」：
  ;   warning 6010: uninstall function "un.ChaosUnDataPageCreate" not referenced
  ; electron-builder 把 warning 当错误，构建直接失败。这是 10.0.2 第一次
  ; 构建踩的坑，别再改回 Page。
  UninstPage custom un.ChaosUnDataPageCreate un.ChaosUnDataPageLeave

!macroend

; 文件删完之后执行（uninstaller.nsh 里 unregisterFileAssociations 之后、
; quitSuccess 之前）。这里只做「无论数据留不留都该清」的东西，
; 数据删除由上面那一页按用户选择执行。
!macro customUnInstall

  ; 开机自启：当前版本没有这个功能，但留着这一行能兜住以后加功能忘了清理
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "chaos-console"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ChaosConsole"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AI Agent开发控制台"

!macroend

!endif ; BUILD_UNINSTALLER
