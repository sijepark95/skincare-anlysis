param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$TrainingArguments
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$trainingRoot = Join-Path $env:LOCALAPPDATA 'Senmiva\ml'
$workspacePointer = Join-Path $repositoryRoot '.local\ml-workspace.json'
if (Test-Path -LiteralPath $workspacePointer) {
  $trainingRoot = (Get-Content -LiteralPath $workspacePointer -Raw | ConvertFrom-Json).workspace_path
}
if ($env:SENMIVA_ML_WORKSPACE) { $trainingRoot = $env:SENMIVA_ML_WORKSPACE }
$trainingPython = Join-Path $trainingRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $trainingPython)) {
  throw 'Run scripts/ml-setup.ps1 first. Training uses its own private environment.'
}
$env:PYTHONPATH = Join-Path $repositoryRoot 'ml\src'
& $trainingPython -m senmiva_training @TrainingArguments
exit $LASTEXITCODE
