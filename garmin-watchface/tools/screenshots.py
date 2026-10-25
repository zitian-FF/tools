#!/usr/bin/env python3
"""Render the face in the Connect IQ simulator for a list of pinned states.

Needs a running simulator (DISPLAY set) and:
    CIQ_SDK   path to the Connect IQ SDK
    CIQ_KEY   developer key (.der)
Usage:
    python3 screenshots.py OUT_DIR [case ...]
Each case is name=hour:minute:battery:girl:sleep:is24, e.g. 1010=10:10:80:0:0:0.
With no cases, the built-in set below is rendered. Writes OUT_DIR/<name>.png
(the 390x390 display, cropped; see CIQ_DISPLAY) and prints the lit-pixel
fraction of the round display for each.
"""
import os
import subprocess
import sys
import time

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
CASES = [
    "t0000=0:0:100:0:0:0", "t0105=1:5:75:1:0:0", "t1010=10:10:50:2:0:0",
    "t1200=12:0:25:3:0:0", "t1830=18:30:1:4:0:1", "t2359=23:59:0:5:0:1",
    "g6=7:42:64:6:0:0", "g7=3:17:88:7:0:0",
    "aod1010=10:10:50:0:1:0", "aod1200=12:0:80:0:1:0", "aod1830=18:30:100:0:1:1",
]


def hooks(hour, minute, battery, girl, sleep, is24):
    d = os.path.join(ROOT, "hooks", "screenshot")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "TestHooks.mc"), "w") as f:
        f.write(f"""import Toybox.Lang;
module TestHooks {{
    const ACTIVE = true;
    const HOUR = {hour};
    const MINUTE = {minute};
    const BATTERY = {float(battery)};
    const GIRL = {girl};
    const SLEEPING = {'true' if sleep else 'false'};
    const IS24 = {'true' if is24 else 'false'};
}}
""")


def main():
    out = sys.argv[1]
    cases = sys.argv[2:] or CASES
    os.makedirs(out, exist_ok=True)
    sdk, key = os.environ["CIQ_SDK"], os.environ["CIQ_KEY"]
    prg = os.path.join(out, "shot.prg")
    for case in cases:
        name, spec = case.split("=")
        hooks(*[int(v) for v in spec.split(":")])
        subprocess.run([f"{sdk}/bin/monkeyc", "-d", "vivoactive5",
                        "-f", f"{ROOT}/monkey.jungle;{ROOT}/screenshot.jungle",
                        "-o", prg, "-y", key], check=True, capture_output=True)
        log = open(os.path.join(out, name + ".log"), "w")
        subprocess.Popen([f"{sdk}/bin/monkeydo", prg, "vivoactive5"], stdout=log, stderr=log)
        time.sleep(16)
        raw = os.path.join(out, name + "-raw.png")
        subprocess.run(["import", "-window", "root", raw], check=True)
        yield_shot(raw, os.path.join(out, name + ".png"), name)


def yield_shot(raw, dest, name):
    # Where the simulator draws the 390x390 display inside its window (top
    # left corner); override with CIQ_DISPLAY=x,y if the window layout differs.
    x, y = (int(v) for v in os.environ.get("CIQ_DISPLAY", "98,264").split(","))
    face = Image.open(raw).convert("RGB").crop((x, y, x + 390, y + 390))
    face.save(dest)
    # Lit pixels inside the round display only.
    px = face.load()
    lit = total = 0
    for j in range(390):
        for i in range(390):
            if (i - 195) ** 2 + (j - 195) ** 2 <= 195 ** 2:
                total += 1
                lit += max(px[i, j]) > 24
    mem = [l.strip() for l in open(dest.replace(".png", ".log")) if l.startswith("memory")]
    print(f"{name}: lit {lit / total * 100:.1f}% of display; {mem[-1] if mem else 'no memory line'}")


if __name__ == "__main__":
    main()
