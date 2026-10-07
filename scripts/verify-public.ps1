$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $root 'SOURCE_FILES.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($property in $manifest.PSObject.Properties) {
  $file = Join-Path $root $property.Name
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw ('Missing software source: ' + $property.Name) }
  if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $property.Value) { throw ('Source hash mismatch: ' + $property.Name) }
}
& node --check (Join-Path $root 'mj-automation/control/batch-ui.js')
if ($LASTEXITCODE -ne 0) { throw 'Frontend syntax failed' }
& node --check (Join-Path $root 'mj-automation/control/gallery-logic.js')
if ($LASTEXITCODE -ne 0) { throw 'Gallery syntax failed' }
Write-Output ('PUBLIC SOURCE VERIFY PASS: ' + @($manifest.PSObject.Properties).Count + ' original software source hashes and JavaScript syntax')
