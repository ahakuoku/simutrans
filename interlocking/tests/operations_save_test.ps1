param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][string]$Assets,
    [Parameter(Mandatory=$true)][string]$Pak,
    [Parameter(Mandatory=$true)][string]$SaveFile,
    [Parameter(Mandatory=$true)][string]$SourceFile,
    [Parameter(Mandatory=$true)][int]$Port
)
$ErrorActionPreference = 'Stop'
$testDir = Join-Path $PSScriptRoot 'operations-runtime'
if (Test-Path -LiteralPath $testDir) { throw 'Test directory already exists; inspect it before retrying.' }
$gameProcess = $null
$base = "http://127.0.0.1:$Port"
$oldPort = $env:TID_IL_PORT
$oldDebug = $env:TID_IL_DEBUG

function Post-Command([string]$Command) {
    Invoke-RestMethod "$base/api/cmd" -Method Post -Headers @{'X-IL-Panel'='1'} -ContentType 'text/plain; charset=utf-8' -Body $Command | Out-Null
}
function Confirm-Command([string]$Command) {
    Post-Command $Command
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        $events = Invoke-RestMethod "$base/api/events?since=0"
        $result = $events.events | Where-Object { $_.command -eq $Command } | Select-Object -Last 1
        if ($result) { if (!$result.ok) { throw $result.error }; return }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out: $($Command.Split(',')[0])"
}
function Save-Game([string]$Name) {
    $tcp = [Net.Sockets.TcpClient]::new('127.0.0.1', $Port)
    try {
        $stream = $tcp.GetStream(); $stream.ReadTimeout = 120000
        $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false)); $writer.AutoFlush = $true
        $reader = [IO.StreamReader]::new($stream)
        $writer.WriteLine("debug_save $Name")
        do { $reply = $reader.ReadLine() | ConvertFrom-Json } while ($reply.type -ne 'debug_save')
        if (!$reply.ok) { throw 'Save failed' }
    } finally { $tcp.Dispose() }
}
function Stop-Game {
    if ($gameProcess -and !$gameProcess.HasExited) { $gameProcess.Kill(); $gameProcess.WaitForExit() }
}
function Start-Game([string]$Name) {
    $script:gameProcess = Start-Process -FilePath $Executable -WorkingDirectory $testDir -WindowStyle Hidden -PassThru `
        -ArgumentList @('-set_workdir', ('"' + $testDir + '"'), '-singleuser', '-objects', ('"' + (Join-Path $Assets $Pak) + '"'), '-load', $Name, '-debug', '2', '-nosound', '-nomidi') `
        -RedirectStandardOutput (Join-Path $testDir "$Name-out.log") -RedirectStandardError (Join-Path $testDir "$Name-err.log")
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        if ($gameProcess.HasExited) { throw "Game exited: $Name" }
        try { $state = Invoke-RestMethod "$base/api/status" -TimeoutSec 1; if ($state.operations) { return } } catch {}
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Game did not start'
}
function Verify-Source([byte[]]$Expected) {
    $copy = [IO.MemoryStream]::new()
    try {
        while ($copy.Length -lt $Expected.Length) {
            $part = Invoke-RestMethod "$base/api/operations?offset=$($copy.Length)"
            if ($part.id -ne $token -or $part.offset -ne $copy.Length -or $part.bytes -ne $Expected.Length) { throw 'Wrong source metadata' }
            $bytes = [Convert]::FromHexString($part.data)
            if (!$bytes.Length) { throw 'Missing source bytes' }
            $copy.Write($bytes, 0, $bytes.Length)
        }
        if ([Convert]::ToHexString($copy.ToArray()) -ne [Convert]::ToHexString($Expected)) { throw 'Source changed during save/load' }
    } finally { $copy.Dispose() }
}
try {
    $probe = [Net.Sockets.TcpClient]::new()
    try { $probe.Connect('127.0.0.1', $Port); throw 'Port is already in use' } catch [Net.Sockets.SocketException] {} finally { $probe.Dispose() }
    New-Item -ItemType Directory -Path (Join-Path $testDir 'save') | Out-Null
    foreach ($folder in @('config','font','themes','text','script')) { Copy-Item -LiteralPath (Join-Path $Assets $folder) -Destination $testDir -Recurse }
    Copy-Item -LiteralPath $SaveFile -Destination (Join-Path $testDir 'save/initial.sve')
    $env:TID_IL_PORT = "$Port"; $env:TID_IL_DEBUG = '1'
    # Above 64KiB to exercise the byte-vector serialization, not rdwr_str's 16-bit length.
    $source = [Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText($SourceFile) + ("`n" * 70000))
    $token = '11111111111111111111111111111111'
    Start-Game 'initial'
    Confirm-Command "oud_begin,$token,-,$($source.Length),native.oud2"
    $offset = 0
    while ($offset -lt $source.Length / 2) {
        $size = [Math]::Min(1600, $source.Length - $offset)
        Post-Command "oud_part,$token,$offset,$([Convert]::ToHexString($source, $offset, $size).ToLowerInvariant())"
        $offset += $size
    }
    Save-Game 'partial'; Write-Output 'PASS: partial upload saved'; Stop-Game
    Start-Game 'partial'
    if ((Invoke-RestMethod "$base/api/status").operations.bytes -ne 0) { throw 'Partial upload became visible' }
    while ($offset -lt $source.Length) {
        $size = [Math]::Min(1600, $source.Length - $offset)
        Post-Command "oud_part,$token,$offset,$([Convert]::ToHexString($source, $offset, $size).ToLowerInvariant())"
        $offset += $size
    }
    Confirm-Command "oud_commit,$token"
    Confirm-Command "oud_select,$token,1"
    Verify-Source $source
    Write-Output 'PASS: partial upload restored and completed'
    Save-Game 'complete'; Write-Output 'PASS: complete diagram saved'; Stop-Game
    Start-Game 'complete'
    $meta = (Invoke-RestMethod "$base/api/status").operations
    if ($meta.id -ne $token -or $meta.file -ne 'native.oud2' -or $meta.diagram -ne 1) { throw 'Diagram selection not restored' }
    Verify-Source $source
    Write-Output 'PASS: actual save/restart, partial upload resume, >64KiB UTF-8 source and shared diagram selection'
} finally {
    Stop-Game
    $env:TID_IL_PORT = $oldPort; $env:TID_IL_DEBUG = $oldDebug
    if (Test-Path -LiteralPath $testDir) {
        $resolved = (Resolve-Path -LiteralPath $testDir).Path
        if ($resolved -ne [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'operations-runtime'))) { throw 'Unexpected cleanup path' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
