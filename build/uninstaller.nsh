; ==================================================================
;  卸载器：清理选项页（10.0.3 —— 从「删不删数据」升级成逐项可选）
;
;  这个文件只在卸载器那一趟编译里生效（BUILD_UNINSTALLER），由
;  installer.nsh 末尾 !include 进来。
;
;  10.0.2 只有「删除用户数据」一个勾选框，等于把「全部清干净」和
;  「只留数据」两个极端当成了全部选项。10.0.3 换成五项清单，用户
;  可以只清缓存、只清旧版本残留、只删 GB 级的模型 —— 每一项都写清
;  会删什么、删了有什么后果。
;
;  清单来自对本机实际目录的盘点（2026-11-07，10.0.2 安装态）：
;
;    %APPDATA%\chaos-console                142 MB
;      ├ data\                              3 MB   对话/岗位/知识库/生成物/备份
;      ├ mcp\                             129 MB   已下载的 MCP 工具（可重新下载）
;      ├ Cache / GPUCache / Code Cache …  6.5 MB   Chromium 缓存
;      └ theme.json / window-state.json            界面偏好、窗口位置
;    %APPDATA%\chaosconsole                 9.5 MB   8.x 时期的旧目录名
;    %LOCALAPPDATA%\chaos-console-updater   177 MB   下载过的安装包副本（更新后不删）
;    %LOCALAPPDATA%\ChaosConsole            0        个别版本留下的空壳
;    %USERPROFILE%\.ollama                  数 GB    模型文件
;    %LOCALAPPDATA%\Programs\Ollama                  引擎本体（官方安装器装的）
;    %USERPROFILE%\.chaos_*.crt / *.pem              跑 Steam 工具时生成的证书
;
;  ================================================================
;  最重要的一条：不能直接用 $APPDATA / $LOCALAPPDATA
;
;  本应用可以按「所有用户」安装（perMachine，本机 10.0.2 就是 all-users，
;  装在 D:\软件与文档\ChaosConsole）。这种安装下 electron-builder 的卸载器
;  会 SetShellVarContext all，于是：
;
;      $APPDATA       -> C:\ProgramData        （不是用户的 Roaming）
;      $LOCALAPPDATA  -> C:\ProgramData        （不是用户的 Local）
;
;  10.0.2 直接用 $APPDATA\chaos-console 删，在 all-users 安装上等于删了一个
;  不存在的路径 —— 静默成功、实际什么都没删。所以这里全部改走 ReadEnvStr：
;  它读的是进程环境变量，不受 shell var context 影响，四个路径先解析到
;  专用变量（$ChaosUnAppData 等）再用。
;
;  同理，页面上的路径说明也用解析后的值显示 —— 否则用户会看到一堆
;  C:\ProgramData\chaos-console，以为要删的东西根本不存在。
;
;  ================================================================
;  另外三个必须做对的地方（10.0.2 连挂两次，都是这里）：
;
;  1) 用 UninstPage，不能用 Page。
;     卸载器里写 `Page custom ...` 时，页面不会登记进卸载页面栈，页面函数同时
;     被判成「没人引用」：
;         warning 6010: uninstall function "un.ChaosUnDataPageCreate" not referenced
;     electron-builder 把 warning 当错误，构建直接失败，而且报错信息只说函数没被
;     引用，不提 Page 写错了 —— 很容易误判成「钩子没生效」去换钩子。
;
;  2) 整段必须包在 !macro customUninstallPage 里。
;     electron-builder 把自定义 include 拼到 common header（MUI2 之前），
;     `MUI_HEADER_TEXT` / nsDialogs 的宏只有到页面列表处才存在。宏体延后展开，
;     展开点正好在 assistedInstaller.nsh:78 的 !insertmacro 处 —— MUI2 已就绪。
;
;  3) 编码必须是 UTF-8 BOM，否则 makensis 按 ANSI(GBK) 读，中文全乱码。
;
;  顺序代价：页面在卸载进度之后，所以文案是「程序已删掉，剩下的怎么办」，
;  不是「卸载前先选」。语义仍成立，而且这是用户唯一能看清「还剩什么」的时机。
;
;  为什么不显示每项的体积：mcp 目录单是文件就有 1 万多个，NSIS 只能
;  FindFirst/FileOpen 逐个量，实测会让这一页卡住好几秒（带杀毒软件更久）。
;  宁可不给数字，也不能让卸载向导看起来像卡死。体积信息写进静态文案里。
;
;  静默卸载（/S）不显示本页 → 变量全空 → 一项都不删。更新流程里跑的是
;  `uninstaller /S`，这条默认值保证了「升级绝不碰用户数据」。
; ==================================================================

!ifdef BUILD_UNINSTALLER

!macro customUninstallPage

  !include "nsDialogs.nsh"
  !include "LogicLib.nsh"

  ; 五项各自一个状态变量（"1" = 删）和一个句柄；空字符串一律按「不删」处理，
  ; 这样静默卸载跳过页面时天然就是安全默认。
  Var ChaosUnUserData
  Var ChaosUnCache
  Var ChaosUnMcp
  Var ChaosUnLegacy
  Var ChaosUnEngine
  Var ChaosUnBox1
  Var ChaosUnBox2
  Var ChaosUnBox3
  Var ChaosUnBox4
  Var ChaosUnBox5
  Var ChaosUnFail      ; 删不掉的东西，攒起来一次性告诉用户
  Var ChaosUnTmp       ; 放挂起脚本的返回值 / 临时文案
  Var ChaosUnAppData   ; 解析后的真实路径（不受 shell var context 影响）
  Var ChaosUnLocalApp
  Var ChaosUnTemp
  Var ChaosUnProfile

  ; 把四个用户目录解析到专用变量。ReadEnvStr 读进程环境变量，
  ; all-users 安装（SetShellVarContext all）下仍然拿到用户自己的目录。
  Function un.ChaosUnResolvePaths
    ReadEnvStr $ChaosUnAppData "APPDATA"
    ReadEnvStr $ChaosUnLocalApp "LOCALAPPDATA"
    ReadEnvStr $ChaosUnTemp "TEMP"
    ReadEnvStr $ChaosUnProfile "USERPROFILE"
    ; 兜底：环境变量被清掉的极端情况，退回 NSIS 的解释（至少有一个能用的）
    ${If} $ChaosUnAppData == ""
      StrCpy $ChaosUnAppData "$APPDATA"
    ${EndIf}
    ${If} $ChaosUnLocalApp == ""
      StrCpy $ChaosUnLocalApp "$LOCALAPPDATA"
    ${EndIf}
    ${If} $ChaosUnTemp == ""
      StrCpy $ChaosUnTemp "$TEMP"
    ${EndIf}
    ${If} $ChaosUnProfile == ""
      StrCpy $ChaosUnProfile "$PROFILE"
    ${EndIf}
  FunctionEnd

  Function un.ChaosUnAddFail
    ; $ChaosUnTmp = 一句说明，追加进 $ChaosUnFail。
    ; 用专门变量传参，不动 $0-$9 —— 页面函数里 $0 还压着控件句柄。
    ${If} $ChaosUnFail == ""
      StrCpy $ChaosUnFail "$ChaosUnTmp"
    ${Else}
      StrCpy $ChaosUnFail "$ChaosUnFail$\r$\n$ChaosUnTmp"
    ${EndIf}
  FunctionEnd

  Function un.ChaosUnDataPageCreate
    !insertmacro MUI_HEADER_TEXT "卸载完成 · 清理本机残留" "程序文件已删除，下面这些还在本机，勾选要一并清除的"

    ; 先解析路径：下面的说明文字要显示真实位置
    Call un.ChaosUnResolvePaths

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 16u "程序文件、快捷方式已经删掉了。下面这些不在这条路径上，勾掉不要的再点「完成」。"
    Pop $0

    ; 版式：每项 = 复选框 12u + 路径说明 9u，行距 21u，五项占 18u~123u，
    ; 底部提示落在 125u，整页 134u（1018 页面上限 140u），留 6u 余量。
    ; 别再往上加项：再加一行就会压到「完成」按钮区。

    ; ---- 1. 用户数据（默认删：卸载通常就是不要了） ----
    ${NSD_CreateCheckbox} 0 18u 100% 12u "用户数据：对话、岗位、知识库、设置、AI 生成的文件"
    Pop $ChaosUnBox1
    ${NSD_Check} $ChaosUnBox1
    ${NSD_CreateLabel} 12u 30u 93% 9u "$ChaosUnAppData\chaos-console\data（数据库、生成的文件、备份）"
    Pop $0

    ; ---- 2. 缓存与更新包（默认删：纯粹占地方） ----
    ${NSD_CreateCheckbox} 0 39u 100% 12u "缓存与更新包：网页缓存、下载过的安装包副本"
    Pop $ChaosUnBox2
    ${NSD_Check} $ChaosUnBox2
    ${NSD_CreateLabel} 12u 51u 93% 9u "Cache 等缓存目录 + $ChaosUnLocalApp\chaos-console-updater（百 MB 级）"
    Pop $0

    ; ---- 3. MCP 工具（默认删：重装会按需重新下） ----
    ${NSD_CreateCheckbox} 0 60u 100% 12u "已下载的 MCP 工具：重装后按需重新下载"
    Pop $ChaosUnBox3
    ${NSD_Check} $ChaosUnBox3
    ${NSD_CreateLabel} 12u 72u 93% 9u "$ChaosUnAppData\chaos-console\mcp（本机实测 129 MB 左右）"
    Pop $0

    ; ---- 4. 早期版本残留（默认删：留着也是垃圾） ----
    ${NSD_CreateCheckbox} 0 81u 100% 12u "早期版本残留：旧目录名、旧数据、证书文件"
    Pop $ChaosUnBox4
    ${NSD_Check} $ChaosUnBox4
    ${NSD_CreateLabel} 12u 93u 93% 9u "$ChaosUnAppData\chaosconsole、安装目录旧 data、家目录 CA 证书"
    Pop $0

    ; ---- 5. 引擎与模型（默认留：别的程序可能也在用，且是 GB 级） ----
    ${NSD_CreateCheckbox} 0 102u 100% 12u "混沌引擎与本地模型（默认保留 —— 可能被其它程序共用）"
    Pop $ChaosUnBox5
    ${NSD_CreateLabel} 12u 114u 93% 9u "$ChaosUnLocalApp\Programs\Ollama 与 $ChaosUnProfile\.ollama（数 GB）"
    Pop $0

    ${NSD_CreateLabel} 0 125u 100% 9u "勾选的内容会被永久删除，删了无法恢复。"
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function un.ChaosUnDataPageLeave
    ${NSD_GetState} $ChaosUnBox1 $ChaosUnUserData
    ${NSD_GetState} $ChaosUnBox2 $ChaosUnCache
    ${NSD_GetState} $ChaosUnBox3 $ChaosUnMcp
    ${NSD_GetState} $ChaosUnBox4 $ChaosUnLegacy
    ${NSD_GetState} $ChaosUnBox5 $ChaosUnEngine

    ; 再解析一次：页面与离页之间环境变量理论上不会变，但这里不能依赖创建页时的状态
    Call un.ChaosUnResolvePaths

    ; ---------------- 1. 用户数据 ----------------
    ${If} $ChaosUnUserData == "1"
      Delete "$ChaosUnAppData\chaos-console\theme.json"
      Delete "$ChaosUnAppData\chaos-console\window-state.json"
      RMDir /r "$ChaosUnAppData\chaos-console\data"
      ; 网页端存的界面状态也算用户数据，跟着一起走
      RMDir /r "$ChaosUnAppData\chaos-console\Local Storage"
      RMDir /r "$ChaosUnAppData\chaos-console\Session Storage"
      RMDir /r "$ChaosUnAppData\chaos-console\blob_storage"
      ; 关机守护的标记文件，留着会让下一版误判「上次被拦过」
      RMDir /r "$ChaosUnAppData\chaos-console\shutdown-guard"

      ${If} ${FileExists} "$ChaosUnAppData\chaos-console\data\*.*"
        StrCpy $ChaosUnTmp "· $ChaosUnAppData\chaos-console\data"
        Call un.ChaosUnAddFail
      ${EndIf}
    ${EndIf}

    ; ---------------- 2. 缓存与更新包 ----------------
    ${If} $ChaosUnCache == "1"
      RMDir /r "$ChaosUnAppData\chaos-console\Cache"
      RMDir /r "$ChaosUnAppData\chaos-console\Code Cache"
      RMDir /r "$ChaosUnAppData\chaos-console\GPUCache"
      RMDir /r "$ChaosUnAppData\chaos-console\DawnWebGPUCache"
      RMDir /r "$ChaosUnAppData\chaos-console\DawnGraphiteCache"
      RMDir /r "$ChaosUnAppData\chaos-console\Shared Dictionary"
      RMDir /r "$ChaosUnAppData\chaos-console\SharedStorage"
      RMDir /r "$ChaosUnAppData\chaos-console\Dictionaries"
      RMDir /r "$ChaosUnAppData\chaos-console\Network"
      Delete "$ChaosUnAppData\chaos-console\Preferences"
      Delete "$ChaosUnAppData\chaos-console\Local State"
      Delete "$ChaosUnAppData\chaos-console\DevToolsActivePort"
      ; 自动更新下载的安装包，电子更新器不会自己清
      RMDir /r "$ChaosUnLocalApp\chaos-console-updater"
      RMDir /r "$ChaosUnLocalApp\ChaosConsole"
      ; 安装器自己拉下来的安装包（安装时选的其它版本）
      Delete "$ChaosUnTemp\ChaosConsole-Setup-*.exe"

      ${If} ${FileExists} "$ChaosUnLocalApp\chaos-console-updater\*.*"
        StrCpy $ChaosUnTmp "· $ChaosUnLocalApp\chaos-console-updater"
        Call un.ChaosUnAddFail
      ${EndIf}
    ${EndIf}

    ; ---------------- 3. MCP 工具 ----------------
    ${If} $ChaosUnMcp == "1"
      RMDir /r "$ChaosUnAppData\chaos-console\mcp"
      ${If} ${FileExists} "$ChaosUnAppData\chaos-console\mcp\*.*"
        StrCpy $ChaosUnTmp "· $ChaosUnAppData\chaos-console\mcp"
        Call un.ChaosUnAddFail
      ${EndIf}
    ${EndIf}

    ; ---------------- 4. 早期版本残留 ----------------
    ${If} $ChaosUnLegacy == "1"
      ; 8.x 用的目录名，本机实测确实存在，不清会留一份看不见的残留
      RMDir /r "$ChaosUnAppData\chaosconsole"
      RMDir /r "$ChaosUnLocalApp\chaosconsole"
      ; 早期版本把 data 放在安装目录里，覆盖安装后可能还在
      RMDir /r "$INSTDIR\resources\app\data"
      ; 跑 Steam 工具时写到用户家目录的证书
      Delete "$ChaosUnProfile\.chaos_ca_bundle.crt"
      Delete "$ChaosUnProfile\.chaos_steamtools_ca.pem"

      ${If} ${FileExists} "$ChaosUnAppData\chaosconsole\*.*"
        StrCpy $ChaosUnTmp "· $ChaosUnAppData\chaosconsole"
        Call un.ChaosUnAddFail
      ${EndIf}
    ${EndIf}

    ; ---------------- 5. 引擎与模型 ----------------
    ${If} $ChaosUnEngine == "1"
      ; 先停进程。推理服务常驻，文件被占用就删不掉 —— 这一步不能省。
      nsExec::Exec 'taskkill /IM ollama.exe /F /T'
      Pop $ChaosUnTmp
      nsExec::Exec 'taskkill /IM "ollama app.exe" /F /T'
      Pop $ChaosUnTmp

      ; 优先跑官方卸载器（它自己清注册表与快捷方式），再按目录兜底
      ${If} ${FileExists} "$ChaosUnLocalApp\Programs\Ollama\Uninstall Ollama.exe"
        ExecWait '"$ChaosUnLocalApp\Programs\Ollama\Uninstall Ollama.exe" /S' $ChaosUnTmp
      ${EndIf}
      RMDir /r "$ChaosUnLocalApp\Programs\Ollama"
      RMDir /r "$ChaosUnAppData\Ollama"
      ; 官方卸载器没跑成时，卸载项会留在「应用和功能」里
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Ollama"

      ; 模型单独一摊，量最大
      RMDir /r "$ChaosUnProfile\.ollama"

      ${If} ${FileExists} "$ChaosUnLocalApp\Programs\Ollama\*.*"
        StrCpy $ChaosUnTmp "· $ChaosUnLocalApp\Programs\Ollama（进程还在跑，重启后再删）"
        Call un.ChaosUnAddFail
      ${EndIf}
      ${If} ${FileExists} "$ChaosUnProfile\.ollama\*.*"
        StrCpy $ChaosUnTmp "· $ChaosUnProfile\.ollama（有文件被占用）"
        Call un.ChaosUnAddFail
      ${EndIf}
    ${EndIf}

    ; 上面几项清完，容器目录本身可能只剩个空壳，顺手摘掉（非递归：里面还有东西就不动）
    RMDir "$ChaosUnAppData\chaos-console"
    RMDir "$ChaosUnAppData\chaosconsole"

    ; 删不掉必须说出来，不能让用户以为已经清干净了
    ${If} $ChaosUnFail != ""
      MessageBox MB_ICONEXCLAMATION|MB_OK "以下内容没能删除，多半是被占用了：$\r$\n$\r$\n$ChaosUnFail$\r$\n$\r$\n关掉资源管理器窗口或杀毒软件后，手动删掉即可。"
    ${EndIf}
  FunctionEnd

  ; 卸载器必须用 UninstPage，不能用 Page ——
  ; 用 Page 时页面不会登记进卸载页面栈，同时页面函数被判「未引用」：
  ;   warning 6010: uninstall function "un.ChaosUnDataPageCreate" not referenced
  ; electron-builder 把 warning 当错误，构建直接失败。别再改回 Page。
  UninstPage custom un.ChaosUnDataPageCreate un.ChaosUnDataPageLeave

!macroend

; 文件删完之后执行（uninstaller.nsh 里 unregisterFileAssociations 之后、
; quitSuccess 之前）。这里只做「无论数据留不留都该清」的东西：
; 数据删除由上面那一页按用户选择执行。
!macro customUnInstall

  ; 开机自启：当前版本没有这个功能，但留着能兜住以后加功能忘了清理
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "chaos-console"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ChaosConsole"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AI Agent开发控制台"

!macroend

!endif ; BUILD_UNINSTALLER
