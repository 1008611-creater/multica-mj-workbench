[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$payload = Join-Path $PSScriptRoot 'MulticaPayload.zip'
if (-not (Test-Path -LiteralPath $payload)) { throw '安装包内容不完整，请重新下载 EXE 安装器。' }

function Test-MulticaInstall([string]$Path) {
  return (Test-Path -LiteralPath (Join-Path $Path 'Start-Multica.cmd')) -and
    (Test-Path -LiteralPath (Join-Path $Path 'PACKAGE_MANIFEST.json'))
}

$target = $null
$upgrade = $false
if ($env:MULTICA_INSTALL_TARGET) {
  $target = [System.IO.Path]::GetFullPath($env:MULTICA_INSTALL_TARGET)
  $upgrade = Test-MulticaInstall $target
} else {
  $knownPaths = @('E:\Multica-Control-Console')
  if ($env:LOCALAPPDATA) { $knownPaths += (Join-Path $env:LOCALAPPDATA 'Multica-Control-Console') }
  foreach ($candidate in $knownPaths) {
    if (Test-MulticaInstall $candidate) {
      $target = [System.IO.Path]::GetFullPath($candidate)
      $upgrade = $true
      break
    }
  }
  if (-not $target) {
    if (Test-Path -LiteralPath 'E:\') { $target = 'E:\Multica-Control-Console' }
    else { $target = Join-Path $env:LOCALAPPDATA 'Multica-Control-Console' }
  }

  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'Multica 安装向导'
  $form.ClientSize = New-Object System.Drawing.Size(560, 300)
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.ShowInTaskbar = $true
  $form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $form.BackColor = [System.Drawing.Color]::White

  $title = New-Object System.Windows.Forms.Label
  $title.Text = if ($upgrade) { '更新 Multica 本地工作台' } else { '安装 Multica 本地工作台' }
  $title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 16, [System.Drawing.FontStyle]::Bold)
  $title.Location = New-Object System.Drawing.Point(28, 22)
  $title.Size = New-Object System.Drawing.Size(500, 34)
  $form.Controls.Add($title)

  $intro = New-Object System.Windows.Forms.Label
  if ($upgrade) {
    $intro.Text = '已找到电脑上的旧版本。点击“开始更新”即可更新软件。'
  } else {
    $intro.Text = '这个软件会在本机打开抽卡工作台，帮助你查看服务、浏览器、任务和结果。'
  }
  $intro.Location = New-Object System.Drawing.Point(30, 70)
  $intro.Size = New-Object System.Drawing.Size(500, 42)
  $form.Controls.Add($intro)

  $pathCaption = New-Object System.Windows.Forms.Label
  $pathCaption.Text = if ($upgrade) { '已找到的安装位置' } else { '安装位置' }
  $pathCaption.Location = New-Object System.Drawing.Point(30, 126)
  $pathCaption.Size = New-Object System.Drawing.Size(490, 22)
  $form.Controls.Add($pathCaption)

  $pathBox = New-Object System.Windows.Forms.TextBox
  $pathBox.Text = $target
  $pathBox.Location = New-Object System.Drawing.Point(30, 151)
  $pathBox.Size = New-Object System.Drawing.Size(490, 28)
  $pathBox.ReadOnly = $upgrade
  $form.Controls.Add($pathBox)

  $preserve = New-Object System.Windows.Forms.Label
  $preserve.Text = if ($upgrade) { '更新会保留浏览器登录档案、任务、回执、生成结果和本地设置。' } else { '安装完成后会在桌面创建快捷方式；登录和生成由你自己操作。' }
  $preserve.ForeColor = [System.Drawing.Color]::FromArgb(65, 77, 93)
  $preserve.Location = New-Object System.Drawing.Point(30, 190)
  $preserve.Size = New-Object System.Drawing.Size(500, 24)
  $form.Controls.Add($preserve)

  $changeButton = New-Object System.Windows.Forms.Button
  $changeButton.Text = '选择其他位置…'
  $changeButton.Location = New-Object System.Drawing.Point(30, 238)
  $changeButton.Size = New-Object System.Drawing.Size(130, 36)
  $changeButton.Enabled = -not $upgrade
  $changeButton.Add_Click({
    $picker = New-Object System.Windows.Forms.FolderBrowserDialog
    $picker.Description = '请选择 Multica 的安装位置。点击“确定”后会自动安装到这里。'
    $picker.ShowNewFolderButton = $true
    $picker.SelectedPath = $pathBox.Text
    try {
      if ($picker.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) { $pathBox.Text = $picker.SelectedPath }
    } finally { $picker.Dispose() }
  })
  $form.Controls.Add($changeButton)

  $cancelButton = New-Object System.Windows.Forms.Button
  $cancelButton.Text = '取消'
  $cancelButton.Location = New-Object System.Drawing.Point(354, 238)
  $cancelButton.Size = New-Object System.Drawing.Size(78, 36)
  $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $form.Controls.Add($cancelButton)

  $installButton = New-Object System.Windows.Forms.Button
  $installButton.Text = if ($upgrade) { '开始更新' } else { '开始安装' }
  $installButton.Location = New-Object System.Drawing.Point(440, 238)
  $installButton.Size = New-Object System.Drawing.Size(90, 36)
  $installButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $form.Controls.Add($installButton)
  $form.AcceptButton = $installButton
  $form.CancelButton = $cancelButton
  try {
    if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 2 }
    $target = [System.IO.Path]::GetFullPath($pathBox.Text.Trim())
    if (-not $target) { throw '请先选择安装位置。' }
  } finally { $form.Dispose() }
}

$extractRoot = Join-Path $PSScriptRoot 'payload'
New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
Expand-Archive -LiteralPath $payload -DestinationPath $extractRoot -Force
$installer = Join-Path $extractRoot 'mj-automation\scripts\portable\portable_install.ps1'
if (-not (Test-Path -LiteralPath $installer)) { throw '安装包内容不完整：缺少安装程序。' }
try {
  & $installer -TargetRoot $target
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw ('安装失败，错误代码：' + $LASTEXITCODE) }
  if (-not $env:MULTICA_INSTALL_TARGET) {
    $actionText = if ($upgrade) { '更新' } else { '安装' }
    $doneText = "Multica 已$actionText。桌面已创建快捷方式，你可以从桌面打开工作台。"
    [System.Windows.Forms.MessageBox]::Show($doneText, 'Multica 本地工作台', 'OK', 'Information') | Out-Null
  }
} catch {
  [System.Windows.Forms.MessageBox]::Show(('安装未完成：' + $_.Exception.Message), 'Multica 本地工作台', 'OK', 'Error') | Out-Null
  exit 1
}




