# Build a Zerun chess agent (strategy.py)

You are helping a person enter Zerun's Zero Cup Chess competition. The whole entry is
ONE Python file that plays chess. Your job is to write that file for them and explain, in
plain language, what it does and how to submit it. The person may not be a developer, so
keep your explanations simple and do all of the coding yourself.

If you are the person reading this: paste this whole file (or its link, https://zerun.site/AGENT.md)
into any AI coding assistant (Claude, Cursor, ChatGPT, and so on) and say "build me a
strategy.py following this guide." Then follow the "How to submit" steps at the end.

---

## What you are building

A single file (call it `strategy.py`) that, given a chess position, returns the move to
play. Every player uploads one of these. Zerun runs them against each other around the
clock and ranks them on a live ladder. A stronger file climbs higher.

There is no framework to learn and no account or API key to wire up. You write one
function. Zerun's referee runs the actual game, checks that your move is legal, and keeps
score.

---

## The contract (this is the whole API)

Your file must define a function named `choose_move` that takes one argument and returns a
move:

```python
def choose_move(state):
    # ... your logic ...
    return "e2e4"   # a move in UCI notation
```

`state` is a plain dictionary with these keys:

| key                | what it is                                                        |
|--------------------|-------------------------------------------------------------------|
| `state["fen"]`     | the position as a FEN string, e.g. `"rnbqkbnr/pppppppp/... w KQkq - 0 1"` |
| `state["legal"]`   | a list of every legal move right now, in UCI, e.g. `["e2e4", "g1f3", ...]` |
| `state["side"]`    | `"w"` if you are White this move, `"b"` if Black                  |
| `state["ply"]`     | how many half-moves have been played so far (an integer)          |
| `state["budget_ms"]` | how many milliseconds of wall-clock you have for THIS move       |

Rules you must obey:

- Return exactly one string from `state["legal"]`. Nothing else is a legal answer.
- UCI notation is from-square then to-square, e.g. `"e2e4"`. A promotion adds the piece,
  e.g. `"e7e8q"` (queen). The moves in `state["legal"]` are already in this format, so the
  safest thing is to return one of them verbatim.
- Returning a move that is not in `state["legal"]`, returning nothing, crashing, or taking
  longer than the budget all forfeit that single move (the referee makes a safe move for
  you and play continues). So never crash: wrap risky code in try/except and always have a
  fallback that returns `state["legal"][0]`.

---

## The environment your file runs in

- **Standard library only.** The sandbox has no third-party packages. Do not `import`
  anything that is not built into Python (no `chess`, no `numpy`, no `requests`). Plain
  Python plus `math`, `random`, `re`, and friends is all you get.
- **No network.** Your file cannot open sockets or make web requests. The only outside call
  you can make is `call_model` (below), which Zerun provides for you.
- **Time.** You get about 5 seconds per move by default (read the real number from
  `state["budget_ms"]`, do not hard-code it). If you run a search, check the clock and stop
  before the budget runs out. Use `time.monotonic()` to measure elapsed time.
- **File size.** The upload limit is 64 KB, which is enormous for one chess file. Keep it to
  one file; you have all the room you need.
- **Determinism helps.** The same position can come up many times. A stable, sensible move
  is better than a random one, though a little tie-breaking randomness is fine.

---

## Thinking on 0G: the `call_model` bridge

Inside your file you may call a function named `call_model`. You do NOT import it or define
it; Zerun injects it into your file before it runs. Call it like a normal function:

```python
answer = call_model("Position (FEN): " + state["fen"] + "\nPick the best move: " + " ".join(state["legal"]))
```

What it does: it sends your prompt to a real AI model running on the 0G Compute Network and
returns the model's text answer. This is how a Zerun agent "thinks on 0G."

Important details:

- **Once per move.** You may call `call_model` at most one time per move. A second call in
  the same move raises an error.
- **Your clock is paused during the call.** The time the model spends thinking does not come
  out of your `budget_ms`. Only your own code races the clock.
- **It can fail.** The call may raise an exception (model busy, timeout, and so on). ALWAYS
  wrap it in try/except and fall back to your own logic. Never let a failed model call
  forfeit your move.
- **The reply is short free text.** The model returns up to a few hundred tokens of plain
  text, not structured data. Parse it defensively: scan the reply for the first move from
  your own shortlist that appears in it, and ignore everything else.

Using `call_model` is optional. A strong file can be pure Python with no model call at all,
or it can use the model to break ties among a few good candidate moves. Both are valid.

---

## A working starter you can build on

This is a complete, legal, submittable file. It shortlists captures, asks 0G to pick the
best one, and falls back to its own choice if the model is unavailable. Start here and make
it stronger.

```python
"""A Zerun chess agent. One file. Expose choose_move(state) -> a UCI move."""


def _board(fen):
    """Map each square to its piece, e.g. {'e4': 'P'}, from a FEN string."""
    board = {}
    if not fen:
        return board
    placement = fen.split()[0]
    rank = 8
    for row in placement.split("/"):
        file = 0
        for ch in row:
            if ch.isdigit():
                file += int(ch)
            else:
                board[chr(ord("a") + file) + str(rank)] = ch
                file += 1
        rank -= 1
    return board


def _is_capture(uci, board, side):
    """True if this move lands on an enemy piece."""
    if len(uci) < 4:
        return False
    target = board.get(uci[2:4])
    if not target:
        return False
    return target.islower() if side == "w" else target.isupper()


def _pick_from_reply(text, allowed):
    """Return the first move from `allowed` that appears in the model's reply, else None."""
    if not text:
        return None
    low = text.strip().lower()
    for move in allowed:
        if move in low:
            return move
    return None


def choose_move(state):
    legal = state.get("legal") or []
    if not legal:
        return ""

    side = state.get("side", "w")
    board = _board(state.get("fen", ""))
    captures = [m for m in legal if _is_capture(m, board, side)]
    shortlist = captures if captures else legal

    try:
        prompt = (
            "You are a strong chess engine playing " + side + ".\n"
            "Position (FEN): " + state.get("fen", "") + "\n"
            "Choose the single best move, in UCI, from exactly this list:\n"
            + " ".join(shortlist[:24])
            + "\nReply with ONLY the move, nothing else."
        )
        pick = _pick_from_reply(call_model(prompt), shortlist)  # call_model is injected by Zerun
        if pick:
            return pick
    except Exception:
        pass

    return shortlist[0]
```

---

## How to make it genuinely strong (do this)

The starter is only a baseline. A file that wins needs to actually evaluate positions. Good
directions, roughly in order of payoff:

1. **Material and simple evaluation.** Score a position by counting material (pawn 1, knight
   and bishop 3, rook 5, queen 9) plus small bonuses for center control and piece activity.
   You will need to apply a candidate move to the FEN yourself, since the sandbox has no
   chess library. Writing a small "make this UCI move on this board dict" helper is the key
   building block.
2. **Search.** Look a few moves ahead with a minimax / alpha-beta search over the legal
   moves, scoring the resulting positions with your evaluation. Add a quiescence step that
   keeps searching through captures so you do not stop the count in the middle of a trade.
3. **Time management.** Use iterative deepening: search depth 1, then 2, then 3, and stop as
   soon as you are close to `state["budget_ms"]`. Always keep the best move found so far so
   you can return it the instant the clock is short.
4. **Safety first.** Before returning, double check your move is in `state["legal"]`. If a
   bug ever produces something else, fall back to a legal move. A file that never forfeits
   already beats many that occasionally crash.

You do not need a full chess engine. A correct material evaluation with a 3 to 4 ply
alpha-beta search, that never crashes and never times out, is a serious competitor. Pure
standard library, no external move generator needed, because `state["legal"]` gives you the
legal moves at the root and you can generate replies by applying moves to your own board
representation.

If you (the coding assistant) build the stronger version, keep the whole thing in one file,
test it (below), and hand the person the final `strategy.py`.

---

## Test it before uploading

You can sanity-check the file locally without Zerun. Save your file as `strategy.py` and run
a tiny driver like this next to it:

```python
import strategy

# A sample opening position. `legal` here is a handful of real legal moves.
state = {
    "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "legal": ["e2e4", "d2d4", "g1f3", "c2c4", "b1c3"],
    "side": "w",
    "ply": 0,
    "budget_ms": 5000,
}

# call_model does not exist outside Zerun, so provide a stub for local testing.
strategy.call_model = lambda prompt: "e2e4"

move = strategy.choose_move(state)
print("chose:", move)
assert move in state["legal"], "the move must be one of the legal moves"
print("ok: returned a legal move")
```

If that prints "ok", your file returns a legal move and does not crash. On Zerun the real
`call_model` and the real legal-move list are supplied for you, so you never ship the stub.
Zerun also runs its own entry check on upload: it plays your file on several test positions
and only accepts it if it returns a legal move each time.

---

## How scoring and winning work (so you optimize for the right thing)

- Every game your agent plays updates its rating using TrueSkill, and the ladder ranks by a
  conservative rating (skill minus the uncertainty). That means you need BOTH a strong
  record AND enough games for the system to trust it. A few lucky wins will not top the
  board; consistent results over many games will.
- Win by checkmate, or by having the better position when the clock runs out.
- You can re-upload an improved file whenever you like. A new upload resets your rating so
  you climb again from scratch, but it keeps your original entry time.

---

## How to submit

1. Go to the Chess page on Zerun (`/chess`) and connect your wallet.
2. Connect your X account when prompted. It is required to enter, and it keeps the
   competition free of bot and duplicate entries. Your X picture and name show on the board
   next to your agent.
3. Upload your `strategy.py`. Zerun runs the entry check; if it passes, your agent is on the
   ladder and starts playing.
4. Watch it climb. Click your agent on the ladder to watch its live game.

---

## Checklist for the coding assistant

Before you hand back the file, confirm all of these:

- [ ] The file defines `choose_move(state)` and returns a string.
- [ ] It only ever returns a value found in `state["legal"]`.
- [ ] It imports nothing outside the Python standard library.
- [ ] It never crashes: risky code is wrapped in try/except with a legal fallback.
- [ ] Any `call_model` use is at most once per move, in a try/except, with a fallback.
- [ ] If it searches, it respects `state["budget_ms"]` and returns in time.
- [ ] It is a single file and well under 64 KB.
- [ ] The local test above prints "ok".
