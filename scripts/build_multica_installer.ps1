[CmdletBinding()]
param([string]$Version = '2026-10-03-product', [string]$IExpress = (Join-Path $env:SystemRoot 'System32\iexpress.exe'))
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$distRoot = Join-Path $repoRoot 'dist'
$builder = Join-Path $repoRoot 'scripts\build_multica_portable.ps1'
$packageRoot = Join-Path $distRoot ('Multica-Control-Console-' + $Version)
$workRoot = Join-Path $env:TEMP ('Multica-Installer-Build-' + $Version + '-' + [guid]::NewGuid().ToString('N'))
$zipPath = Join-Path $workRoot 'MulticaPayload.zip'
$installerPath = Join-Path $distRoot ('Multica-Control-Console-Setup-' + $Version + '.exe')
if (-not (Test-Path -LiteralPath $IExpress)) { throw '当前 Windows 中找不到 IExpress。' }
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
& (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -ExecutionPolicy Bypass -File $builder -Version $Version
if ($LASTEXITCODE -ne 0) { throw ('程序包构建失败：' + $LASTEXITCODE) }
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $packageRoot '*') -DestinationPath $zipPath -CompressionLevel Optimal
Copy-Item -LiteralPath (Join-Path $repoRoot 'installers\install.ps1') -Destination (Join-Path $workRoot 'install.ps1') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'installers\launch_install.vbs') -Destination (Join-Path $workRoot 'launch_install.vbs') -Force
$sedPath = Join-Path $workRoot 'Multica-Installer.sed'
$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=1
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=$installerPath
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=wscript.exe launch_install.vbs
UserQuietInstCmd=wscript.exe launch_install.vbs
SourceFiles=SourceFiles
[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=
FriendlyName=Multica 本地控制台安装程序
AppLaunched=wscript.exe launch_install.vbs
PostInstallCmd=<None>
FILE0="MulticaPayload.zip"
FILE1="install.ps1"
FILE2="launch_install.vbs"
[SourceFiles]
SourceFiles0=$workRoot\
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
"@
[System.IO.File]::WriteAllText($sedPath, $sed, [System.Text.Encoding]::GetEncoding(936))
if (Test-Path -LiteralPath $installerPath) { Remove-Item -LiteralPath $installerPath -Force }
$process = Start-Process -FilePath $IExpress -ArgumentList @('/N', '/Q', $sedPath) -Wait -PassThru -WindowStyle Hidden
if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $installerPath)) { throw ('EXE 构建失败：' + $process.ExitCode) }
$file = Get-Item -LiteralPath $installerPath
Write-Output ('安装器：' + $installerPath)
Write-Output ('大小：' + [math]::Round($file.Length / 1MB, 2) + ' MB')
Write-Output ('SHA-256：' + (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash)







