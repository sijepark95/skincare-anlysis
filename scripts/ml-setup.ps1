param([string]$Python)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$trainingRoot = Join-Path $env:LOCALAPPDATA 'Senmiva\ml'
$workspacePointer = Join-Path $repositoryRoot '.local\ml-workspace.json'
if (Test-Path -LiteralPath $workspacePointer) {
  $trainingRoot = (Get-Content -LiteralPath $workspacePointer -Raw | ConvertFrom-Json).workspace_path
}
if ($env:SENMIVA_ML_WORKSPACE) { $trainingRoot = $env:SENMIVA_ML_WORKSPACE }
$trainingPython = Join-Path $trainingRoot '.venv\Scripts\python.exe'
if ($trainingRoot -match '(?i)OneDrive') { throw 'The training environment must be outside OneDrive.' }
if (-not (Test-Path -LiteralPath $trainingPython)) {
  if (-not $Python) {
    $servicePython = Join-Path $repositoryRoot 'services\analysis\.venv\Scripts\python.exe'
    if (Test-Path -LiteralPath $servicePython) {
      $Python = (& $servicePython -c 'import sys; print(sys._base_executable)').Trim()
    } else {
      throw 'Supply -Python with the full path to an installed Python 3.12 executable.'
    }
  }
  & $Python -m venv (Join-Path $trainingRoot '.venv')
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the independent training environment.' }
}
$canonicalRoot = (& $trainingPython -c 'import sys; from pathlib import Path; print(Path(sys.prefix).resolve().parent)').Trim()
$pointerDirectory = Split-Path -Parent $workspacePointer
New-Item -ItemType Directory -Path $pointerDirectory -Force | Out-Null
$pointerJson = @{ workspace_path = $canonicalRoot } | ConvertTo-Json
[System.IO.File]::WriteAllText($workspacePointer, $pointerJson, [System.Text.UTF8Encoding]::new($false))
& $trainingPython -m pip install -r (Join-Path $repositoryRoot 'ml\requirements-win-cu130.lock') --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw 'Training dependency installation failed; the application environment was not changed.' }
& (Join-Path $PSScriptRoot 'ml.ps1') doctor
exit $LASTEXITCODE
