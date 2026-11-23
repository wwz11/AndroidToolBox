; Inno Setup - run build.bat first (creates dist\Toolbox)
; Version: build\write_build_version.py -> build\generated\version.iss
#include "..\generated\version.iss"
#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#ifndef BuildTag
  #define BuildTag "dev"
#endif
#define AppName "Toolbox"
#define AppPublisher "Toolbox"
#define AppExeName "Toolbox.exe"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
OutputDir=..\..\dist\installer
OutputBaseFilename={#AppName}_Setup_{#BuildTag}
VersionInfoVersion={#AppVersion}
VersionInfoProductVersion={#AppVersion}
VersionInfoProductTextVersion={#AppVersion}
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=..\assets\toolbox.ico
UninstallDisplayIcon={app}\{#AppExeName}

[Files]
Source: "..\..\dist\Toolbox\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create desktop shortcut"; GroupDescription: "Additional icons:"

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent
