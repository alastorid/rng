$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PrivateKey = if ($args.Count -gt 0) { $args[0] } else { "" }

if (-not $PrivateKey) {
    throw 'Usage: ./check.ps1 "private key hex"'
}

$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) {
    throw "Node.js is required for check.ps1."
}

& $Node.Source (Join-Path $Root "tools\check.mjs") $PrivateKey
