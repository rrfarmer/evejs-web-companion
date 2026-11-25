[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$CacheRoot)

$ErrorActionPreference = 'Stop'
$toolRoot = Join-Path $CacheRoot '.tools'
$version = '4.4.2'
$destination = Join-Path $toolRoot "libktx-$version"
if ((Test-Path (Join-Path $destination 'libktx.js')) -and
    (Test-Path (Join-Path $destination 'libktx.wasm'))) { return }

New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null
$scratch = Join-Path $toolRoot ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    $archive = Join-Path $scratch 'libktx.zip'
    $url = "https://github.com/KhronosGroup/KTX-Software/releases/download/v$version/KTX-Software-$version-Web-libktx.zip"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive -TimeoutSec 45
    $expected = '1d4598a290ccb654d6a33c074c4ca96f0c5ccef99e042323eaa4d1230d4de63d'
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) {
        throw 'KTX encoder archive checksum mismatch.'
    }
    $unpacked = Join-Path $scratch 'unpacked'
    Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
    if (-not (Test-Path (Join-Path $unpacked 'libktx.js')) -or -not (Test-Path (Join-Path $unpacked 'libktx.wasm'))) {
        throw 'KTX encoder files were missing from the release.'
    }
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Copy-Item -LiteralPath (Join-Path $unpacked 'libktx.wasm') -Destination $destination -Force
    Copy-Item -LiteralPath (Join-Path $unpacked 'libktx.js') -Destination $destination -Force
} finally {
    $resolvedScratch = (Resolve-Path -LiteralPath $scratch).Path
    $resolvedToolRoot = (Resolve-Path -LiteralPath $toolRoot).Path
    if ($resolvedScratch.StartsWith($resolvedToolRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
    }
}
