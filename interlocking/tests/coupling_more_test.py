#!/usr/bin/env python3
"""
More coupling cases (scenario il-coupling, no change in the OTRP core).

--case mid: uncoupling at a station on the way (line y=12). A waits for coupling at C, B couples with the
  pink lever of S2. Both go on to P (same next stop); there the next stops differ (A: R, B: Q), so OTRP
  uncouples them when they leave P. A leaves first with the departure route from the virtual departure
  signal of P (8,12); B, left behind on the platform, then leaves with a departure route of its own.

--case depart: the child leaves a platform to couple (line y=5). A waits for coupling in the siding stop;
  B stops on platform 1 first. The departure point of platform 1 (8,5) gets a pink lever; B must not leave
  the platform without a route, the signal lever cannot lead up to A, the pink lever can, and B couples.

Usage: coupling_more_test.py --sim build/default/sim --workdir <dir> --case mid|depart [--relay]
"""
import argparse, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run_test import Panel, check, start_game, wait_until, simple_tool_id, PORT

E = "0,0,0,0,0,100,0,0"  # the rest of a schedule entry after x,y,z,min_load,waiting_time_shift,stop_flags


def entry(x, y, flags=0):
    return f"{x},{y},0,0,0,{flags},{E}|"


def run(args):
    game = start_game(args, ["-scenario", "il-coupling"])
    try:
        p = Panel(PORT)
        wait_until(lambda: any(s["pos"] == [2, 12, 0] for s in p.request("signals 0 0 15 15")["signals"]), 60, "layout")
        conv = lambda cid: next((c for c in p.request("debug_convoys")["convoys"] if c["id"] == cid), None)
        pos = lambda cid: tuple(conv(cid)["pos"])
        coupled = lambda a, b: conv(a).get("coupled_to") == b or conv(b).get("coupled_to") == a
        time.sleep(2)  # the scenario turns the signals until they face east
        line = 12 if args.case == "mid" else 5
        depot = (1, line, 0)
        ids = [c["id"] for c in p.request("debug_convoys")["convoys"] if tuple(c["pos"]) == depot]
        ca, cb = ids[0], ids[1]
        sig = "2,12,0" if args.case == "mid" else "3,5,0"
        p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_ROADSIGN')} {sig},1,s")
        check(p.cmd("st_new,T")["ok"], "station")
        sid = p.status()["stations"][0]["id"]
        check(p.cmd(f"sig_add,{sid},{sig}")["ok"], f"signal {sig} (choose signal, guide on)")
        check(p.cmd(f"st_mode,{sid},1")["ok"], "operator mode")
        if args.relay:
            check(p.cmd(f"st_cfg,{sid},1,0,5,3,2")["ok"], "relay interlocking")

        def set_route(at, tiles, name, sh=False):
            cmd = "set_path_s" if sh and not args.relay else "set_path"
            r = {"ok": False, "error": "no lever side"}
            for side in (("R", "L") if args.relay else ("",)):
                if args.relay:
                    p.cmd(f"sl_turn,{sid},{at},N")
                    p.cmd(f"sl_turn,{sid},{at},N,S")
                    if not p.cmd(f"sl_turn,{sid},{at},{side}" + (",S" if sh else ""))["ok"]:
                        continue
                r = p.cmd(f"{cmd},{sid},{tiles},{name}")
                if r["ok"]:
                    break
            return r

        def start(cid, sched):
            p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_CONVOI')} g,{cid},0|0|0|2|0|{sched}")
            time.sleep(1)
            p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_DEPOT')} b,{depot[0]},{depot[1]},0,{cid}")

        no_temp = lambda: not any(r for r in p.status()["routes"] if r.get("temp"))
        tiles = lambda xs, y=line: ";".join(f"{x}:{y}:0" for x in xs)

        if args.case == "mid":
            check(p.cmd(f"dep_add,{sid},8,12,0")["ok"], "virtual departure signal of P (east end)")
            check(p.cmd(f"lv_shunt,{sid},2,12,0,P")["ok"], "S2 gets a pink lever")
            print("[1] A waits for coupling at C, B couples with the pink lever")
            start(ca, entry(4, 12, 1) + entry(7, 12) + entry(14, 12))
            wait_until(lambda: pos(ca) == (2, 12, 0), 60, "A at S2")
            check(set_route("2,12,0", tiles(range(2, 5)), "A")["ok"], "route S2 -> C")
            wait_until(lambda: pos(ca) == (4, 12, 0) and conv(ca)["state"] == 7, 90, "A waits at C")
            start(cb, entry(4, 12, 2) + entry(7, 12) + entry(10, 12))
            wait_until(lambda: pos(cb) == (2, 12, 0), 60, "B at S2")
            check(set_route("2,12,0", tiles(range(2, 5)), "B", sh=True)["ok"], "pink route S2 -> C up to A")
            wait_until(lambda: coupled(ca, cb), 90, "coupled")
            check(True, "B coupled to A at C")

            print("[2] together to P (no signal in between), uncoupled when they leave P")
            wait_until(lambda: pos(ca) == (8, 12, 0) and conv(ca)["speed"] == 0, 120, "the coupled train at P")
            wait_until(no_temp, 60, "routes released")
            time.sleep(3)
            check(pos(ca) == (8, 12, 0), f"it waits at the virtual departure signal of P ({pos(ca)})")
            r = set_route("8,12,0", tiles(range(8, 15)), "A-out")
            check(r["ok"], f"departure route P -> R ({r.get('error')})")
            wait_until(lambda: pos(ca)[0] >= 13, 120, "A at R")
            check(not coupled(ca, cb), f"uncoupled: A {conv(ca)}, B {conv(cb)}")
            check(6 <= pos(cb)[0] <= 8, f"B was left on platform P ({pos(cb)})")
            wait_until(no_temp, 60, "route of A released")

            print("[3] B, left behind the virtual departure signal, leaves with its own route")
            time.sleep(3)
            check(6 <= pos(cb)[0] <= 8, f"B waits for its departure route ({pos(cb)})")
            r = set_route("8,12,0", tiles(range(8, 11)), "B-out")
            check(r["ok"], f"departure route P -> Q ({r.get('error')})")
            wait_until(lambda: pos(cb) == (10, 12, 0) and conv(cb)["speed"] == 0, 120, "B at Q")
            check(True, f"B arrived at Q ({pos(cb)})")
        else:
            check(p.cmd(f"dep_add,{sid},8,5,0")["ok"] and p.cmd(f"dep_add,{sid},12,9,0,S")["ok"], "virtual departure signal of platform 1 and of the siding stop")
            check(p.cmd(f"lv_shunt,{sid},8,5,0,P")["ok"], "the departure point of platform 1 gets a pink lever")
            into = tiles(range(8, 13)) + ";" + ";".join(f"12:{y}:0" for y in range(6, 10))
            print("[1] A waits for coupling in the siding stop")
            start(ca, entry(12, 9, 1) + entry(14, 5))
            wait_until(lambda: pos(ca) == (3, 5, 0), 60, "A at S1")
            check(set_route("3,5,0", tiles(range(3, 13)) + ";" + ";".join(f"12:{y}:0" for y in range(6, 10)), "A")["ok"], "route S1 -> siding stop")
            wait_until(lambda: pos(ca) == (12, 9, 0) and conv(ca)["state"] == 7, 120, "A waits in the siding stop")
            wait_until(no_temp, 60, "route released")

            print("[2] B stops on platform 1 first, then leaves it to couple")
            start(cb, entry(7, 5) + entry(12, 9, 2) + entry(14, 5))
            wait_until(lambda: pos(cb) == (3, 5, 0), 60, "B at S1")
            check(set_route("3,5,0", tiles(range(3, 9)), "B-in")["ok"], "home route S1 -> platform 1")
            wait_until(lambda: pos(cb) == (8, 5, 0) and conv(cb)["stop"] == 1, 120, "B served at platform 1")
            wait_until(no_temp, 60, "route released")
            time.sleep(6)
            check(pos(cb) == (8, 5, 0) and not coupled(ca, cb), f"B does not leave the platform without a route ({pos(cb)})")
            r = set_route("8,5,0", into, "B-sig")
            check(not r["ok"], f"the signal lever cannot lead up to A ({r.get('error')})")
            r = set_route("8,5,0", into, "B-out", sh=True)
            check(r["ok"], f"pink route platform 1 -> siding stop up to A ({r.get('error')})")
            wait_until(lambda: coupled(ca, cb), 90, "coupled")
            check(True, f"B coupled to A (A {pos(ca)}, B {pos(cb)})")
    finally:
        game.terminate()
        try:
            game.wait(10)
        except Exception:
            game.kill()
    print("COUPLING MORE TEST DONE")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim", required=True)
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--case", choices=["mid", "depart"], required=True)
    ap.add_argument("--relay", action="store_true")
    try:
        run(ap.parse_args())
    except AssertionError as e:
        print("TEST FAILED:", e)
        sys.exit(1)
