Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\OMEN\whatsapp-ghost-client"
WshShell.Run """C:\Program Files\nodejs\node.exe"" launcher.js", 0, False
