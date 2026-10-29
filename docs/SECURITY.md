# Security

StreamRoom is meant for friends on a home network or a private VPN. This page covers who it protects against, how, and what it doesn't protect against.

## Who could attack, and what they could want

| Who | Could they… | Answer |
|---|---|---|
| Someone else on your Wi-Fi (flatmate, guest, hostel network) | Join your call without the ID? | No: the ID is never broadcast or revealed, and guessing is rate-limited |
| | Knock the host's meeting over? | No: malformed requests are rejected, and every input has limits |
| | Read chat or see names? | **Only by sniffing network traffic.** Chat, names and IDs are not encrypted in transit |
| | Watch or listen to the call? | No by passive sniffing: audio and video are encrypted (DTLS-SRTP). An attacker who can actively intercept and modify traffic on the network could, because signaling isn't encrypted |
| A website you visit | Connect to a host on your network? | No: the host refuses connections from web pages |
| Someone in the call | Crash or flood the host? | No: limits on connections, streams, chat and message size |
| | Run code on your PC through names or chat? | No: all text is shown as plain text, under a strict content policy |
| Anyone who finds a public browser-version server | Use it for their own meetings? | Not with `ROOM_PASSWORD` set; `MAX_ROOMS` caps meetings anyway |

## Protections

### Meeting IDs
- **Never broadcast.** The joiner's broadcast is only `STREAMROOM2 ?` ("any hosts here?"). Hosts reply with just their port.
- **Only sent where the ID points.** The joiner asks `/info?code=…` only of a host whose address ends in the ID's octet. A fake host answering broadcasts from another address is never sent the ID.
- **Never revealed.** `/info` answers only `{ match: true | false }`.
- **Rate-limited guessing**, per IP: 10 wrong joins a minute (then even the right ID is refused for a while), 30 `/info` lookups a minute, 60 discovery queries a minute. With about 4.2 million possible random parts, that's years per device.

### The host's servers
- **Garbled requests** get `400 Bad Request`; nothing a stranger sends can throw an uncaught error in the host app.
- **Origin check:** websocket connections from a website origin (`http://…`, `https://…`) are refused.
- **Nothing works before joining:** every action except `join` is refused until you're in the meeting.
- **Resource limits:**

  | Limit | Value |
  |---|---|
  | People per meeting | 10 |
  | Transports per person | 2 (one send, one receive) |
  | Streams per person | one each of mic, camera, screen, screen sound, of the right kind |
  | Chat | 5 messages per 5 s, 1000 characters each |
  | Message size | 256 KB |
  | Meetings per server (browser version) | `MAX_ROOMS`, default 5 |
- **Input checks:** names are stripped of control characters and cut to 32 characters, meeting IDs are checked against a strict pattern, stream kinds must match their source, and malformed media parameters are rejected by mediasoup.

### Reconnect tokens
- 24 random bytes per person, compared in constant time.
- A forged or expired token just joins as a new person; it can't take over someone else's seat.
- If the same token connects twice, the newer connection replaces the older one.

### The app window
- Context isolation and the Chromium sandbox: the page has no access to Node.js or your files.
- The preload bridge exposes only: start/stop hosting, find a meeting, and the screen picker.
- Navigation away from the app's own page and new windows are blocked.
- Permissions are limited to camera, microphone, screen capture, clipboard write and fullscreen.
- A strict Content-Security-Policy: scripts and styles only from the app itself, no inline scripts, no plugins.
- Names and chat always rendered with `textContent`, never as HTML.

### The app binary
- Electron fuses turn off `RunAsNode`, the `NODE_OPTIONS` variable and `--inspect` debugging, so the app can't be repurposed as a general Node.js runtime.

### Browser version
- `ROOM_PASSWORD`: required on every join when set, compared via SHA-256 in constant time, wrong guesses count toward the rate limit.
- `MAX_ROOMS` caps meetings.
- Real certificates via `TLS_CERT`/`TLS_KEY`. Without them it makes a self-signed certificate, which is fine on a LAN but not for the internet.

### Firewall
- The installer adds inbound allow rules for `StreamRoom.exe` and `mediasoup-worker.exe` on all network profiles, because Windows often marks home Wi-Fi as Public.
- StreamRoom only listens while hosting. Avoid hosting on public Wi-Fi such as cafés.

### Dependencies
- `npm audit` reports no known vulnerabilities in runtime or development dependencies at the time of writing.
- There are no API keys, passwords or secrets in the code. The browser version's self-signed certificate is generated at runtime into `certs/`, which is git-ignored.

## Known limitations

| Limitation | Impact | Possible fix |
|---|---|---|
| Signaling (chat, names, IDs, reconnect tokens) is not encrypted | Readable by someone sniffing the network; an active man-in-the-middle could also swap media keys | TLS or an encrypted channel keyed from the meeting ID for signaling |
| The origin check also accepts `null` origins | A sandboxed frame on a website could connect, but would still need the meeting ID | Drop `null` once the app's own origin is confirmed to be `file://` |
| Firewall rules apply on public networks too | The host is reachable on café Wi-Fi while hosting | Make it a setting, or warn when hosting on a Public network |
| Not code-signed | SmartScreen warning on first run; users can't verify the publisher | Sign releases with a code-signing certificate |
| The 30-bit ID is meant for LANs | Fine with rate limits on a LAN; too short for open-internet discovery | Longer IDs for any future internet mode |

## Review history

A security review found three issues, all fixed with regression tests:

1. **A malformed request froze the host's app** (critical). One request such as `GET //[` from anyone on the network made the host stop answering, and its own call dropped. The request address is now parsed safely and garbled requests get `400`. *Test:* `security: a garbled request gets "400", and the host keeps working`.
2. **The meeting ID was broadcast in plain text** (high on shared networks). Anyone listening on the discovery port learned the ID when a friend joined. The broadcast now carries no ID, and the ID is only sent to the address it encodes. *Tests:* `someone listening to broadcasts never sees the meeting ID`, `a fake "host" answering broadcasts is never sent the ID`.
3. **The browser version had no meeting cap** (medium, public servers only). Anyone could start unlimited meetings. Fixed with `MAX_ROOMS` and `ROOM_PASSWORD`. *Tests:* `a public server caps how many meetings strangers can start`, `a server password is required for every join…`.

Earlier hardening (also covered by tests): `/info` no longer reveals the ID, ID lookups and joins are rate-limited, cross-site connections are refused, and the reconnect token is checked in constant time.

## Reporting a problem

Please open a GitHub issue. For anything that could let someone into other people's calls, describe it without a working exploit in the public issue, and ask for a private contact.
