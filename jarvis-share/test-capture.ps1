$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$x=$b.X; $y=$b.Y; $w=$b.Width; $hgt=$b.Height
$bmp=New-Object System.Drawing.Bitmap $w,$hgt
$g=[System.Drawing.Graphics]::FromImage($bmp)
try { $g.CopyFromScreen($x,$y,0,0,$bmp.Size) } finally { $g.Dispose() }
$file="C:\Users\flowi\AppData\Local\Temp\jarvis-test-capture.png"
$bmp.Save($file,[System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$g.Dispose()
@{ok=$true; w=$w; h=$hgt} | ConvertTo-Json -Compress