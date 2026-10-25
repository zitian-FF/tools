# AI Girls watch face (Vivoactive 5)

A Connect IQ watch face for the vivoactive 5 (390x390 AMOLED): a character
portrait fills the centre, a thin battery ring circles it, and two short
curved blocks ride the rim, the white **hour** block and the accent-coloured
**minute** block, each with its number upright inside. No ticks, numerals or
hands. Built from the "AI Girls" design handoff (v2 portraits).

## Behaviour

- **Rotation (default):** the next girl appears each time the watch wakes
  from sleep (wrist raise, tap, or returning to the face), once per wake.
  Order: Gemma, G.P. Tee, Claudia, D. Seeker, Myuse, Roxxy, Kimi, Cid, then
  wrap. Switching is instant (no crossfade, by choice).
- The girl is remembered across restarts; first install starts on Gemma.
- **Asleep (always-on display):** no portrait or colour; outlined blocks, grey
  digits and a thin battery arc on black, shifted a couple of pixels each
  minute against burn-in. About 2-3% of pixels lit.
- **Battery:** one full clockwise circuit from 12 is 100%, icon at 12.
- **Time:** hour block position moves continuously (12-hour dial), minute block
  at the minute. Digits follow the watch's 12/24-hour setting. Blocks that
  would overlap (12:00, 1:05, ...) sit side by side, keeping their order.

Settings (Garmin Connect app > the face > Settings): rotation mode (next on
wake / cycle every 3-5-10 s while awake / fixed), remember last girl,
starting or fixed girl, and a show/hide switch per girl.

## Platform limits found on this watch

- No crossfade is possible: the vivoactive 5 cannot draw a bitmap
  semi-transparently (`setBlendMode`, `drawScaledBitmap` and vector fonts
  are vivoactive 6 and later).
- The watch does not say why it woke, so a return from an app or a screen
  tap advances the girl just like a wrist raise. Never more than once per
  wake.
- If the face is restarted while asleep, the next wake does not advance
  (nothing armed it); the committed girl is kept.
- If always-on display is off, the screen simply turns off when asleep.

## Build

Portraits are not committed (this repo is published by GitHub Pages).
Generate them from the handoff folder first:

```
python3 tools/make_resources.py <path>/claude-handoff
monkeyc -d vivoactive5 -f monkey.jungle -o AiGirls.prg -y <developer_key.der> -r
```

Install: copy `AiGirls.prg` to the watch's `GARMIN\APPS` folder over USB, then
pick "AI Girls" as the watch face on the watch.

Digits use Barlow Condensed Bold (SIL Open Font License, `tools/fonts/`)
rendered to bitmap fonts, so the face needs no device system fonts.

## Tests

- Rotation logic unit tests (`source/RotationTests.mc`): build with `-t`,
  run `monkeydo AiGirls.prg vivoactive5 -t`.
- Screenshots of pinned states (times, battery levels, girls, always-on) with
  lit-pixel and memory numbers: `tools/screenshots.py` (see its docstring).

Verified in the Connect IQ 9.3.0 simulator: 7/7 unit tests pass; times 00:00,
01:05, 10:10, 12:00, 18:30 (24h), 23:59 (24h), 07:42, 03:17 render with no
overlaps; battery 0, 1, 25, 50, 64, 75, 88, 100% render correctly; live
display-mode switching advanced Gemma, G.P. Tee, Claudia, D. Seeker one per
wake and a relaunch resumed D. Seeker; always-on 2.1-3.1% lit; memory about
13.8 KB of 124 KB awake (portraits live in the separate graphics pool). Not
yet run on a physical watch.
