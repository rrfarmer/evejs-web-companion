<#
.SYNOPSIS
    EvEJS Web Client one-stop setup.

.DESCRIPTION
    Connects the browser client to your EvEJS server, whichever way each of them
    is running. There are four combinations (server native or in Docker, client
    native or in Docker) and all four work -- but two of them need a shared
    secret that nobody can be expected to know about, let alone generate and
    paste into two files by hand. This does that.

    The one non-obvious rule it exists to hide: EvEJS lets a caller in without a
    token only when the connection appears to come from 127.0.0.1. When the
    SERVER runs in Docker that stops being true -- Docker rewrites the address --
    and the client is refused with the port open, the server healthy and the
    address unchanged. A shared token fixes it. A native server never needs one,
    so this script never has to change how you start EvEJS.

    Re-runnable. It reuses an existing token rather than churning a new one, so
    running it again does not force a server restart.

.EXAMPLE
    .\SetupWebClient.bat
    .\SetupWebClient.bat -Status
    .\SetupWebClient.bat -Mode docker -NonInteractive
#>
[CmdletBinding()]
param(
  # How to run the BROWSER CLIENT. "auto" asks, preferring what is already set up.
  [ValidateSet("auto", "native", "docker")]
  [string]$Mode = "auto",

  # Where the EvEJS server repo lives. Auto-detected from ..\eve.js when omitted.
  [string]$EveRoot = "",

  # Report what each step would do without changing anything.
  [switch]$Status,

  # Never prompt. Optional steps are skipped instead of asked about.
  [switch]$NonInteractive,

  # Set up only; do not start the client at the end.
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 1.0

# ═══════════════════════════════════════════════════════════════════════════════
# PATHS
# ═══════════════════════════════════════════════════════════════════════════════
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$WebEnvPath = Join-Path $RepoRoot ".env"
$ComposeBase = Join-Path $RepoRoot "compose.yaml"
$ComposeOverlay = Join-Path $RepoRoot "compose.evejs-docker.yaml"

$GatewayProbeUrl = "http://127.0.0.1:26002/_evejs-web/v1/health"
$ClientUrl = "http://127.0.0.1:26500"

# ═══════════════════════════════════════════════════════════════════════════════
# OUTPUT
# ═══════════════════════════════════════════════════════════════════════════════
function Write-Banner {
  param([string]$Text)
  Write-Host ""
  Write-Host "  ============================================================" -ForegroundColor DarkCyan
  Write-Host "    $Text" -ForegroundColor Cyan
  Write-Host "  ============================================================" -ForegroundColor DarkCyan
  Write-Host ""
}

function Write-Info {
  param([string]$Text)
  Write-Host "  $Text" -ForegroundColor Gray
}

function Write-Detail {
  param([string]$Text)
  Write-Host "        $Text" -ForegroundColor DarkGray
}

function Write-Step {
  param([string]$Label, [string]$Title, [string]$Detail, [string]$Color)
  Write-Host ("  {0,-8}" -f $Label) -ForegroundColor $Color -NoNewline
  Write-Host $Title -ForegroundColor White
  if ($Detail) { Write-Detail $Detail }
}

function Write-Ok      { param([string]$T, [string]$D) Write-Step "  ok" $T $D "Green" }
function Write-Changed { param([string]$T, [string]$D) Write-Step " done" $T $D "Cyan" }
function Write-Skipped { param([string]$T, [string]$D) Write-Step " skip" $T $D "DarkGray" }
function Write-Problem { param([string]$T, [string]$D) Write-Step "  --" $T $D "Yellow" }

function Write-Advice {
  param([string[]]$Lines)
  Write-Host ""
  foreach ($line in $Lines) { Write-Host "  $line" -ForegroundColor Yellow }
  Write-Host ""
}

function Read-Choice {
  param([string]$Question, [string[]]$Options, [int]$DefaultIndex = 0)
  if ($NonInteractive) { return $DefaultIndex }
  Write-Host ""
  Write-Host "  $Question" -ForegroundColor Yellow
  for ($i = 0; $i -lt $Options.Count; $i++) {
    $marker = " "
    if ($i -eq $DefaultIndex) { $marker = "*" }
    Write-Host ("    [{0}]{1} {2}" -f ($i + 1), $marker, $Options[$i])
  }
  Write-Host ""
  $answer = Read-Host "  Choose [1-$($Options.Count)]"
  if (-not $answer) { return $DefaultIndex }
  $parsed = 0
  if ([int]::TryParse($answer, [ref]$parsed) -and $parsed -ge 1 -and $parsed -le $Options.Count) {
    return ($parsed - 1)
  }
  return $DefaultIndex
}

function Read-YesNo {
  param([string]$Question, [bool]$Default = $true)
  if ($NonInteractive) { return $Default }
  $suffix = "[Y/n]"
  if (-not $Default) { $suffix = "[y/N]" }
  Write-Host ""
  $answer = Read-Host "  $Question $suffix"
  if (-not $answer) { return $Default }
  return ($answer.Trim().ToLower() -match '^y')
}

# ═══════════════════════════════════════════════════════════════════════════════
# SMALL HELPERS
# ═══════════════════════════════════════════════════════════════════════════════
function Get-CommandPath {
  param([string[]]$Names)
  foreach ($name in $Names) {
    $found = Get-Command $name -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
  }
  return $null
}

function Test-DockerReady {
  $docker = Get-CommandPath @("docker")
  if (-not $docker) { return $false }
  try {
    $osType = & docker info --format '{{.OSType}}' 2>$null
    return ($LASTEXITCODE -eq 0 -and $osType -eq "linux")
  } catch {
    return $false
  }
}

# Read a KEY=VALUE file into a hashtable, keeping blank/comment lines out of the
# way. Deliberately tolerant: these files are hand-editable and a stray comment
# must never break setup.
function Read-EnvFile {
  param([string]$Path)
  $map = @{}
  if (-not (Test-Path $Path)) { return $map }
  foreach ($line in (Get-Content -LiteralPath $Path)) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $split = $trimmed.IndexOf("=")
    if ($split -lt 1) { continue }
    $map[$trimmed.Substring(0, $split).Trim()] = $trimmed.Substring($split + 1).Trim()
  }
  return $map
}

# Rewrite one key in place, preserving every other line (comments included) so a
# user's own edits survive re-running setup.
function Set-EnvValue {
  param([string]$Path, [string]$Key, [string]$Value, [string]$Header = "")
  $lines = @()
  if (Test-Path $Path) { $lines = @(Get-Content -LiteralPath $Path) }
  $replaced = $false
  $output = @()
  foreach ($line in $lines) {
    if ($line.Trim() -match "^$([regex]::Escape($Key))\s*=") {
      if (-not $replaced) { $output += "$Key=$Value"; $replaced = $true }
    } else {
      $output += $line
    }
  }
  if (-not $replaced) {
    if ($output.Count -eq 0 -and $Header) { $output += $Header; $output += "" }
    $output += "$Key=$Value"
  }
  # ASCII, no BOM: Docker Compose reads these and a BOM corrupts the first key.
  Set-Content -LiteralPath $Path -Value $output -Encoding ascii
}

function New-SharedToken {
  $bytes = New-Object 'System.Byte[]' 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return [Convert]::ToBase64String($bytes)
}

function Test-GatewayPort {
  try {
    $request = [System.Net.WebRequest]::Create($GatewayProbeUrl)
    $request.Timeout = 2500
    $request.Method = "GET"
    $response = $request.GetResponse()
    $response.Close()
    return $true
  } catch [System.Net.WebException] {
    # A 401 is still proof something is listening and speaking HTTP -- that is
    # exactly the refused-without-a-token case this script exists to fix, so it
    # must NOT be reported as "server not running".
    if ($_.Exception.Response) { return $true }
    return $false
  } catch {
    return $false
  }
}

function Get-EveJsDockerState {
  if (-not (Test-DockerReady)) { return "none" }
  $names = & docker ps --filter "name=evejs-server" --format "{{.Names}}" 2>$null
  if ($LASTEXITCODE -eq 0 -and $names) { return "running" }
  return "none"
}

# ═══════════════════════════════════════════════════════════════════════════════
# START
# ═══════════════════════════════════════════════════════════════════════════════
Write-Banner "EvEJS Web Client setup"

if ($Status) {
  Write-Info "Status mode: reporting only, nothing will be changed."
  Write-Host ""
}

# ── 1. Find the EvEJS server repo ────────────────────────────────────────────
$eveRootResolved = ""
$candidates = @()
if ($EveRoot) { $candidates += $EveRoot }
$existingWebEnv = Read-EnvFile $WebEnvPath
if ($existingWebEnv.ContainsKey("EVEJS_ROOT")) { $candidates += $existingWebEnv["EVEJS_ROOT"] }
$candidates += (Join-Path (Split-Path $RepoRoot -Parent) "eve.js")

foreach ($candidate in $candidates) {
  if ($candidate -and (Test-Path (Join-Path $candidate "compose.yaml"))) {
    $eveRootResolved = (Resolve-Path $candidate).Path
    break
  }
}

if (-not $eveRootResolved) {
  Write-Problem "EvEJS server folder not found" "looked next to this folder for eve.js"
  Write-Advice @(
    "This setup needs the EvEJS server folder -- the one containing compose.yaml",
    "and StartServer.bat. Normally it sits beside this folder, for example:",
    "",
    "    C:\...\GitHub\eve.js              <- the server",
    "    C:\...\GitHub\evejs-web-poc       <- this browser client",
    "",
    "If yours is somewhere else, run:",
    "",
    "    SetupWebClient.bat -EveRoot ""C:\path\to\eve.js"""
  )
  exit 1
}
Write-Ok "Found the EvEJS server folder" $eveRootResolved
$eveEnvPath = Join-Path $eveRootResolved ".env"

# ── 2. Work out how the SERVER is running ────────────────────────────────────
$dockerReady = Test-DockerReady
$eveDockerState = Get-EveJsDockerState
$gatewayUp = Test-GatewayPort

$serverMode = "unknown"
if ($eveDockerState -eq "running") {
  $serverMode = "docker"
  Write-Ok "Your EvEJS server is running in Docker" "container evejs-server-1"
} elseif ($gatewayUp) {
  $serverMode = "native"
  Write-Ok "Your EvEJS server is running directly on this PC" "answering on port 26002"
} else {
  Write-Problem "Your EvEJS server does not look like it is running" "nothing answered on port 26002"
  Write-Info "That is fine -- setup can finish now and you can start it afterwards."
}

# ── 3. Work out how the CLIENT should run ────────────────────────────────────
$nodePath = Get-CommandPath @("node")
$clientMode = $Mode

if ($clientMode -eq "auto") {
  # -Status must not ask anything: it is the "tell me where I stand" mode, and a
  # question there reads as if the answer is about to change something.
  if ($NonInteractive -or $Status) {
    if ($nodePath) { $clientMode = "native" } else { $clientMode = "docker" }
  } else {
    $options = @(
      "Directly on this PC  (needs Node.js -- fastest, easiest to look at logs)",
      "In Docker            (needs Docker Desktop -- nothing else to install)"
    )
    $default = 0
    if (-not $nodePath -and $dockerReady) { $default = 1 }
    $picked = Read-Choice "How should the browser client itself run?" $options $default
    if ($picked -eq 1) { $clientMode = "docker" } else { $clientMode = "native" }
  }
}

if ($clientMode -eq "native" -and -not $nodePath) {
  Write-Problem "Node.js is not installed" "needed to run the client directly on this PC"
  Write-Advice @(
    "Either install Node.js LTS from https://nodejs.org and run this again,",
    "or re-run and choose the Docker option instead:",
    "",
    "    SetupWebClient.bat -Mode docker"
  )
  exit 1
}
if ($clientMode -eq "docker" -and -not $dockerReady) {
  Write-Problem "Docker is not ready" "Docker Desktop must be running, in Linux containers mode"
  Write-Advice @(
    "Start Docker Desktop, wait for it to say it is running, then try again.",
    "Or run the client directly on this PC instead:",
    "",
    "    SetupWebClient.bat -Mode native"
  )
  exit 1
}
Write-Ok "The browser client will run" $(if ($clientMode -eq "docker") { "in Docker" } else { "directly on this PC" })

# ── 4. The shared secret ─────────────────────────────────────────────────────
#
# Needed only when the SERVER is in Docker. Written in every case anyway: it is
# harmless when unused (EvEJS ignores a token it has not been given itself), and
# writing it unconditionally means moving the server into Docker later does not
# silently break the client.
#
# The SERVER's token wins. Mirroring it into the client -- rather than minting a
# new one and pushing it to the server -- is what keeps this re-runnable without
# forcing a server restart every time.
$eveEnv = Read-EnvFile $eveEnvPath
$webEnv = Read-EnvFile $WebEnvPath
$eveToken = ""
$webToken = ""
if ($eveEnv.ContainsKey("EVEJS_WEB_GATEWAY_TOKEN")) { $eveToken = $eveEnv["EVEJS_WEB_GATEWAY_TOKEN"] }
if ($webEnv.ContainsKey("EVEJS_WEB_GATEWAY_TOKEN")) { $webToken = $webEnv["EVEJS_WEB_GATEWAY_TOKEN"] }

$token = ""
$tokenIsNew = $false
if ($eveToken) {
  $token = $eveToken
} elseif ($webToken) {
  $token = $webToken
} else {
  $token = New-SharedToken
  $tokenIsNew = $true
}

$serverNeedsRestart = ($serverMode -eq "docker" -and $eveToken -ne $token)

if ($Status) {
  if ($eveToken -eq $token -and $webToken -eq $token) {
    Write-Ok "Connection key already matches on both sides"
  } else {
    Write-Problem "Connection key would be written to both sides" "server and client must share it"
  }
} else {
  $eveHeader = "# EvEJS server settings. Written by the web client's SetupWebClient.bat."
  $webHeader = "# EvEJS web client settings. Written by SetupWebClient.bat."
  Set-EnvValue $eveEnvPath "EVEJS_WEB_GATEWAY_TOKEN" $token $eveHeader
  Set-EnvValue $WebEnvPath "EVEJS_WEB_GATEWAY_TOKEN" $token $webHeader
  Set-EnvValue $WebEnvPath "EVEJS_ROOT" $eveRootResolved $webHeader
  Set-EnvValue $WebEnvPath "EVEJS_WEB_MODE" $clientMode $webHeader

  if ($tokenIsNew) {
    Write-Changed "Created a connection key and gave it to both sides" "saved in .env in each folder"
  } else {
    Write-Ok "Connection key is in place on both sides"
  }
}

if ($Status) {
  Write-Host ""
  Write-Info "Status mode finished. Nothing was changed."
  exit 0
}

# ── 5. Install what the chosen mode needs ────────────────────────────────────
Push-Location $RepoRoot
try {
  if ($clientMode -eq "native") {
    $packageLock = Get-Item (Join-Path $RepoRoot "package-lock.json")
    if (-not (Test-Path (Join-Path $RepoRoot "node_modules\dds-ktx-parser\package.json"))) {
      Write-Info "Installing the client's packages..."
      & npm install
      if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
      Write-Changed "Installed the client's packages"
    } else {
      Write-Ok "Client packages already installed"
    }

    $webIndex = Get-Item (Join-Path $RepoRoot "public\dist\index.html") -ErrorAction SilentlyContinue
    if (-not $webIndex -or $webIndex.LastWriteTimeUtc -lt $packageLock.LastWriteTimeUtc) {
      Write-Info "Building the web page..."
      & npm run build:web
      if ($LASTEXITCODE -ne 0) { throw "Building the web page failed." }
      Write-Changed "Built the web page"
    } else {
      Write-Ok "Web page already built"
    }
  } else {
    Write-Info "Building the client's Docker image (first time takes a few minutes)..."
    if ($serverMode -eq "docker") {
      & docker compose -f $ComposeBase -f $ComposeOverlay build
    } else {
      & docker compose -f $ComposeBase build
    }
    if ($LASTEXITCODE -ne 0) { throw "Building the Docker image failed." }
    Write-Changed "Built the client's Docker image"
  }

  # Both the native client and the container can use the same local WASM encoder.
  $assetCache = Join-Path $RepoRoot "_local\client-assets"
  try {
    & (Join-Path $PSScriptRoot "Install-KtxEncoder.ps1") -CacheRoot $assetCache
  } catch {
    Write-Problem "The optional hull texture encoder could not be installed" "Brotli DDS is available"
  }
  # Existing /fly extracts get the same compressed variants as new extracts.
  if (Test-Path -LiteralPath $assetCache) {
    Write-Info "Preparing compressed flight assets. The first pass can take several minutes..."
    if ($clientMode -eq "native") {
      & node tools/client-extract/compress-cache.cjs
    } elseif ($serverMode -eq "docker") {
      & docker compose -f $ComposeBase -f $ComposeOverlay run --rm --no-deps bff node tools/client-extract/compress-cache.cjs
    } else {
      & docker compose -f $ComposeBase run --rm --no-deps bff node tools/client-extract/compress-cache.cjs
    }
    if ($LASTEXITCODE -eq 0) {
      Write-Ok "Flight assets prepared"
    } else {
      Write-Problem "Some flight assets could not be compressed" "the original extracted files are still available"
    }
  }

  # ── 6. Restart the server container if it is running without the key ───────
  if ($serverNeedsRestart) {
    Write-Host ""
    Write-Info "Your EvEJS server is running in Docker and does not have the"
    Write-Info "connection key yet. It needs a restart to pick it up."
    Write-Info "Anyone playing right now will be disconnected for a minute or two."

    # Unattended runs never restart a live game server. -NonInteractive is a
    # flag someone passes to automate setup, not permission to kick players off
    # a server that is up and serving.
    $doRestart = $false
    if ($NonInteractive) {
      Write-Skipped "EvEJS server not restarted" "-NonInteractive will not disconnect players"
    } else {
      $doRestart = Read-YesNo "Restart the EvEJS server container now?" $true
    }

    if ($doRestart) {
      Push-Location $eveRootResolved
      try {
        # --no-deps restarts ONLY the game server. Without it compose also
        # recreates the market container, which re-binds its published port and
        # fails outright on a machine that is also running a native market
        # daemon -- a restart far heavier than "pick up one new variable".
        & docker compose up --detach --no-deps server
        if ($LASTEXITCODE -ne 0) { throw "Restarting the EvEJS server container failed." }
      } finally {
        Pop-Location
      }
      Write-Changed "Restarted the EvEJS server" "it can take a minute or two to finish loading"
    } elseif (-not $NonInteractive) {
      Write-Skipped "EvEJS server not restarted" "the client will be refused until you restart it"
    }

    if (-not $doRestart) {
      Write-Advice @(
        "When you are ready, restart the server from the eve.js folder:",
        "",
        "    docker compose up --detach --no-deps server"
      )
    }
  }

  # ── 7. Start the client ────────────────────────────────────────────────────
  if ($NoStart) {
    Write-Skipped "Not starting the client" "-NoStart was given"
  } elseif ($clientMode -eq "docker") {
    if ($serverMode -eq "docker") {
      & docker compose -f $ComposeBase -f $ComposeOverlay up --detach
    } else {
      & docker compose -f $ComposeBase up --detach
    }
    if ($LASTEXITCODE -ne 0) { throw "Starting the client container failed." }
    Write-Changed "Started the browser client in Docker"
  } else {
    Write-Info "Starting the browser client in a new window..."
    Start-Process -FilePath "cmd.exe" `
      -ArgumentList "/k", "cd /d ""$RepoRoot"" && npm start" `
      -WorkingDirectory $RepoRoot | Out-Null
    Write-Changed "Started the browser client" "it runs in its own window -- closing that window stops it"
  }

  # ── 8. Check it actually connected ─────────────────────────────────────────
  if (-not $NoStart) {
    Write-Host ""
    Write-Info "Checking the connection..."
    Start-Sleep -Seconds 6

    $doctorOutput = ""
    $doctorExit = 1
    if ($clientMode -eq "docker") {
      if ($serverMode -eq "docker") {
        $doctorOutput = & docker compose -f $ComposeBase -f $ComposeOverlay exec -T bff node scripts/doctor.js 2>&1 | Out-String
      } else {
        $doctorOutput = & docker compose -f $ComposeBase exec -T bff node scripts/doctor.js 2>&1 | Out-String
      }
      $doctorExit = $LASTEXITCODE
    } else {
      $doctorOutput = & npm run doctor --silent 2>&1 | Out-String
      $doctorExit = $LASTEXITCODE
    }

    Write-Host ""
    if ($doctorExit -eq 0) {
      Write-Banner "Ready"
      Write-Host "  Open this in your browser:" -ForegroundColor Green
      Write-Host ""
      Write-Host "      $ClientUrl" -ForegroundColor White
      Write-Host ""
      Write-Info "Sign in with an EvEJS account name. Any password works."
      Write-Host ""
      Write-Info "To check the connection again at any time:  npm run doctor"
    } else {
      Write-Banner "Not connected yet"
      if ($serverMode -eq "unknown") {
        Write-Advice @(
          "Your EvEJS server was not running when setup checked.",
          "Start it, then run this again -- or just run:  npm run doctor",
          "",
          "  Server in Docker:  docker compose up --detach   (in the eve.js folder)",
          "  Server on this PC: StartServer.bat              (in the eve.js folder)"
        )
      } else {
        Write-Advice @(
          "The client is set up, but could not reach the server yet. If you just",
          "restarted the server it may still be loading -- wait a minute and run:",
          "",
          "    npm run doctor",
          "",
          "That check names exactly what is wrong. Full details of the four",
          "server/client combinations are in README.md under ""Docker (optional)""."
        )
      }
      Write-Host "  ---- connection check output ----" -ForegroundColor DarkGray
      Write-Host $doctorOutput -ForegroundColor DarkGray
      exit 1
    }
  } else {
    Write-Banner "Setup finished"
    Write-Info "Start the client with StartWebClient.bat, then open $ClientUrl"
  }
} finally {
  Pop-Location
}

exit 0
