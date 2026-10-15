#!/usr/bin/env python3
"""
Coupling on a platform, uncoupling and the departure of both parts (scenario il-coupling, no change in the OTRP core).

Platform 1 (6..8,5) has a virtual departure signal at its east end (8,5), the terminus B (13..14,5) one at its
west end (13,5); S1 is a choose signal with its guide setting (連結誘導) on. OTRP couples two trains only when
their next stops are the same, and uncouples them when they leave a stop after which their stops differ.
  1. parent A comes in with the signal lever and waits for coupling at the east end of platform 1
  2. child B comes in behind it with the pink calling-on lever (誘導) and couples
  3. the coupled train leaves with the departure route to the terminus B
  4. at B the next stops differ (A: platform 1, B: the siding stop): OTRP uncouples them; each part leaves
     with a departure route of its own (B, now in front, into the siding stop, then A to platform 1)

Usage: coupling_platform_test.py --sim build/default/sim --workdir <dir> [--relay]
"""
import argparse, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run_test import Panel, check, start_game, wait_until, simple_tool_id, PORT


def run(args):
    game = start_game(args, ["-scenario", "il-coupling"])
    try:
        p = Panel(PORT)
        wait_until(lambda: any(s["pos"] == [3, 5, 0] for s in p.request("signals 0 0 15 15")["signals"]), 60, "layout")
        convoys = p.request("debug_convoys")["convoys"]
        ca, cb = convoys[0]["id"], convoys[1]["id"]
        conv = lambda cid: next((c for c in p.request("debug_convoys")["convoys"] if c["id"] == cid), None)
        pos = lambda cid: tuple(conv(cid)["pos"])
        time.sleep(2)  # the scenario turns S1 until it faces east
        p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_ROADSIGN')} 3,5,0,1,s")
        check(p.cmd("st_new,T")["ok"], "station")
        sid = p.status()["stations"][0]["id"]
        check(p.cmd(f"sig_add,{sid},3,5,0")["ok"] and p.cmd(f"dep_add,{sid},8,5,0")["ok"], "S1 and the virtual departure signal of platform 1 (east end)")
        check(p.cmd(f"dep_add,{sid},13,5,0")["ok"], "the virtual departure signal of the terminus B (west end)")
        check(p.cmd(f"st_mode,{sid},1")["ok"], "operator mode")
        if args.relay:
            check(p.cmd(f"st_cfg,{sid},1,0,5,3,2")["ok"], "relay interlocking")
        check(p.cmd(f"lv_shunt,{sid},3,5,0,P")["ok"], "S1 gets a pink calling-on lever (誘導)")
        # entry: x,y,z,min_load,waiting_time_shift,stop_flags(1 = wait for coupling, 2 = try coupling),...
        parent = "0|0|0|2|0|7,5,0,0,0,1,0,0,0,0,0,100,0,0|14,5,0,0,0,0,0,0,0,0,0,100,0,0|7,5,0,0,0,0,0,0,0,0,0,100,0,0|"
        child = "0|0|0|2|0|7,5,0,0,0,2,0,0,0,0,0,100,0,0|14,5,0,0,0,0,0,0,0,0,0,100,0,0|12,9,0,0,0,0,0,0,0,0,0,100,0,0|"
        p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_CONVOI')} g,{ca},{parent}")
        p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_CONVOI')} g,{cb},{child}")
        home = ";".join(f"{x}:5:0" for x in range(3, 9))
        to_b = ";".join(f"{x}:5:0" for x in range(8, 14))
        to_siding = ";".join([f"{x}:5:0" for x in (13, 12)] + [f"12:{y}:0" for y in range(6, 10)])
        to_platform = ";".join(f"{x}:5:0" for x in range(13, 7, -1))

        def turn(at, sh=False):
            if not args.relay:
                return
            for side in ("R", "L"):
                p.cmd(f"sl_turn,{sid},{at},N")
                p.cmd(f"sl_turn,{sid},{at},N,S")
                r = p.cmd(f"sl_turn,{sid},{at},{side}" + (",S" if sh else ""))
                if r["ok"]:
                    return side
            check(False, f"lever at {at} turned ({r.get('error')})")

        def set_route(at, tiles, name, sh=False):
            turn(at, sh)
            cmd = "set_path_s" if sh and not args.relay else "set_path"
            r = p.cmd(f"{cmd},{sid},{tiles},{name}")
            if not r["ok"] and args.relay:
                # the lever was turned to the wrong side for this route: the other side
                p.cmd(f"sl_turn,{sid},{at},N" + (",S" if sh else ""))
                r = p.cmd(f"sl_turn,{sid},{at},L" + (",S" if sh else ""))
                r = p.cmd(f"{cmd},{sid},{tiles},{name}")
            return r

        print("[1] parent A onto platform 1, waits for coupling")
        time.sleep(1)
        p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_DEPOT')} b,1,5,0,{ca}")
        wait_until(lambda: pos(ca) == (3, 5, 0), 60, "A at S1")
        check(set_route("3,5,0", home, "A")["ok"], "home route S1 -> platform 1")
        wait_until(lambda: pos(ca) == (8, 5, 0) and conv(ca)["state"] == 7, 120, "A waits for coupling at the east end")
        check(True, f"A waits at {pos(ca)} (state {conv(ca)['state']})")

        print("[2] child B behind it with the calling-on lever")
        p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_DEPOT')} b,1,5,0,{cb}")
        wait_until(lambda: pos(cb) == (3, 5, 0), 60, "B at S1")
        time.sleep(2)
        check(pos(cb) == (3, 5, 0), "B waits at S1 (guide signal)")
        r = set_route("3,5,0", home, "B")
        check(not r["ok"], f"the signal lever cannot lead up to A ({r.get('error')})")
        r = set_route("3,5,0", home, "B", sh=True)
        check(r["ok"], f"calling-on lever: S1 -> platform 1 up to A ({r.get('error')})")
        trace = []
        def coupled():
            trace.append((pos(cb), conv(cb)["state"]))
            return conv(ca).get("coupled_to") or conv(cb).get("coupled_to")
        try:
            wait_until(coupled, 90, "coupled")
        except AssertionError:
            import json, urllib.request
            tiles = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/tracks?x1=0&y1=0&x2=15&y2=15").read())["tiles"]
            print("    trace of B:", sorted(set(trace)), "reserved:", sorted((tuple(t["p"]), t["c"]) for t in tiles if t.get("c")))
            print("    routes:", p.status()["routes"], "convoys:", p.request("debug_convoys")["convoys"])
            raise
        check(True, f"B coupled to A (A {pos(ca)}, B {pos(cb)})")

        print("[3] the coupled train leaves for the terminus B")
        time.sleep(3)
        check(pos(ca) == (8, 5, 0), f"A waits at the virtual departure signal ({pos(ca)})")
        r = set_route("8,5,0", to_b, "out")
        check(r["ok"], f"departure route platform 1 -> B ({r.get('error')})")
        wait_until(lambda: pos(ca)[0] >= 13 and pos(cb)[0] >= 13 and conv(ca)["speed"] == 0, 120, "the coupled train at B")
        wait_until(lambda: not any(r for r in p.status()["routes"] if r.get("temp")), 120, "route released")

        print("[4] uncoupled at B, each part leaves with its own departure route")
        wait_until(lambda: not conv(ca).get("coupled_to") and not conv(cb).get("coupled_to"), 120, "uncoupled")
        time.sleep(3)
        check(pos(ca)[0] >= 13 and pos(cb)[0] >= 13, f"uncoupled, both wait at B (A {pos(ca)}, B {pos(cb)})")
        r = set_route("13,5,0", to_siding, "B-out")
        check(r["ok"], f"departure route B -> the siding stop ({r.get('error')})")
        wait_until(lambda: pos(cb)[0] == 12 and pos(cb)[1] >= 6, 120, "B in the siding stop")
        check(pos(ca)[0] >= 13, f"B went into the siding stop, A still waits ({pos(ca)})")
        wait_until(lambda: not any(r for r in p.status()["routes"] if r.get("temp")), 120, "route released")
        r = set_route("13,5,0", to_platform, "A-out")
        check(r["ok"], f"departure route B -> platform 1 ({r.get('error')})")
        try:
            wait_until(lambda: pos(ca)[1] == 5 and 6 <= pos(ca)[0] <= 8 and conv(ca)["state"] == 7, 120, "A on platform 1")
        except AssertionError:
            print("    A:", conv(ca), "routes:", p.status()["routes"], "events:", p.events[-6:] if hasattr(p, "events") else "")
            raise
        check(True, f"A arrived on platform 1 ({pos(ca)})")
    finally:
        game.terminate()
        try:
            game.wait(10)
        except Exception:
            game.kill()
    print("COUPLING PLATFORM TEST DONE")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim", required=True)
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--relay", action="store_true")
    try:
        run(ap.parse_args())
    except AssertionError as e:
        print("TEST FAILED:", e)
        sys.exit(1)
