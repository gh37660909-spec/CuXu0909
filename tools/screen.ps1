param(
  [Parameter(Mandatory = $true)][string]$Out
)

# Capture the primary screen to a PNG file.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output "saved:$Out"
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
