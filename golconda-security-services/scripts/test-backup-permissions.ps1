# Local synthetic fixtures only; never load the user's backup configuration.
$ErrorActionPreference = 'Stop'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'manual-backup.ps1'),[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'PowerShell syntax failure.' }
$names=@('Get-AccessOnlyDirectoryAcl','Set-AccessOnlyDirectoryAcl','New-PrivateFolder')
foreach ($definition in $ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)) {
  if ($definition.Name -in $names) { Invoke-Expression $definition.Extent.Text }
}
function Assert-Fails([scriptblock]$Action) {
  $failed=$false
  try { & $Action } catch { $failed=$true }
  if (-not $failed) { throw 'Permission failure did not stop safely.' }
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$administrator=([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$hasSecurityPrivilege=[bool]((& whoami.exe /priv /fo csv /nh) -match 'SeSecurityPrivilege')
Write-Output "Test token: Administrator=$administrator; SeSecurityPrivilege listed=$hasSecurityPrivilege"
$tempBase=[IO.Path]::GetTempPath().TrimEnd('\')
$root=Join-Path $tempBase ('golconda-dacl-regression-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
  $folder=Join-Path $root 'existing'
  New-Item -ItemType Directory -Path $folder | Out-Null
  $file=Join-Path $folder 'synthetic-encrypted-credential.xml'
  $secret=ConvertTo-SecureString 'synthetic-only-no-real-credential' -AsPlainText -Force
  [System.Management.Automation.PSCredential]::new('synthetic',$secret) | Export-Clixml -LiteralPath $file
  $beforeHash=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
  $beforeWrite=(Get-Item -LiteralPath $file).LastWriteTimeUtc
  $ownerBefore=(Get-Acl -LiteralPath $folder).Owner
  $directory=Get-Item -LiteralPath $folder
  $broad=Get-AccessOnlyDirectoryAcl $directory
  $broad.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))
  Set-AccessOnlyDirectoryAcl $directory $broad
  New-PrivateFolder $folder
  New-PrivateFolder $folder
  $after=Get-AccessOnlyDirectoryAcl $directory
  if (-not $after.AreAccessRulesProtected) { throw 'Inheritance remained enabled.' }
  $expected=@($identity.User.Value,'S-1-5-18','S-1-5-32-544') | Select-Object -Unique
  $rules=@($after.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne $expected.Count) { throw 'Unexpected ACE count.' }
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -notin $expected -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.IsInherited) { throw 'Unexpected folder access remained.' }
  }
  if ((Get-Acl -LiteralPath $folder).Owner -ne $ownerBefore) { throw 'Folder owner changed.' }
  if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $beforeHash -or (Get-Item -LiteralPath $file).LastWriteTimeUtc -ne $beforeWrite) { throw 'Existing encrypted credential content was changed.' }
  Assert-Fails { New-PrivateFolder $file }
  if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $beforeHash) { throw 'File-target failure changed credential content.' }
  # Existing configuration must stop Configure before any prompt or write.
  $configureNode=$ast.FindAll({param($node) $node -is [System.Management.Automation.Language.IfStatementAst] -and $node.Clauses[0].Item1.Extent.Text -eq '$Configure'},$true)[0]
  $body=$configureNode.Clauses[0].Item2.Extent.Text
  $configureGuard=[scriptblock]::Create($body.Substring(1,$body.Length-2))
  $credentialDir=$folder
  function Read-Host { throw 'Unexpected credential prompt during preservation test.' }
  foreach ($present in @('config','database','storage')) {
    $configFile=Join-Path $folder 'absent-config.json'
    $databaseCredential=Join-Path $folder 'absent-database.xml'
    $storageCredential=Join-Path $folder 'absent-storage.xml'
    if ($present -eq 'config') { $configFile=$file }
    elseif ($present -eq 'database') { $databaseCredential=$file }
    else { $storageCredential=$file }
    $stopped=$false
    try { & $configureGuard } catch {
      if ($_.Exception.Message -notmatch 'Existing backup configuration is preserved') { throw }
      $stopped=$true
    }
    if (-not $stopped) { throw 'Existing configuration was not preserved.' }
  }
  if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $beforeHash) { throw 'Configure altered encrypted credentials.' }
  New-PrivateFolder (Join-Path $root 'new-folder')
  # Simulate WRITE_DAC denial. No broad-access fallback is permitted.
  function Set-AccessOnlyDirectoryAcl { throw [UnauthorizedAccessException]::new('Synthetic WRITE_DAC denial') }
  Assert-Fails { New-PrivateFolder (Join-Path $root 'denied') }
  # Simulate an OS/filesystem ignoring the write: disk readback must catch it.
  function Set-AccessOnlyDirectoryAcl { }
  Assert-Fails { New-PrivateFolder (Join-Path $root 'ignored') }
  Write-Output 'DACL regressions: PASS (new/existing folder, broad-ACE removal, idempotency, unchanged owner/encrypted bytes, denied/ignored write and file-target rejection).'
} finally {
  # Delete only the directly allocated test directory after absolute-path checks.
  if (Test-Path -LiteralPath $root) {
    $resolved=[IO.Path]::GetFullPath((Get-Item -LiteralPath $root -Force).FullName)
    if (-not [String]::Equals([IO.Path]::GetDirectoryName($resolved),$tempBase,[StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFileName($resolved).StartsWith('golconda-dacl-regression-')) { throw 'Unsafe test cleanup target.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
