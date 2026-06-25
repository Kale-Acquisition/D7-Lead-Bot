Set oShell = CreateObject("WScript.Shell")
oShell.CurrentDirectory = "d:\New Downloads\d7\d7"
oShell.Run "cmd /c npm start", 0, False
