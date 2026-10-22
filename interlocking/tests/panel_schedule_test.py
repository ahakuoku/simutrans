"""Run against a disposable game with TID_IL_DEBUG=1 and its MCP port enabled.

Example: python panel_schedule_test.py --port PORT --mcp-port MCP_PORT --seed X Y Z
The test opens/closes a convoy schedule, so never target a user's active game.
"""
import argparse
import json
from pathlib import Path
import subprocess
import socket
import sys
import time
import urllib.request

from run_test import simple_tool_id

args = argparse.ArgumentParser(description=__doc__)
args.add_argument("--port", type=int, required=True)
args.add_argument("--mcp-port", type=int, required=True)
args.add_argument("--seed", type=int, nargs=3, required=True)
args.add_argument("--convoy", type=int, default=1)
args = args.parse_args()
root = Path(__file__).resolve().parents[2]
helper = root / ".agents/skills/simutrans-mcp-gui-debug/scripts/mcp_client.py"
x, y, z = args.seed
url = f"http://127.0.0.1:{args.port}/api/network?x={x}&y={y}&z={z}"


def command(text):
    with socket.create_connection(("127.0.0.1", args.port), timeout=10) as sock:
        sock.sendall((text + "\n").encode())
        with sock.makefile("r", encoding="utf-8") as reader:
            for line in reader:
                response = json.loads(line)
                if response["type"] == "error":
                    raise AssertionError(response)
                if response["type"] == "debug_tool":
                    assert response["ok"], response
                    return
        raise AssertionError("disconnected before tool result")


def convoy():
    with urllib.request.urlopen(url, timeout=5) as response:
        data = json.load(response)
    return next((c for c in data["convoys"] if c["id"] == args.convoy), None)


def wait_for(predicate, description, timeout=120):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        c = convoy()
        if c and predicate(c):
            return c
        time.sleep(0.25)
    raise AssertionError("timeout: " + description)


def close_schedule():
    subprocess.run([sys.executable, str(helper), "--port", str(args.mcp_port),
                    "--run-squirrel", "gui.close_all_windows(); return true;"], check=True)


try:
    for loading in (False, True):
        before = wait_for(lambda c: c["loading"] == loading and c.get("service_from")
                          and c.get("service_to") and not c.get("schedule_editing")
                          and (loading or "eta_seconds" in c), "ready train")
        command(f"debug_tool {simple_tool_id('TOOL_CHANGE_CONVOI')} f,{args.convoy}")
        during = wait_for(lambda c: c.get("schedule_editing"), "schedule opened", 10)
        assert during["loading"] == loading, (before, during)
        assert during["service_from"] == before["service_from"], (before, during)
        assert during["service_to"] == before["service_to"], (before, during)
        assert during["occupied"], "occupancy disappeared while editing"
        if loading:
            assert "arrival_elapsed" in during
        else:
            assert "eta_seconds" in during
        close_schedule()
        after = wait_for(lambda c: not c.get("schedule_editing"), "schedule closed", 10)
        assert after["service_from"] == before["service_from"], (before, after)
        assert after["service_to"] == before["service_to"], (before, after)
        assert after["occupied"], "occupancy disappeared after editing"
        print("PASS:", "station dwell" if loading else "between stations",
              before["service_from"], "->", before["service_to"], flush=True)
finally:
    close_schedule()
