import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// Restrictive inherited ACEs are normal for new files under state/. Do not
// change production DACLs to inspect them. Compare SIDs, not localized names.
export function verifyMaintenanceAcl(file) {
  if (process.platform !== 'win32') {
    const s=fs.statSync(file);
    return (s.mode & 0o077)===0 && (s.uid===process.getuid() || s.uid===0);
  }
  const cmd = [
    "$ErrorActionPreference='Stop'",
    "$sid=[System.Security.Principal.SecurityIdentifier]",
    "$trusted=@('S-1-5-18','S-1-5-32-544',[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)",
    "$p=$env:QQ_MIGRATION_ACL_TARGET; if ([IO.Directory]::Exists($p)) {$acl=[IO.Directory]::GetAccessControl($p)} else {$acl=[IO.File]::GetAccessControl($p)}",
    "if ($trusted -notcontains $acl.GetOwner($sid).Value) {exit 2}",
    "$rules=@($acl.GetAccessRules($true,$true,$sid))",
    "if (!$rules.Count) {exit 3}",
    "foreach ($r in $rules) {if ($r.AccessControlType -eq 'Allow' -and $trusted -notcontains $r.IdentityReference.Value) {exit 4}}",
    "exit 0"
  ].join('; ');
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',cmd],{windowsHide:true,timeout:10000,
    env:{...process.env,QQ_MIGRATION_ACL_TARGET:file},stdio:'ignore'});
  return !r.error && r.status===0;
}
