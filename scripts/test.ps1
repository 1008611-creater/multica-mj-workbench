$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $repoRoot 'runtime/python/Scripts/python.exe'

if (!(Test-Path -LiteralPath $python -PathType Leaf)) {
  Write-Error "Repository test Python is missing: $python. Python tests stopped to avoid silently using a system interpreter. Restore runtime/python and retry."
  exit 1
}

& $python -c 'import uvicorn'
if ($LASTEXITCODE -ne 0) {
  Write-Error "Repository Python is missing the test dependency uvicorn: $python. No system Python fallback was used; prepare the repository runtime using runtime/setup.json and retry."
  exit 1
}

& $python -m unittest discover -s (Join-Path $repoRoot 'mj-automation/scripts') -p 'test_*.py'
exit $LASTEXITCODE
