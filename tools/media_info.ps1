param(
  [Parameter(Mandatory = $true)][string]$Path
)

# Report media metadata through the Windows shell property store.
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Path)) {
  [Console]::Error.WriteLine("文件不存在：$Path")
  exit 1
}
$full = (Resolve-Path -LiteralPath $Path).Path
$item = Get-Item -LiteralPath $full
$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace($item.DirectoryName)
$entry = $folder.ParseName($item.Name)

function Get-Prop($name) {
  try { return $entry.ExtendedProperty($name) } catch { return $null }
}

$duration = Get-Prop 'System.Media.Duration'
$result = [ordered]@{
  path = $full
  name = $item.Name
  bytes = $item.Length
  durationTicks = if ($duration) { [int64]$duration } else { 0 }
  width = Get-Prop 'System.Video.FrameWidth'
  height = Get-Prop 'System.Video.FrameHeight'
  bitrate = Get-Prop 'System.Video.TotalBitrate'
  title = Get-Prop 'System.Title'
}
$result | ConvertTo-Json -Compress
