param(
  [Parameter(Mandatory = $true)][string]$Spec
)

# Create a .wps / .doc document through WPS Writer COM.
$ErrorActionPreference = 'Stop'

$json = Get-Content -LiteralPath $Spec -Raw -Encoding UTF8 | ConvertFrom-Json
$out = [string]$json.path
if ([string]::IsNullOrWhiteSpace($out)) {
  [Console]::Error.WriteLine('缺少输出路径')
  exit 1
}
$dir = Split-Path -Parent $out
if ($dir -and -not (Test-Path -LiteralPath $dir)) {
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

$lines = New-Object System.Collections.Generic.List[string]
if ($json.title) { $lines.Add([string]$json.title) }
if ($json.blocks) {
  foreach ($block in $json.blocks) {
    if ($block.text) { $lines.Add([string]$block.text) }
  }
}
if ($json.text) { $lines.Add([string]$json.text) }

$app = $null
$doc = $null
try {
  $app = New-Object -ComObject KWPS.Application
  $app.Visible = $false
  $doc = $app.Documents.Add()
  $doc.Content.Text = ($lines -join "`r`n")
  $doc.SaveAs2($out, 0)
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output "created:$out"
} catch {
  [Console]::Error.WriteLine("WPS 创建失败：$($_.Exception.Message)")
  exit 1
} finally {
  if ($doc) { try { $doc.Close() } catch { } }
  if ($app) { try { $app.Quit() } catch { } }
}
