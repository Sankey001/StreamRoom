# Testing

```bash
npm test           # 40 unit and security tests, about 30 s
npm run test:e2e   # 12 end-to-end scenarios, about 2.5 minutes
```

Close any meeting you're hosting first: both suites use the app's real discovery ports (47800 and 47802).

## Unit and security tests (`test/unit/`)

Plain `node:test`, no framework. The SFU tests start a real mediasoup server on a random port and talk to it with socket.io clients, so every security check is an actual attempt, not a code inspection.

| File | Covers |
|---|---|
| `code.test.js` | Meeting IDs: alphabet, every octet round-trips, randomness, forgiving input (case, dashes, `O`/`0`, `I`/`L`/`1`), rejecting junk |
| `quality.test.js` | Auto quality: tiers by group size, data-saver ceiling, bitrate split, step-down/step-up hysteresis, the **720p cap on slow upload and for slow viewers** (from 1080p and 1440p), fps-before-resolution on a busy PC |
| `discovery.test.js` | Finding hosts; `/info` never revealing the ID; **garbled requests get 400 and the host keeps working**; **a listener never sees the ID**; **a fake host is never sent the ID**; joining by VPN address still needs the right ID |
| `sfu.test.js` | Room validation and the 10-person cap; **ID guessing rate-limited**; **meeting cap**; **server password**; **cross-site connections refused**; nothing works before joining; names sanitised, chat passed through as plain text; limits on transports, chat flood, bad streams and oversized messages; reconnect resume, forged tokens, grace expiry, duplicate connections; leaving; slow-viewer reports; ICE restart; "meeting ended" |

## End-to-end scenarios (`test/e2e/run.mjs`)

Starts three real StreamRoom app instances (a host and two friends) on one PC, with Chromium's fake camera, microphone and screen, and drives them over the DevTools protocol.

| # | Scenario | Checks |
|---|---|---|
| 1 | Host starts a meeting with one click | Gets a `XXX-XXX` ID |
| 2 | Wrong ID | Connecting screen shows, then a clear error; no sound plays outside a call |
| 3 | Two friends join (typed lowercase, no dash) | Everyone sees everyone; media flows |
| 4 | Auto quality for 3 people | Badge says 720p30; camera encoders capped at 30 fps |
| 5 | Wi-Fi blip (websocket killed) | Friend shown as *away*, reconnects with the same identity; the host never sees them leave; media flows again |
| 6 | Media path failure | ICE restart recovers without rejoining |
| 7 | A viewer reports slow internet | The sharer's screen drops to 720p (1080/720 downscale) and recovers when they're fine |
| 8 | A friend's app crashes | Others see *away*, then the friend is removed after the 20 s grace period |
| 9 | A friend leaves on purpose | Removed immediately |
| 10 | Host ends the meeting | Friends see *meeting ended*, with no **Try again** |
| 11 | Host's app crashes | The friend shows *Reconnecting*, then gives up with **Try again** |
| 12 | After giving up | **Back to start** returns to a clean start screen |

Set `TRACE=1` for step-by-step output. On failure, the last few lines of each app's own log are printed.

### Notes on the fake devices

- **Clicks** are sent as DOM clicks, not simulated mouse input, which can stall on a long-running Electron window.
- **Chromium's fake camera sometimes doesn't appear** on a PC (only the fake microphones do). The harness notices and then proves media flow with the microphones instead of cameras, rather than reporting a call bug. The run prints a note when that happens.
- **Real webcams and separate PCs are not covered** by the automated tests.

## Measured on one PC

Headless tests with three Chromes on one laptop, all encoding in software:

| Measurement | Result |
|---|---|
| Screen share relayed to viewers | 1920×1080 at 51–59 fps (single layer, H.264) |
| With three 1080p60 cameras also encoding on the same PC | Drops to 540p: CPU-bound, because one laptop is doing every participant's encoding |
| With 720p30 cameras | Screen stays at 1920×1080, 48–50 fps |
| 11th person joining | Refused: *Meeting is full* |

On real hardware Chrome usually uses the graphics card's H.264 encoder for the single-layer screen share, which holds 60 fps more easily.
