; NooXCord installer hooks (electron-builder NSIS include).
!include "WinVer.nsh"

LangString nxOldWindows 1055 "NooXCord Windows 10 sürüm 2004 (derleme 19041) veya daha yenisini gerektirir. Bu sürümde sistem sesi yakalama ve bazı özellikler çalışmayabilir.$\r$\n$\r$\nYine de kurulsun mu?"
LangString nxOldWindows 1033 "NooXCord needs Windows 10 version 2004 (build 19041) or newer. System audio capture and some features may not work on this version.$\r$\n$\r$\nInstall anyway?"
LangString nxDeleteData 1055 "Kullanıcı verileri de silinsin mi?$\r$\n(Oturumlar, ayarlar ve bu bilgisayarda barındırılan sunucunun veritabanı, yüklenen dosyalar ve yedekler: %APPDATA%\NooXCord)"
LangString nxDeleteData 1033 "Also delete user data?$\r$\n(Sessions, settings and the database, uploads and backups of the server hosted on this computer: %APPDATA%\NooXCord)"

!macro customInit
  ${IfNot} ${AtLeastBuild} 19041
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "$(nxOldWindows)" /SD IDYES IDYES nxWinOk
    Quit
    nxWinOk:
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(nxDeleteData)" /SD IDNO IDNO nxKeepData
      SetShellVarContext current
      RMDir /r "$APPDATA\NooXCord"
      RMDir /r "$LOCALAPPDATA\NooXCord"
    nxKeepData:
  ${EndIf}
!macroend
