# Offline regression tests: extract only the pure version validator, never the backup body.
$ErrorActionPreference = 'Stop'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'manual-backup.ps1'),[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'PowerShell syntax failure.' }
$definition=$ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-PgClientVersions'},$true)[0]
Invoke-Expression $definition.Extent.Text
function New-TestVersions([string]$Version) {
  $versions=@{}
  foreach($name in @('pg_dump','pg_restore','pg_dumpall','psql')) { $versions[$name]="$name (PostgreSQL) $Version" }
  return $versions
}
function Assert-Rejected([hashtable]$Versions,[int]$ServerMajor=17) {
  $rejected=$false
  try { $null=Assert-PgClientVersions $Versions $ServerMajor } catch { $rejected=$true }
  if (-not $rejected) { throw 'Unsafe or malformed toolchain was accepted.' }
}
foreach($version in @('17.11','18.6')) {
  $expected=[int]$version.Split('.')[0]
  if ((Assert-PgClientVersions (New-TestVersions $version) 17) -ne $expected) { throw 'Supported toolchain was rejected.' }
}
Assert-Rejected (New-TestVersions '16.6')
Assert-Rejected (New-TestVersions '19.1')
Assert-Rejected (New-TestVersions '18.6') 19
Assert-Rejected (New-TestVersions '17.11') 18
$mixed=New-TestVersions '18.6'; $mixed['pg_restore']='pg_restore (PostgreSQL) 17.11'
Assert-Rejected $mixed
$missing=New-TestVersions '18.6'; $missing.Remove('pg_dumpall')
Assert-Rejected $missing
$malformed=New-TestVersions '18.6'; $malformed['pg_dump']='unrecognized version 18.6'
Assert-Rejected $malformed
Write-Output 'Backup version regression tests: PASS (17/18 accepted; old/newer-than-supported, mixed, missing and malformed clients rejected).'
