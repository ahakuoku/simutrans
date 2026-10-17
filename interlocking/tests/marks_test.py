#!/usr/bin/env python3
"""
Magnets and memos (マグネット・メモ) (scenario il-tandem).

  1. a magnet "out of use" (使用停止) on a track tile: no route over it; on a signal: its lever cannot be turned;
     on a point: the point cannot be thrown
  2. tags and memos only show; they keep their text, company and month
  3. removed again: the route can be set
  4. the map is turned: they turn with it; saved and loaded: they are kept

Usage: marks_test.py --sim build/default/sim --workdir <dir>
"""
import argparse, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run_test import Panel, check, start_game, wait_until, simple_tool_id, PORT


def run(args):
    game = start_game(args, ["-scenario", "il-tandem"])
    try:
        p = Panel(PORT)
        wait_until(lambda: any(s["pos"] == [3, 5, 0] for s in p.request("signals 0 0 15 15")["signals"]), 60, "layout")
        time.sleep(2)
        check(p.cmd("st_new,T")["ok"], "station")
        sid = p.status()["stations"][0]["id"]
        check(p.cmd(f"sig_add,{sid},3,5,0")["ok"] and p.cmd(f"st_mode,{sid},1")["ok"], "S1, operator mode")
        home = ";".join(f"{x}:5:0" for x in range(3, 9))
        check(p.cmd(f"rt_path,{sid},{home},home")["ok"], "route S1 -> platform 1")
        rid = p.status()["routes"][0]["id"]
        marks = lambda: p.status()["stations"][0]["marks"]

        print("[1] out of use (使用停止)")
        check(p.cmd(f"mk_add,{sid},5,5,0,X,0")["ok"], "magnet on the track at (5,5)")
        r = p.cmd(f"set,{rid}")
        check(not r["ok"] and r["error"] == "out of use (magnet)", f"no route over it ({r.get('error')})")
        r = p.cmd(f"pt_set,{sid},4:5:0/R/2-4")
        check(r["ok"], f"the point at (4,5) can still be thrown ({r.get('error')})")
        check(p.cmd(f"pt_set,{sid},4:5:0//")["ok"], "back to automatic")
        check(p.cmd(f"mk_add,{sid},4,5,0,X,0")["ok"], "magnet on the point at (4,5)")
        r = p.cmd(f"pt_set,{sid},4:5:0/R/2-4")
        check(not r["ok"] and r["error"] == "out of use (magnet)", f"the point cannot be thrown ({r.get('error')})")
        check(p.cmd(f"st_cfg,{sid},1,0,5,3,2")["ok"], "relay interlocking")
        check(p.cmd(f"mk_add,{sid},3,5,0,X,0")["ok"], "magnet on S1")
        r = p.cmd(f"sl_turn,{sid},3,5,0,R")
        check(not r["ok"] and r["error"] == "out of use (magnet)", f"the lever of S1 cannot be turned ({r.get('error')})")
        check(p.cmd(f"st_cfg,{sid},0,0,5,3,2")["ok"], "electronic again")

        print("[2] tags and memos")
        check(p.cmd(f"mk_add,{sid},6,5,0,M,1,%E5%9B%9E%E9%80%81")["ok"], "tag 回送")
        check(p.cmd(f"mk_add,{sid},7,5,0,O,0,%E7%82%B9%E6%A4%9C%E4%B8%AD%2C%20%E6%B3%A8%E6%84%8F")["ok"], "memo (with a comma in its text)")
        check(not p.cmd(f"mk_add,{sid},7,5,0,Q,0")["ok"], "an unknown kind is refused")
        ms = marks()
        tag = next(m for m in ms if m["k"] == "M")
        memo = next(m for m in ms if m["k"] == "O")
        check(len(ms) == 5 and tag["s"] == "%E5%9B%9E%E9%80%81" and tag["c"] == 1 and tag["pos"] == [6, 5, 0], f"tag kept: {tag}")
        check(memo["s"] == "%E7%82%B9%E6%A4%9C%E4%B8%AD%2C%20%E6%B3%A8%E6%84%8F" and memo["m"] > 0, f"memo kept with its month: {memo}")

        print("[3] removed")
        for m in ms:
            if m["k"] == "X":
                check(p.cmd(f"mk_del,{sid},{m['id']}")["ok"], f"magnet at {m['pos']} removed")
        check(not p.cmd(f"mk_del,{sid},9999")["ok"], "an unknown magnet cannot be removed")
        r = p.cmd(f"set,{rid}")
        check(r["ok"], f"the route can be set again ({r.get('error')})")
        check(p.cmd(f"cancel,{rid}")["ok"], "cancelled")

        print("[4] turned with the map, kept in the savegame")
        before = marks()
        rot = simple_tool_id("TOOL_ROTATE90")
        p.request(f"debug_tool {rot} ")
        p.wait_event(lambda e: e["type"] == "rotated", 30)
        check([m["pos"] for m in marks()] != [m["pos"] for m in before], "the magnets turn with the map")
        for _ in range(3):
            p.request(f"debug_tool {rot} ")
            p.wait_event(lambda e: e["type"] == "rotated", 30)
        check(marks() == before, "four rotations restore them")
        p.request("debug_save il_marks")
        time.sleep(2)
    finally:
        game.terminate()
        try:
            game.wait(10)
        except subprocess.TimeoutExpired:
            game.kill()
    time.sleep(1)
    game = start_game(args, ["-load", "il_marks"])
    try:
        p = Panel(PORT)
        loaded = wait_until(lambda: (lambda s: s if s["stations"] else None)(p.status()), 60, "loaded")
        check(loaded["stations"][0]["marks"] == before, "magnets and memos restored from the savegame")
        check(loaded.get("date") and loaded.get("month", 0) > 0, f"the game date for the clock: {loaded.get('date')}")
    finally:
        game.terminate()
        try:
            game.wait(10)
        except subprocess.TimeoutExpired:
            game.kill()
    print("MARKS TEST DONE")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim", required=True)
    ap.add_argument("--workdir", required=True)
    try:
        run(ap.parse_args())
    except AssertionError as e:
        print("TEST FAILED:", e)
        sys.exit(1)
