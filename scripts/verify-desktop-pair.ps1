param(
  [int]$BridgePort = 7430,
  [int]$TimeoutSeconds = 90,
  [switch]$KeepOpen
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$DesktopRoot = Join-Path $RepoRoot 'apps\desktop'
$MainEntry = Join-Path $DesktopRoot 'dist-electron\main.js'
$MainEntryArg = '"' + $MainEntry + '"'
$ElectronExe = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'
$BridgeToken = if ($env:NEMESIS_BRIDGE_TOKEN) { $env:NEMESIS_BRIDGE_TOKEN } else { [Guid]::NewGuid().ToString('N') }
$NemesisUserData = Join-Path ([System.IO.Path]::GetTempPath()) ("nemesis-smoke-" + [Guid]::NewGuid().ToString('N'))
$GeaUserData = Join-Path ([System.IO.Path]::GetTempPath()) ("gea-smoke-" + [Guid]::NewGuid().ToString('N'))

function Wait-ForCondition($Label, [scriptblock]$Predicate) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = $null
  while ((Get-Date) -lt $deadline) {
    try {
      if (& $Predicate) { return }
    } catch {
      $lastError = $_
    }
    Start-Sleep -Milliseconds 500
  }
  if ($lastError) {
    throw "$Label timed out after $TimeoutSeconds seconds: $lastError"
  }
  throw "$Label timed out after $TimeoutSeconds seconds"
}

function Get-WindowByTitle($Pattern) {
  Get-Process |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like $Pattern } |
    Select-Object -First 1
}

function Receive-WsMessage($WebSocket, [int]$Milliseconds = 5000) {
  $buffer = New-Object byte[] 8192
  $segment = [ArraySegment[byte]]::new($buffer)
  $cts = [System.Threading.CancellationTokenSource]::new($Milliseconds)
  try {
    $result = $WebSocket.ReceiveAsync($segment, $cts.Token).GetAwaiter().GetResult()
    if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { return $null }
    return [System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
  } finally {
    $cts.Dispose()
  }
}

function Send-WsJson($WebSocket, $Payload) {
  $json = $Payload | ConvertTo-Json -Compress -Depth 10
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $segment = [ArraySegment[byte]]::new($bytes)
  $WebSocket.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()
}

function Test-BridgeContract {
  $encodedToken = [Uri]::EscapeDataString($BridgeToken)
  $uri = [Uri]::new("ws://127.0.0.1:$BridgePort/?token=$encodedToken")
  $ws = [System.Net.WebSockets.ClientWebSocket]::new()
  try {
    $ws.ConnectAsync($uri, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $seen = @{}
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline -and (!$seen['bridge:hello'] -or !$seen['nemesis:state'])) {
      $message = Receive-WsMessage $ws 5000
      if (!$message) { continue }
      $parsed = $message | ConvertFrom-Json
      $seen[$parsed.type] = $true
    }
    if (!$seen['bridge:hello']) { throw 'bridge:hello was not observed' }
    if (!$seen['nemesis:state']) { throw 'nemesis:state was not observed' }

    Send-WsJson $ws @{ type = 'bridge:ping'; payload = @{}; seq = 1 }
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
      $message = Receive-WsMessage $ws 5000
      if (!$message) { continue }
      $parsed = $message | ConvertFrom-Json
      if ($parsed.type -eq 'bridge:pong') {
        return $true
      }
    }
    throw 'bridge:pong was not observed'
  } finally {
    if ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
      $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'done', [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()
    }
    $ws.Dispose()
  }
}

if (!(Test-Path -LiteralPath $MainEntry)) {
  throw "Build required before smoke: $MainEntry is missing. Run npm run build first."
}
if (!(Test-Path -LiteralPath $ElectronExe)) {
  throw "Electron launcher missing: $ElectronExe"
}

New-Item -ItemType Directory -Force -Path $NemesisUserData, $GeaUserData | Out-Null

$envBlock = @{
  NEMESIS_BRIDGE_HOST = '127.0.0.1'
  NEMESIS_BRIDGE_PORT = [string]$BridgePort
  NEMESIS_BRIDGE_TOKEN = $BridgeToken
  NEMESIS_E2E_USER_DATA = $NemesisUserData
  GEA_E2E_USER_DATA = $GeaUserData
  GEA_TAPE_REST = 'false'
  GEA_PUBLIC_DATA = 'false'
  NEMESIS_STARTUP_TRACE = 'true'
  NEMESIS_STARTUP_TRACE_FILE = (Join-Path $NemesisUserData 'startup-trace.log')
}

$oldEnv = @{}
foreach ($key in $envBlock.Keys) {
  $oldEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
  [Environment]::SetEnvironmentVariable($key, $envBlock[$key], 'Process')
}

$process = $null
try {
  $process = Start-Process -FilePath $ElectronExe -ArgumentList @($MainEntryArg) -WorkingDirectory $DesktopRoot -PassThru
  Wait-ForCondition 'NEMESIS window' { Get-WindowByTitle 'NEMESIS' }
  Wait-ForCondition 'GEA window' { Get-WindowByTitle '*Global Event Alpha*' }
  Wait-ForCondition 'bridge contract' { Test-BridgeContract }

  $nemesis = Get-WindowByTitle 'NEMESIS'
  $gea = Get-WindowByTitle '*Global Event Alpha*'
  [pscustomobject]@{
    NemesisPid = $nemesis.Id
    NemesisHandle = $nemesis.MainWindowHandle
    NemesisTitle = $nemesis.MainWindowTitle
    GeaPid = $gea.Id
    GeaHandle = $gea.MainWindowHandle
    GeaTitle = $gea.MainWindowTitle
    Bridge = "127.0.0.1:$BridgePort"
    Contract = 'bridge:hello,nemesis:state,bridge:pong'
  } | Format-List
} finally {
  foreach ($key in $envBlock.Keys) {
    [Environment]::SetEnvironmentVariable($key, $oldEnv[$key], 'Process')
  }
  if (!$KeepOpen -and $process -and !$process.HasExited) {
    taskkill /pid $process.Id /T /F | Out-Null
  }
}
