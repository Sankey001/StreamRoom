; Let friends reach the host without a Windows Firewall prompt on first use.
; StreamRoom only listens while someone is hosting a meeting, and joining needs the meeting ID.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="StreamRoom"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="StreamRoom media"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="StreamRoom" dir=in action=allow program="$INSTDIR\StreamRoom.exe" enable=yes profile=any'
  nsExec::Exec 'netsh advfirewall firewall add rule name="StreamRoom media" dir=in action=allow program="$INSTDIR\resources\app\node_modules\mediasoup\worker\out\Release\mediasoup-worker.exe" enable=yes profile=any'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="StreamRoom"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="StreamRoom media"'
!macroend
