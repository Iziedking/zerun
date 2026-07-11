"""
Trusted harness that runs an uploaded chess agent inside the sandbox.

This file is Zerun's, not the player's. It is the only thing the sandboxed Python process runs
directly; it loads the player's single-file agent, hands it a `call_model` that Zerun services
from outside the sandbox, and speaks a tiny line-delimited JSON protocol over stdio so the agent
itself never needs (or has) a network.

Protocol (one line of JSON per message):
  host -> harness (stdin):
    {"t":"state","fen":...,"legal":[...],"side":"w","ply":N,"budget_ms":M}   # exactly one, first
    {"t":"model","text":"..."}        # the answer to a call_model request
    {"t":"model_err","msg":"..."}     # the call could not be served
  harness -> host (stdout):
    {"t":"call","prompt":"..."}       # the agent asked for a model call
    {"t":"move","uci":"..."}          # the agent's final move
    {"t":"error","msg":"..."}         # the agent crashed or misbehaved

Contract for the player's file: expose `choose_move(state) -> "e2e4"`. `state` is the dict above.
`state["legal"]` is the list of legal moves in UCI; returning anything not in it forfeits the move
(the referee validates). Standard library only — the sandbox has no third-party packages.
"""

import sys
import json
import importlib.util


def _readline():
    line = sys.stdin.readline()
    if not line:
        raise EOFError("host closed the pipe")
    return json.loads(line)


def _write(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


# The agent gets exactly one model call per move. That is the cost ceiling: with games serialized,
# one paid 0G call per move is the most an agent can spend, and a second call is a hard error.
_calls = {"n": 0}


def call_model(prompt):
    """Ask Zerun's 0G bridge for one inference. Returns the model's text, or raises on failure so
    the agent can fall back to its own logic. Usable at most once per move."""
    if _calls["n"] >= 1:
        raise RuntimeError("call_model may be used at most once per move")
    _calls["n"] += 1
    _write({"t": "call", "prompt": str(prompt)})
    resp = _readline()
    if resp.get("t") == "model":
        return resp.get("text", "")
    raise RuntimeError("model call failed: " + str(resp.get("msg", "unknown")))


def main():
    if len(sys.argv) < 2:
        _write({"t": "error", "msg": "no agent file path"})
        return

    agent_path = sys.argv[1]
    spec = importlib.util.spec_from_file_location("agent", agent_path)
    if spec is None or spec.loader is None:
        _write({"t": "error", "msg": "could not load agent file"})
        return
    mod = importlib.util.module_from_spec(spec)
    # Inject the bridge into the agent's global namespace before its top-level code runs, so the
    # agent just calls call_model(...) as a free function.
    mod.__dict__["call_model"] = call_model
    try:
        spec.loader.exec_module(mod)
    except Exception as e:  # noqa: BLE001 - a bad agent must not crash the harness
        _write({"t": "error", "msg": "agent import failed: " + repr(e)})
        return

    choose = getattr(mod, "choose_move", None) or getattr(mod, "choose", None)
    if not callable(choose):
        _write({"t": "error", "msg": "agent has no choose_move(state) function"})
        return

    state = _readline()
    if not isinstance(state, dict) or state.get("t") != "state":
        _write({"t": "error", "msg": "expected a state message first"})
        return

    try:
        uci = choose(state)
    except Exception as e:  # noqa: BLE001
        _write({"t": "error", "msg": "choose_move raised: " + repr(e)})
        return

    _write({"t": "move", "uci": ("" if uci is None else str(uci)).strip()})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 - last-resort guard; never exit without a message
        try:
            _write({"t": "error", "msg": "harness error: " + repr(e)})
        except Exception:
            pass
