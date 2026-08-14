Set WshShell = CreateObject("WScript.Shell")
scriptPath = WScript.ScriptFullName
projectDir = Left(scriptPath, InStrRev(scriptPath, "\") - 1)
WshShell.Run "cmd.exe /c cd /d """ & projectDir & """ && node server.js", 0, False
WScript.Sleep 1500
WshShell.Run "http://127.0.0.1:8080/index.html", 1, False