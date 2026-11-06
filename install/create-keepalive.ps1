#Requires -RunAsAdministrator
$ErrorActionPreference='Stop'
$kaAction = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument '-d Debian -u root sleep infinity'
$kaTrigger = New-ScheduledTaskTrigger -AtLogOn
$kaSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'WslDockerKeepAlive' -Action $kaAction -Trigger $kaTrigger -Settings $kaSettings -Force | Out-Null
Start-ScheduledTask -TaskName 'WslDockerKeepAlive' -ErrorAction SilentlyContinue
'KEEPALIVE_OK'
