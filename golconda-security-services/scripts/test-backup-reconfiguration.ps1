# All credentials/paths here are synthetic. No production connection is opened.
$ErrorActionPreference='Stop'
$projectRef='ntcvrxdyukfpobjvxxiz'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'manual-backup.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'PowerShell syntax failure.'}
$names=@('Get-AccessOnlyDirectoryAcl','Set-AccessOnlyDirectoryAcl','New-PrivateFolder','Assert-BackupCredentialState','Test-SecureStringEqual','Open-BackupCredentialLock','Publish-BackupCredentialBundle','Save-BackupCredentialState','Read-BackupCredentialState','Get-PgArguments','New-BackupProbeStartInfo','Invoke-PrivateCredentialProbe','Invoke-Pg')
foreach($definition in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){
 if($definition.Name -in $names){Invoke-Expression $definition.Extent.Text}
}
function New-SyntheticState([string]$Suffix){
 $password=ConvertTo-SecureString ('synthetic-db-'+$Suffix) -AsPlainText -Force
 $key=ConvertTo-SecureString ('synthetic-storage-'+$Suffix) -AsPlainText -Force
 return [pscustomobject]@{Version=1;Config=[pscustomobject]@{projectRef=$projectRef;host='synthetic.pooler.supabase.com';user="postgres.$projectRef";port=5432;database='postgres'};DatabaseCredential=[Management.Automation.PSCredential]::new("postgres.$projectRef",$password);StorageCredential=[Management.Automation.PSCredential]::new('supabase-storage',$key)}
}
function Assert-Fails([scriptblock]$Action){$failed=$false;try{& $Action}catch{$failed=$true};if(-not $failed){throw 'An unsafe credential operation unexpectedly succeeded.'}}
function Hash([string]$Path){return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash}
$tempBase=[IO.Path]::GetTempPath().TrimEnd('\')
$root=Join-Path $tempBase ('golconda-credential-regression-'+[Guid]::NewGuid().ToString('N'))
New-PrivateFolder $root
try{
 $old=New-SyntheticState 'old';$next=New-SyntheticState 'replacement'
 $old.Config | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'connection.json') -Encoding UTF8
 $old.DatabaseCredential | Export-Clixml -LiteralPath (Join-Path $root 'database.xml')
 $old.StorageCredential | Export-Clixml -LiteralPath (Join-Path $root 'storage.xml')
 $legacy=@{};foreach($name in @('connection.json','database.xml','storage.xml')){$legacy[$name]=Hash (Join-Path $root $name)}
 $loaded=Read-BackupCredentialState $root
 if(-not(Test-SecureStringEqual $loaded.DatabaseCredential.Password $old.DatabaseCredential.Password)){throw 'Legacy credentials were not read correctly.'}
 Assert-Fails { Save-BackupCredentialState $root $next $false { throw 'Validation should not run for Configure over existing files.' } }
 Assert-Fails { Save-BackupCredentialState $root $next $true { throw 'Synthetic login failure' } }
 if(Test-Path -LiteralPath (Join-Path $root 'credentials.bundle.xml')){throw 'Failed validation activated new credentials.'}
 foreach($name in $legacy.Keys){if((Hash (Join-Path $root $name)) -ne $legacy[$name]){throw 'Failed validation changed legacy credentials.'}}
 # Candidate is encrypted/readable while old state remains active before commit.
 Save-BackupCredentialState $root $next $true {
   param($candidate)
   if(Test-Path -LiteralPath (Join-Path $root 'credentials.bundle.xml')){throw 'Candidate was activated too soon.'}
   if(-not(Test-SecureStringEqual $candidate.DatabaseCredential.Password $next.DatabaseCredential.Password)){throw 'Candidate password round-trip failed.'}
 }
 $active=Join-Path $root 'credentials.bundle.xml'
 $loaded=Read-BackupCredentialState $root
 if(-not(Test-SecureStringEqual $loaded.DatabaseCredential.Password $next.DatabaseCredential.Password) -or -not(Test-SecureStringEqual $loaded.StorageCredential.Password $next.StorageCredential.Password)){throw 'New credential bundle did not activate together.'}
 foreach($name in $legacy.Keys){if((Hash (Join-Path $root $name)) -ne $legacy[$name]){throw 'Legacy credential backup was overwritten.'}}
 $activeHash=Hash $active
 Assert-Fails { Save-BackupCredentialState $root (New-SyntheticState 'bad') $true { throw 'Synthetic Storage key failure' } }
 if((Hash $active) -ne $activeHash){throw 'Failed reconfiguration changed active state.'}
 # Encryption/write and final rename failures both leave active credentials intact.
 & {
   function Export-Clixml { throw 'Synthetic encryption/write failure' }
   Assert-Fails { Save-BackupCredentialState $root (New-SyntheticState 'bad-export') $true {} }
 }
 & {
   function Publish-BackupCredentialBundle { throw 'Synthetic atomic commit failure' }
   Assert-Fails { Save-BackupCredentialState $root (New-SyntheticState 'bad-commit') $true {} }
 }
 if((Hash $active) -ne $activeHash){throw 'Failed encryption/commit changed active state.'}
 $lock=Open-BackupCredentialLock $root
 try{Assert-Fails { Save-BackupCredentialState $root (New-SyntheticState 'locked') $true {} }}finally{$lock.Dispose()}
 $latest=New-SyntheticState 'latest'
 Save-BackupCredentialState $root $latest $true {}
 $previous=@(Get-ChildItem -LiteralPath $root -Filter '.previous-*.xml' -Force)
 if($previous.Count -ne 1 -or (Hash $previous[0].FullName) -ne $activeHash){throw 'Atomic replacement did not retain the old encrypted bundle.'}
 if(@(Get-ChildItem -LiteralPath $root -Filter '.candidate-*.xml' -Force).Count){throw 'Failed candidates were not cleaned up.'}
 if((Get-Content -LiteralPath $active -Raw).Contains('synthetic-db-latest')){throw 'Credential bundle contains a plaintext password.'}
 $loaded=Read-BackupCredentialState $root
 foreach($tool in @('psql','pg_dump','pg_dumpall')){
   $arguments=@(Get-PgArguments $tool @('--version') $loaded.Config.user)
   if($arguments[1] -ne "--username=postgres.$projectRef" -or $arguments.Count -ne 2){throw 'Session pooler username was truncated or overridden.'}
 }
 $restore=@(Get-PgArguments 'pg_restore' @('--list','synthetic.dump') $loaded.Config.user)
 if($restore.Count -ne 2 -or $restore[0] -ne '--list'){throw 'Archive reader unexpectedly gained connection arguments.'}
 Assert-Fails { Get-PgArguments 'psql' @('--username=postgres') $loaded.Config.user }
 $start=New-BackupProbeStartInfo 'psql.exe' '--version' $loaded
 if($start.EnvironmentVariables['PGUSER'] -ne "postgres.$projectRef" -or $start.EnvironmentVariables['PGPORT'] -ne '5432' -or $start.EnvironmentVariables['PGPASSWORD']){throw 'Read-only probe environment has incorrect login values.'}
 # Exercise native process/argument handling using --version only, never login.
 $PgBin='C:\Program Files\PostgreSQL\18\bin'
 if(Test-Path -LiteralPath (Join-Path $PgBin 'psql.exe')){
   $config=$loaded.Config
   foreach($tool in @('psql','pg_dump')){
     Invoke-Pg $tool @('--version') (Join-Path $root ($tool+'.stdout')) (Join-Path $root ($tool+'.stderr'))
     if((Get-Content -LiteralPath (Join-Path $root ($tool+'.stdout')) -Raw) -notmatch '18\.') {throw 'Native client argument test failed.'}
   }
   $start=New-BackupProbeStartInfo (Join-Path $PgBin 'psql.exe') ("--username=postgres.$projectRef --version") $loaded
   $start.EnvironmentVariables['PGPASSWORD']='synthetic-probe-only'
   if((Invoke-PrivateCredentialProbe $start 'Synthetic private probe failure') -notmatch '18\.') {throw 'Private probe failed.'}
   if($start.EnvironmentVariables['PGPASSWORD']) {throw 'Private probe left a password in its environment.'}
   $start=New-BackupProbeStartInfo (Join-Path $PgBin 'psql.exe') '--synthetic-invalid-option' $loaded
   $start.EnvironmentVariables['PGPASSWORD']='synthetic-probe-only'
   $failed=$false
   try{$null=Invoke-PrivateCredentialProbe $start 'Synthetic safe failure'}catch{if($_.Exception.Message -ne 'Synthetic safe failure'){throw};$failed=$true}
   if(-not $failed -or $start.EnvironmentVariables['PGPASSWORD']){throw 'Probe error handling exposed state or failed to stop.'}
 }
 Write-Output 'Reconfiguration regressions: PASS (DPAPI round-trip, legacy compatibility, failed login/encryption/commit, atomic bundle switch, retained recovery copy, lock and full pooler username).'
}finally{
 $resolved=[IO.Path]::GetFullPath((Get-Item -LiteralPath $root -Force).FullName)
 if(-not [String]::Equals([IO.Path]::GetDirectoryName($resolved),$tempBase,[StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFileName($resolved).StartsWith('golconda-credential-regression-')){throw 'Unsafe test cleanup target.'}
 Remove-Item -LiteralPath $resolved -Recurse -Force
}
