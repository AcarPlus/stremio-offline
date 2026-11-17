' Offline İndir servisini pencere açmadan başlatır (oturum açılışı kısayolu bunu çalıştırır).
' Servis zaten çalışıyorsa ikinci örnek sessizce çıkar. İsteğe bağlı 1. argüman: node.exe yolu.
' Hatalar data\baslatici.log dosyasına yazılır (node bulunamadı, servis açılışta çöktü...); sınama için OFFLINE_DATA_DIR okunur.
Option Explicit
Dim sh, fso, node, q, dataDir, logFile, root, dosya, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)
root = fso.GetParentFolderName(WScript.ScriptFullName)
dataDir = sh.Environment("Process")("OFFLINE_DATA_DIR")
If Len(dataDir) = 0 Then dataDir = root & "\data"
logFile = dataDir & "\baslatici.log"

Sub Gunluk(metin)
  On Error Resume Next
  If Not fso.FolderExists(dataDir) Then fso.CreateFolder dataDir
  If fso.FileExists(logFile) Then
    If fso.GetFile(logFile).Size > 1000000 Then fso.DeleteFile logFile
  End If
  Set dosya = fso.OpenTextFile(logFile, 8, True)
  dosya.WriteLine Now & " [baslat-servis.vbs] " & metin
  dosya.Close
End Sub

node = "node"
If WScript.Arguments.Count > 0 Then
  If Len(WScript.Arguments(0)) > 0 Then node = WScript.Arguments(0)
End If
sh.CurrentDirectory = root
' Mutlak yol verilmişse var mı diye bak (yoksa servis hiç açılmaz ve kimse bilmez)
If InStr(node, "\") > 0 Or InStr(node, ":") > 0 Then
  If Not fso.FileExists(node) Then
    Gunluk "node bulunamadi: " & node & " (servis baslatilamadi; kur.ps1 yeniden calistirilmali)"
    WScript.Quit 1
  End If
End If
' stdout atılır (servis kendi günlüğünü data\servis.log'a yazar); stderr (açılışta çökme, içe aktarma hatası,
' "node tanınmıyor") günlüğe eklenir. cmd /c "<node>" server.mjs >nul 2>>"<günlük>"
cmd = "cmd.exe /c " & q & q & node & q & " server.mjs >nul 2>>" & q & logFile & q & q
Gunluk "servis baslatiliyor: " & node
sh.Run cmd, 0, False
