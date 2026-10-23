# Run locally; credentials are prompted securely and stored with Windows DPAPI.
# No production migration, restore, upload, deletion, deployment or Git operations.
[CmdletBinding()]
param(
  [switch]$Configure,
  [switch]$Reconfigure,
  [switch]$CheckTools,
  [string]$PgBin = 'C:\Program Files\PostgreSQL\17\bin',
  [string]$BackupRoot = (Join-Path $env:USERPROFILE 'Golconda Backups')
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$projectRef = 'ntcvrxdyukfpobjvxxiz'

function Assert-OutsideGit([string]$Path) {
  $cursor = [IO.Path]::GetFullPath($Path)
  while ($cursor) {
    if (Test-Path -LiteralPath (Join-Path $cursor '.git')) { throw 'Backup destination is inside a Git repository. Choose another folder.' }
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Use a direct local backup path without junctions or symlinks.' }
    $parent = Split-Path $cursor -Parent
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
}
function Get-AccessOnlyDirectoryAcl([IO.DirectoryInfo]$Directory) {
  # Load only Access (DACL): never request Owner, Group or Audit/SACL sections.
  if ($PSVersionTable.PSEdition -eq 'Core') {
    return [IO.FileSystemAclExtensions]::GetAccessControl($Directory, [Security.AccessControl.AccessControlSections]::Access)
  }
  return $Directory.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
}
function Set-AccessOnlyDirectoryAcl([IO.DirectoryInfo]$Directory, [Security.AccessControl.DirectorySecurity]$Acl) {
  # Persist only modified sections via .NET, not the PowerShell Set-Acl provider.
  # The descriptor was loaded as Access-only and only DACL rules were modified.
  if ($PSVersionTable.PSEdition -eq 'Core') {
    [IO.FileSystemAclExtensions]::SetAccessControl($Directory, $Acl)
  } else {
    $Directory.SetAccessControl($Acl)
  }
}
function New-PrivateFolder([string]$Path) {
  try {
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path | Out-Null }
    $directory = Get-Item -LiteralPath $Path -Force
    if ($directory -isnot [IO.DirectoryInfo] -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'A direct directory is required.' }
    $acl = Get-AccessOnlyDirectoryAcl $directory
    $acl.SetAccessRuleProtection($true, $false)
    # Remove explicit broad/deny entries too; inherited entries were removed above.
    foreach ($rule in @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleSpecific($rule) }
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $allowedSids = @($userSid, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
    $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    foreach ($sid in $allowedSids) {
      $identity = [Security.Principal.SecurityIdentifier]::new($sid)
      $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', $inheritance, 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    Set-AccessOnlyDirectoryAcl $directory $acl
    # Read back from disk, not the in-memory descriptor; fail before secret writes.
    $verified = Get-AccessOnlyDirectoryAcl $directory
    $rules = @($verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $verified.AreAccessRulesProtected -or $rules.Count -ne $allowedSids.Count) { throw 'Folder DACL verification failed.' }
    foreach ($rule in $rules) {
      if ($rule.IdentityReference.Value -notin $allowedSids -or $rule.IsInherited -or
          $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
          $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
          $rule.InheritanceFlags -ne $inheritance -or
          $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'Unexpected folder access rule.' }
    }
    foreach ($sid in $allowedSids) { if (@($rules | Where-Object { $_.IdentityReference.Value -eq $sid }).Count -ne 1) { throw 'Required folder access is missing.' } }
  } catch {
    throw 'Secure backup folder permissions could not be established and verified. Stopping before credential/backup writes. Use a local NTFS folder your Windows account is permitted to manage; auditing/ownership privileges are not requested.'
  }
}
function Set-SecretEnv([string]$Name, [Security.SecureString]$Secret) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
  try { [Environment]::SetEnvironmentVariable($Name, [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr), 'Process') }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
function Invoke-Pg([string]$Tool, [string[]]$Arguments, [string]$Output, [string]$Log) {
  $Arguments = Get-PgArguments $Tool $Arguments $config.user
  & (Join-Path $PgBin ($Tool + '.exe')) @Arguments 1> $Output 2> $Log
  if ($LASTEXITCODE -ne 0) { throw "$Tool failed. Stop: private backup logs must be reviewed; no tables will be skipped." }
}
function Get-PgArguments([string]$Tool, [string[]]$Arguments, [string]$User) {
  if ($Tool -in @('psql','pg_dump','pg_dumpall')) {
    if ([string]::IsNullOrWhiteSpace($User) -or @($Arguments | Where-Object { $_ -match '^(-U|--username)' }).Count) { throw 'A single validated database username is required.' }
    return $Arguments + @('--username=' + $User)
  }
  return $Arguments
}
function Assert-BackupCredentialState($State) {
  $c=$State.Config
  $direct=$c.host -eq "db.$projectRef.supabase.co" -and $c.user -eq 'postgres'
  $pooler=$c.host -match '^[a-zA-Z0-9.-]+\.pooler\.supabase\.com$' -and $c.user -eq "postgres.$projectRef"
  if ($State.Version -ne 1 -or $c.projectRef -ne $projectRef -or (-not ($direct -or $pooler)) -or $c.port -ne 5432 -or $c.database -ne 'postgres' -or
      $State.DatabaseCredential -isnot [Management.Automation.PSCredential] -or $State.StorageCredential -isnot [Management.Automation.PSCredential] -or
      $State.DatabaseCredential.UserName -ne $c.user -or $State.StorageCredential.UserName -ne 'supabase-storage' -or
      $State.DatabaseCredential.Password.Length -eq 0 -or $State.StorageCredential.Password.Length -eq 0) { throw 'Credential/config project mismatch or invalid encrypted credentials.' }
}
function Test-SecureStringEqual([Security.SecureString]$Left, [Security.SecureString]$Right) {
  if ($Left.Length -ne $Right.Length) { return $false }
  $a=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($Left)
  $b=[IntPtr]::Zero
  try {
    $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($Right)
    $difference=0
    for ($i=0;$i -lt $Left.Length;$i++) { $difference=$difference -bor ([Runtime.InteropServices.Marshal]::ReadInt16($a,$i*2) -bxor [Runtime.InteropServices.Marshal]::ReadInt16($b,$i*2)) }
    return $difference -eq 0
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($a)
    if ($b -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
  }
}
function Open-BackupCredentialLock([string]$Directory) {
  try { return [IO.File]::Open((Join-Path $Directory '.credential-state.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
  catch { throw 'Backup credentials are busy or unavailable. Retry after the other backup/configuration operation finishes.' }
}
function Publish-BackupCredentialBundle([string]$Candidate,[string]$Active,[string]$Previous) {
  if ([IO.File]::Exists($Active)) { [IO.File]::Replace($Candidate,$Active,$Previous) }
  else { [IO.File]::Move($Candidate,$Active) }
}
function Save-BackupCredentialState([string]$Directory,$State,[bool]$ReplaceExisting,[scriptblock]$ValidateAccess) {
  if ($env:OS -ne 'Windows_NT') { throw 'Windows DPAPI encryption is required.' }
  Assert-BackupCredentialState $State
  if ($null -eq $ValidateAccess) { throw 'Read-only credential validation is required.' }
  $lock=Open-BackupCredentialLock $Directory
  $candidate=Join-Path $Directory ('.candidate-'+[Guid]::NewGuid().ToString('N')+'.xml')
  $active=Join-Path $Directory 'credentials.bundle.xml'
  try {
    $existing=@('credentials.bundle.xml','connection.json','database.xml','storage.xml' | Where-Object { Test-Path -LiteralPath (Join-Path $Directory $_) })
    if (-not $ReplaceExisting -and $existing.Count) { throw 'Existing backup configuration is preserved. Use -Reconfigure to replace it explicitly.' }
    $State | Export-Clixml -LiteralPath $candidate -Depth 8 -Encoding UTF8 -NoClobber
    $cipher=[xml](Get-Content -LiteralPath $candidate -Raw)
    $secrets=@($cipher.SelectNodes('//*[local-name()="SS"]'))
    if ($secrets.Count -ne 2 -or @($secrets | Where-Object { $_.InnerText -notmatch '^01000000d08c9ddf0115d1118c7a00c04fc297eb' }).Count) { throw 'Windows DPAPI encryption verification failed.' }
    $verified=Import-Clixml -LiteralPath $candidate
    Assert-BackupCredentialState $verified
    foreach ($field in @('projectRef','host','user','port','database')) { if ($verified.Config.$field -ne $State.Config.$field) { throw 'Encrypted configuration round-trip failed.' } }
    if (-not (Test-SecureStringEqual $verified.DatabaseCredential.Password $State.DatabaseCredential.Password) -or
        -not (Test-SecureStringEqual $verified.StorageCredential.Password $State.StorageCredential.Password)) { throw 'Encrypted credential round-trip failed.' }
    # Nothing active changes until both read-only authentication checks succeed.
    & $ValidateAccess $verified
    $stream=[IO.File]::Open($candidate,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try { $stream.Flush($true) } finally { $stream.Dispose() }
    $previous=Join-Path $Directory ('.previous-'+[Guid]::NewGuid().ToString('N')+'.xml')
    Publish-BackupCredentialBundle $candidate $active $previous
  } finally {
    # Only remove this operation's unique encrypted candidate, never legacy files.
    try { if ([IO.File]::Exists($candidate)) { [IO.File]::Delete($candidate) } }
    finally { $lock.Dispose() }
  }
}
function Read-BackupCredentialState([string]$Directory) {
  $lock=Open-BackupCredentialLock $Directory
  try {
    $active=Join-Path $Directory 'credentials.bundle.xml'
    if (Test-Path -LiteralPath $active) { $state=Import-Clixml -LiteralPath $active }
    else {
      foreach ($file in @('connection.json','database.xml','storage.xml')) { if (-not (Test-Path -LiteralPath (Join-Path $Directory $file))) { throw 'Run -Configure first, or -Reconfigure to repair incomplete credentials.' } }
      $state=[pscustomobject]@{Version=1;Config=(Get-Content -LiteralPath (Join-Path $Directory 'connection.json') -Raw | ConvertFrom-Json);DatabaseCredential=(Import-Clixml -LiteralPath (Join-Path $Directory 'database.xml'));StorageCredential=(Import-Clixml -LiteralPath (Join-Path $Directory 'storage.xml'))}
    }
    Assert-BackupCredentialState $state
    return $state
  } finally { $lock.Dispose() }
}
function New-BackupProbeStartInfo([string]$Executable,[string]$Arguments,$State) {
  $start=[Diagnostics.ProcessStartInfo]::new()
  $start.FileName=$Executable; $start.Arguments=$Arguments
  $start.UseShellExecute=$false; $start.CreateNoWindow=$true
  $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
  foreach ($name in @('PGPASSWORD','PGPASSFILE','PGSERVICE','PGSERVICEFILE','GSS_BACKUP_SECRET_KEY')) { $start.EnvironmentVariables.Remove($name) }
  $start.EnvironmentVariables['PGHOST']=[string]$State.Config.host
  $start.EnvironmentVariables['PGPORT']='5432'
  $start.EnvironmentVariables['PGUSER']=[string]$State.Config.user
  $start.EnvironmentVariables['PGDATABASE']='postgres'
  $start.EnvironmentVariables['PGSSLMODE']='require'
  $start.EnvironmentVariables['PGCONNECT_TIMEOUT']='10'
  $start.EnvironmentVariables['PGOPTIONS']='-c default_transaction_read_only=on -c statement_timeout=10000'
  return $start
}
function Invoke-PrivateCredentialProbe([Diagnostics.ProcessStartInfo]$Start,[string]$FailureMessage) {
  $process=[Diagnostics.Process]::new(); $process.StartInfo=$Start
  try {
    $null=$process.Start()
    $output=$process.StandardOutput.ReadToEndAsync(); $errors=$process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(45000)) { $process.Kill(); throw $FailureMessage }
    $text=$output.GetAwaiter().GetResult(); $diagnostics=$errors.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0 -or -not [string]::IsNullOrWhiteSpace($diagnostics)) { throw $FailureMessage }
    return $text.Trim()
  } catch { throw $FailureMessage }
  finally {
    $Start.EnvironmentVariables.Remove('PGPASSWORD'); $Start.EnvironmentVariables.Remove('GSS_BACKUP_SECRET_KEY')
    $process.Dispose()
  }
}
function Test-BackupCredentialAccess($State) {
  $query="select current_setting('server_version_num')::int / 10000"
  $loginArguments=@(Get-PgArguments 'psql' @() $State.Config.user)
  $username=$loginArguments[0]
  $start=New-BackupProbeStartInfo (Join-Path $PgBin 'psql.exe') ("-X --no-password --tuples-only --no-align $username --command `"$query`"") $State
  $start.EnvironmentVariables['PGPASSWORD']=$State.DatabaseCredential.GetNetworkCredential().Password
  if ((Invoke-PrivateCredentialProbe $start 'Database login validation failed; existing credentials are unchanged. Check the Session pooler host, full username and database password.') -ne '17') { throw 'Unexpected production server version; existing credentials are unchanged.' }
  $node=(Get-Command node -ErrorAction Stop).Source
  $start=New-BackupProbeStartInfo $node ('"'+(Join-Path $PSScriptRoot 'manual-storage-backup.js')+'" --check-access') $State
  $start.EnvironmentVariables['GSS_BACKUP_SECRET_KEY']=$State.StorageCredential.GetNetworkCredential().Password
  $null=Invoke-PrivateCredentialProbe $start 'Storage server-key validation failed; existing credentials are unchanged. Check the secret/service_role key.'
}
function Assert-PgClientVersions([hashtable]$Versions, [int]$ServerMajor = 17) {
  $major = $null
  foreach ($tool in @('pg_dump','pg_restore','pg_dumpall','psql')) {
    $text = [string]$Versions[$tool]
    if ($text -notmatch ('^' + [regex]::Escape($tool) + ' \(PostgreSQL\) (\d+)\.\d+(?:\s|$)')) { throw "Unrecognized $tool version output." }
    $toolMajor = [int]$Matches[1]
    if ($toolMajor -notin @(17,18) -or $toolMajor -lt $ServerMajor) { throw 'Use supported PostgreSQL 17 or 18 clients that are not older than the server.' }
    if ($null -ne $major -and $toolMajor -ne $major) { throw 'Use pg_dump, pg_restore, pg_dumpall and psql from the same major-version toolchain.' }
    $major = $toolMajor
  }
  return $major
}

Assert-OutsideGit $BackupRoot
if (($Configure -and $Reconfigure) -or ($CheckTools -and ($Configure -or $Reconfigure))) { throw 'Choose only one of -Configure, -Reconfigure or -CheckTools.' }
$clientVersions = @{}
foreach ($tool in @('pg_dump','pg_restore','pg_dumpall','psql')) {
  if (-not (Test-Path -LiteralPath (Join-Path $PgBin ($tool + '.exe')))) { throw "Install PostgreSQL 17 or 18 client tools or supply -PgBin. Missing: $tool.exe" }
  $version = & (Join-Path $PgBin ($tool + '.exe')) --version
  if ($LASTEXITCODE -ne 0) { throw "Cannot read $tool client version." }
  $clientVersions[$tool] = ($version -join "`n").Trim()
}
$clientMajor = Assert-PgClientVersions $clientVersions
if ($CheckTools) {
  Write-Output "PostgreSQL $clientMajor toolchain: PASS. Supports export from the expected PostgreSQL 17 server. No credentials loaded or database connection made."
  return
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required.' }
New-PrivateFolder $BackupRoot
$credentialDir = Join-Path $BackupRoot 'credentials'
New-PrivateFolder $credentialDir
$configFile = Join-Path $credentialDir 'connection.json'
$databaseCredential = Join-Path $credentialDir 'database.xml'
$storageCredential = Join-Path $credentialDir 'storage.xml'
if ($Configure) {
  if (@($configFile,$databaseCredential,$storageCredential,(Join-Path $credentialDir 'credentials.bundle.xml') | Where-Object { Test-Path -LiteralPath $_ }).Count -gt 0) {
    throw 'Existing backup configuration is preserved. Use -Reconfigure to update it explicitly; otherwise encrypted credentials will not be overwritten.'
  }
}
if ($Configure -or $Reconfigure) {
  $dbHost = (Read-Host 'Database host from Supabase Connect (direct or Session pooler)').Trim()
  $dbUser = (Read-Host 'Database username from that connection').Trim()
  $direct = $dbHost -eq "db.$projectRef.supabase.co" -and $dbUser -eq 'postgres'
  $pooler = $dbHost -match '^[a-zA-Z0-9.-]+\.pooler\.supabase\.com$' -and $dbUser -eq "postgres.$projectRef"
  if (-not ($direct -or $pooler)) { throw 'Connection must identify the existing production project. Copy Session pooler or direct host/user from its Connect panel.' }
  $dbSecret = Read-Host 'Existing database password (hidden; do not paste into chat)' -AsSecureString
  if ($dbSecret.Length -eq 0) { throw 'Database password is required.' }
  $storageSecret = Read-Host 'Supabase server secret/service_role key (hidden)' -AsSecureString
  if ($storageSecret.Length -eq 0) { throw 'Storage server key is required.' }
  # A single encrypted bundle prevents mixed host/password/key generations.
  $state=[pscustomobject]@{Version=1;Config=[pscustomobject]@{projectRef=$projectRef;host=$dbHost;user=$dbUser;port=5432;database='postgres'};DatabaseCredential=[Management.Automation.PSCredential]::new($dbUser,$dbSecret);StorageCredential=[Management.Automation.PSCredential]::new('supabase-storage',$storageSecret)}
  Save-BackupCredentialState $credentialDir $state ([bool]$Reconfigure) { param($candidate) Test-BackupCredentialAccess $candidate }
  Write-Output 'Encrypted credentials validated and activated atomically. Previous encrypted state is retained. Run again without -Configure/-Reconfigure to create a backup.'
  return
}
$state=Read-BackupCredentialState $credentialDir
$config=$state.Config; $dbCred=$state.DatabaseCredential; $storageCred=$state.StorageCredential
$run = Join-Path $BackupRoot ((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
New-PrivateFolder $run
$variables = @('PGHOST','PGPORT','PGUSER','PGDATABASE','PGPASSWORD','PGPASSFILE','PGSERVICE','PGSERVICEFILE','PGSSLMODE','PGOPTIONS','PGAPPNAME','GSS_BACKUP_SECRET_KEY')
$previous = @{}
foreach ($name in $variables) { $previous[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
try {
  $env:PGHOST=$config.host; $env:PGPORT='5432'; $env:PGUSER=$config.user; $env:PGDATABASE='postgres'
  $env:PGSSLMODE='require'; $env:PGAPPNAME='golconda-readonly-backup'
  $env:PGOPTIONS='-c default_transaction_read_only=on -c lock_timeout=10000'
  foreach ($name in @('PGPASSFILE','PGSERVICE','PGSERVICEFILE')) { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue }
  Set-SecretEnv 'PGPASSWORD' $dbCred.Password
  Invoke-Pg 'psql' @('-X','--no-password','--tuples-only','--no-align','--command',"select current_setting('server_version_num')::int / 10000") (Join-Path $run 'server-version.txt') (Join-Path $run 'connection.log')
  $serverMajorText = (Get-Content (Join-Path $run 'server-version.txt') -Raw).Trim()
  if ($serverMajorText -ne '17') { throw 'Unexpected production PostgreSQL major version.' }
  $null = Assert-PgClientVersions $clientVersions ([int]$serverMajorText)
  $archive=Join-Path $run 'database.dump'
  # No schema/table exclusions; preserve data, ACLs, ownership and custom policies.
  Invoke-Pg 'pg_dump' @('--no-password','--format=custom','--quote-all-identifiers','--lock-wait-timeout=10s',('--file='+$archive)) (Join-Path $run 'dump.stdout.log') (Join-Path $run 'dump.log')
  # Global roles are supplementary; no role passwords are exported or reset.
  Invoke-Pg 'pg_dumpall' @('--no-password','--roles-only','--no-role-passwords',('--file='+(Join-Path $run 'roles.sql'))) (Join-Path $run 'roles.stdout.log') (Join-Path $run 'roles.log')
  Invoke-Pg 'pg_restore' @('--list',$archive) (Join-Path $run 'database.toc') (Join-Path $run 'archive-list.log')
  # No --dbname: fully read/decompress the archive to the Windows null device.
  # This NEVER restores into the production database.
  Invoke-Pg 'pg_restore' @('--exit-on-error','--file=NUL',$archive) (Join-Path $run 'archive-read.stdout.log') (Join-Path $run 'archive-read.log')
  foreach ($table in @('objects','buckets')) {
    Invoke-Pg 'pg_restore' @('--data-only','--schema=storage',('--table='+$table),('--file='+(Join-Path $run ('storage-'+$table+'.sql'))),$archive) (Join-Path $run ($table+'.stdout.log')) (Join-Path $run ($table+'.log'))
  }
  [Environment]::SetEnvironmentVariable('PGPASSWORD',$null,'Process')
  Set-SecretEnv 'GSS_BACKUP_SECRET_KEY' $storageCred.Password
  & node (Join-Path $PSScriptRoot 'manual-storage-backup.js') $run
  if ($LASTEXITCODE -ne 0) { throw 'Storage export/completeness verification failed. Backup is not verified.' }
  # Fail on warnings too: inspect them privately rather than assuming completeness.
  foreach ($log in @('connection.log','dump.log','roles.log','archive-list.log','archive-read.log','objects.log','buckets.log')) {
    if ((Get-Item -LiteralPath (Join-Path $run $log)).Length -gt 0) { throw 'A PostgreSQL backup log is nonempty. Review it privately before approving this backup.' }
  }
  $hashes=@()
  foreach ($file in @('database.dump','roles.sql','database.toc','storage-objects.sql','storage-buckets.sql','storage-manifest.json')) {
    $path=Join-Path $run $file
    $hashes += @{ file=$file; bytes=(Get-Item -LiteralPath $path).Length; sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
  }
  @{ projectRef=$projectRef; verifiedUtc=[DateTime]::UtcNow.ToString('o'); serverMajor=[int]$serverMajorText; clientMajor=$clientMajor; clientVersions=$clientVersions; databaseArchiveFullRead=$true; storageComparedToDump=$true; restoreRehearsal=$false; files=$hashes } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $run 'VERIFIED-INTEGRITY.json') -Encoding UTF8
  Write-Output "Database archive and Storage integrity checks passed. Backup folder: $run"
  Write-Output 'No restore rehearsal was performed. This script cannot authorize or execute a production release.'
} catch {
  Write-Error "Backup NOT verified. Partial artifacts remain protected at: $run. No migration/release was attempted. $($_.Exception.Message)"
  exit 1
} finally {
  foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name,$previous[$name],'Process') }
}
