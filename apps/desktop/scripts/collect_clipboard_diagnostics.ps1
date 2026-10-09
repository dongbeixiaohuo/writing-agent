# Windows metadata-only diagnostics. Never reads or modifies clipboard contents.
[CmdletBinding()]
param(
    [ValidateRange(1, 300)][int]$DurationSeconds = 30,
    [ValidateRange(20, 1000)][int]$IntervalMilliseconds = 50,
    [string]$OutputDirectory,
    # Briefly open/close only; off by default to minimize interference.
    [switch]$ProbeClipboardAccess
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This collector supports Windows only.'
}
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $env:LOCALAPPDATA 'Writing Agent\diagnostics\clipboard'
}
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$reportName = 'clipboard-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$reportDirectory = Join-Path $outputRoot $reportName
[void][IO.Directory]::CreateDirectory($reportDirectory)
$utf8 = New-Object System.Text.UTF8Encoding($false)

if (-not ('WritingAgentClipboardDiagnosticsNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WritingAgentClipboardDiagnosticsNative {
    [DllImport("user32.dll")] public static extern IntPtr GetOpenClipboardWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetClipboardOwner();
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool OpenClipboard(IntPtr window);
    [DllImport("user32.dll")] private static extern bool CloseClipboard();
    public static int ProcessIdForWindow(IntPtr window) {
        if (window == IntPtr.Zero) return 0;
        uint processId;
        GetWindowThreadProcessId(window, out processId);
        return (int)processId;
    }
    public static bool ProbeAccess(out int error) {
        if (!OpenClipboard(IntPtr.Zero)) {
            error = Marshal.GetLastWin32Error();
            return false;
        }
        try { error = 0; return true; }
        finally { CloseClipboard(); }
    }
}
'@
}

$processNames = @{}
$lockCounts = @{}
$warnings = New-Object 'System.Collections.Generic.List[string]'

function Get-SafeProcessName([int]$ProcessId) {
    if ($ProcessId -eq 0) { return '' }
    if (-not $processNames.ContainsKey($ProcessId)) {
        try { $processNames[$ProcessId] = (Get-Process -Id $ProcessId -ErrorAction Stop).ProcessName }
        catch { $processNames[$ProcessId] = '(exited-or-inaccessible)' }
    }
    return $processNames[$ProcessId]
}

function Get-RelatedProcessSnapshot {
    try {
        # No window captions, documents, configuration files or invocation arguments.
        $related = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
            $_.Name -match '^(Writing Agent|electron|rdpclip|ctfmon|TextInputHost|Ditto|CopyQ|ClipboardFusion|Snipaste|AutoHotkey|PowerToys).*\.exe$'
        })
        foreach ($entry in $related) {
            $version = $null
            $cpuSeconds = $null
            $responding = $null
            try {
                $diagnosticProcess = Get-Process -Id $entry.ProcessId -ErrorAction Stop
                $cpuSeconds = $diagnosticProcess.CPU
                $responding = $diagnosticProcess.Responding
                if ($entry.Name -eq 'Writing Agent.exe' -and $entry.ExecutablePath) {
                    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($entry.ExecutablePath).ProductVersion
                }
            } catch { }
            [pscustomobject][ordered]@{
                processId = [int]$entry.ProcessId
                parentProcessId = [int]$entry.ParentProcessId
                name = $entry.Name
                writingAgentExecutable = $(if ($entry.Name -eq 'Writing Agent.exe') { $entry.ExecutablePath } else { $null })
                productVersion = $version
                createdAt = $(if ($entry.CreationDate) { $entry.CreationDate.ToString('o') } else { $null })
                threadCount = $entry.ThreadCount
                workingSetBytes = [long]$entry.WorkingSetSize
                cpuSeconds = $cpuSeconds
                responding = $responding
            }
        }
    } catch { $warnings.Add('Related process snapshot unavailable: ' + $_.Exception.GetType().Name) }
}

$startedAt = (Get-Date).ToString('o')
$startProcesses = @(Get-RelatedProcessSnapshot)
$osVersion = [Environment]::OSVersion.VersionString
$osCaption = $null
try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $osVersion = $os.Version + ' build ' + $os.BuildNumber
    $osCaption = $os.Caption
} catch { $warnings.Add('OS details unavailable: ' + $_.Exception.GetType().Name) }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$identity.Dispose()

$sampleCount = 0
$lockWindowSamples = 0
$probeSamples = 0
$probeFailures = 0
$sequenceChanges = 0
$previousSequence = $null
$captureFinished = $false
$writer = New-Object IO.StreamWriter((Join-Path $reportDirectory 'samples.csv'), $false, $utf8)
$writer.AutoFlush = $true
$clock = [Diagnostics.Stopwatch]::StartNew()
Write-Host ('Collecting clipboard metadata for ' + $DurationSeconds + ' seconds. Keep the affected apps open.')
Write-Host 'Try copy/paste with ordinary test text. No clipboard text or images will be read.'
if ($ProbeClipboardAccess) { Write-Host 'Access probe enabled: briefly opens/closes the clipboard, without reading any data.' }
try {
    while ($clock.Elapsed.TotalSeconds -lt $DurationSeconds) {
        $lockWindow = [WritingAgentClipboardDiagnosticsNative]::GetOpenClipboardWindow()
        $lockProcessId = [WritingAgentClipboardDiagnosticsNative]::ProcessIdForWindow($lockWindow)
        $ownerProcessId = [WritingAgentClipboardDiagnosticsNative]::ProcessIdForWindow([WritingAgentClipboardDiagnosticsNative]::GetClipboardOwner())
        $foregroundProcessId = [WritingAgentClipboardDiagnosticsNative]::ProcessIdForWindow([WritingAgentClipboardDiagnosticsNative]::GetForegroundWindow())
        $sequence = [WritingAgentClipboardDiagnosticsNative]::GetClipboardSequenceNumber()
        if ($null -ne $previousSequence -and $sequence -ne $previousSequence) { $sequenceChanges++ }
        $previousSequence = $sequence
        $accessResult = 'not-tested'
        [int]$accessError = 0
        if ($lockWindow -ne [IntPtr]::Zero) {
            $lockWindowSamples++
            if (-not $lockCounts.ContainsKey($lockProcessId)) { $lockCounts[$lockProcessId] = 0 }
            $lockCounts[$lockProcessId]++
        }
        if ($ProbeClipboardAccess) {
            $probeSamples++
            # A known locker is enough evidence; never try to take its lock.
            if ($lockWindow -ne [IntPtr]::Zero) { $accessResult = 'locker-window-observed' }
            elseif ([WritingAgentClipboardDiagnosticsNative]::ProbeAccess([ref]$accessError)) { $accessResult = 'available-at-probe' }
            else { $accessResult = 'open-failed-no-lock-window' }
            if ($accessResult -ne 'available-at-probe') { $probeFailures++ }
        }
        $row = [pscustomobject][ordered]@{
            Timestamp = (Get-Date).ToString('o')
            ElapsedMilliseconds = $clock.ElapsedMilliseconds
            ClipboardSequence = $sequence
            LockProcessId = $lockProcessId
            LockProcessName = Get-SafeProcessName $lockProcessId
            OwnerProcessId = $ownerProcessId
            OwnerProcessName = Get-SafeProcessName $ownerProcessId
            ForegroundProcessId = $foregroundProcessId
            ForegroundProcessName = Get-SafeProcessName $foregroundProcessId
            AccessProbeResult = $accessResult
            AccessProbeWin32Error = $accessError
        }
        $csv = @($row | ConvertTo-Csv -NoTypeInformation)
        if ($sampleCount -eq 0) { $writer.WriteLine($csv[0]) }
        $writer.WriteLine($csv[1])
        $sampleCount++
        Start-Sleep -Milliseconds $IntervalMilliseconds
    }
    $captureFinished = $true
} finally {
    $clock.Stop()
    $writer.Dispose()
    $report = [ordered]@{
        schemaVersion = 1
        startedAt = $startedAt
        finishedAt = (Get-Date).ToString('o')
        privacy = @{ clipboardContentCollected = $false; windowTitlesCollected = $false; commandLinesCollected = $false; networkRequestsMade = $false }
        capture = @{ requestedSeconds = $DurationSeconds; intervalMilliseconds = $IntervalMilliseconds; elapsedMilliseconds = $clock.ElapsedMilliseconds; completed = $captureFinished; probeClipboardAccess = [bool]$ProbeClipboardAccess }
        environment = @{ os = $osCaption; osVersion = $osVersion; powershellVersion = $PSVersionTable.PSVersion.ToString(); is64BitProcess = [Environment]::Is64BitProcess; isElevated = $isElevated; sessionType = $env:SESSIONNAME }
        summary = @{ sampleCount = $sampleCount; lockWindowSamples = $lockWindowSamples; availabilityProbeSamples = $probeSamples; unavailableProbeSamples = $probeFailures; clipboardSequenceChanges = $sequenceChanges }
        lockers = @($lockCounts.Keys | Sort-Object | ForEach-Object { @{ processId = $_; name = Get-SafeProcessName $_; observedSamples = $lockCounts[$_] } })
        observedProcesses = @($processNames.Keys | Sort-Object | ForEach-Object { @{ processId = $_; name = $processNames[$_] } })
        processSnapshots = @{ start = $startProcesses; end = @(Get-RelatedProcessSnapshot) }
        limitations = @('Clipboard ownership is not a lock and is not proof of the root cause.', 'A missing lock window does not prove availability; NULL-handle lockers and brief races are possible.', 'Sampling cannot identify global keyboard hooks or prove that an application is responsible.', 'A successful access probe does not test paste or delayed data rendering.', 'Executable paths and process names may contain personal information; inspect the report before sharing.')
        warnings = @($warnings.ToArray())
    }
    [IO.File]::WriteAllText((Join-Path $reportDirectory 'report.json'), ($report | ConvertTo-Json -Depth 8), $utf8)
}

$readme = @'
Writing Agent clipboard diagnostics

Files: report.json (environment, process snapshots and counts), samples.csv (timestamped metadata).
No clipboard text/images, window captions, account credentials or typed text are collected.
The optional access probe briefly opens and immediately closes the clipboard; it never reads data.
Clipboard OWNER means the last data provider, not necessarily the current LOCKER.
No locker observed is not proof of availability or of the root cause.
A failed probe with no locker window can occur when a process opened with a NULL window.
Successful opening does not test delayed data rendering or the actual paste operation.
This collector does not clear the clipboard, terminate processes, change settings or send network data.
Before sharing, inspect executable paths and process names; they may contain personal information.
Report the time of failure, affected apps, whether right-click paste works, and whether exiting
Writing Agent (not merely minimizing it) restores normal behavior. Normal and abnormal runs help comparison.
'@
[IO.File]::WriteAllText((Join-Path $reportDirectory 'README.txt'), $readme, $utf8)
$zipPath = Join-Path $outputRoot ($reportName + '.zip')
Compress-Archive -LiteralPath @((Join-Path $reportDirectory 'report.json'), (Join-Path $reportDirectory 'samples.csv'), (Join-Path $reportDirectory 'README.txt')) -DestinationPath $zipPath
Write-Host ('Samples: ' + $sampleCount + '; locker-window samples: ' + $lockWindowSamples + '; unavailable probes: ' + $probeFailures)
Write-Host ('ZIP: ' + $zipPath)
Write-Output $zipPath
