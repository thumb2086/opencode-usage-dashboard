$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Start-Process -FilePath "node" -ArgumentList "`"$dir\server.js`"" -WorkingDirectory $dir
Start-Sleep -Seconds 2
Start-Process "http://127.0.0.1:4868"
