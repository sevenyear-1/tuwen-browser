Set WshShell = CreateObject("WScript.Shell")
scriptPath = WScript.ScriptFullName
projectDir = Left(scriptPath, InStrRev(scriptPath, "\") - 1)

' Single-instance guard: if a server is already listening on 8080-8089, just open the browser.
Function PortAlive(port)
  On Error Resume Next
  Set req = CreateObject("WinHttp.WinHttpRequest.5.1")
  req.SetTimeouts 1000, 1000, 1000, 1000
  req.Open "GET", "http://127.0.0.1:" & port & "/", False
  req.Send
  PortAlive = (Err.Number = 0)
  On Error GoTo 0
End Function

Dim livePort, p
livePort = 0
For p = 8080 To 8089
  If PortAlive(p) Then livePort = p: Exit For
Next

If livePort > 0 Then
  WshShell.Run "http://127.0.0.1:" & livePort & "/index.html", 1, False
Else
  WshShell.Run "cmd.exe /c cd /d """ & projectDir & """ && node server.js", 0, False
  WScript.Sleep 1500
  WshShell.Run "http://127.0.0.1:8080/index.html", 1, False
End If
