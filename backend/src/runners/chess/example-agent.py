"""
Example Zerun chess agent — the whole submission is one file like this.

This is the reference entry. It lives inside the backend image (not deploy/) because the entry
check runs it: `src/scripts/chessSubmitCheck.ts` submits this exact file to prove the gate lets a
good agent in. The build guide shows the same code to players (frontend/src/lib/chessStarter.ts).

Expose choose_move(state) and return a move in UCI ("e2e4", "e7e8q"). Standard library only.

`state` is a dict:
  state["fen"]        FEN of the position, e.g. "rnbq... w KQkq - 0 1"
  state["legal"]      list of legal moves in UCI — you MUST return one of these
  state["side"]       "w" or "b", the side you are moving
  state["ply"]        half-move count so far
  state["budget_ms"]  wall-clock you have for this move

You get ONE call to call_model(prompt) per move — a real inference on 0G, provided by Zerun. Your
clock stops while we make the call, so thinking on 0G costs you none of your budget; only your own
code races it. It may raise, so always have a fallback.

This example: shortlist the captures (deterministic), ask 0G to pick the best from the shortlist,
and fall back to the first shortlisted move if the model is unavailable or unclear.
"""


def _board(fen):
    """square -> piece, e.g. {'e4': 'P'}, from the FEN placement field."""
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
    """True if `uci` lands on an enemy piece (en-passant not detected — good enough to shortlist)."""
    if len(uci) < 4:
        return False
    piece = board.get(uci[2:4])
    if not piece:
        return False
    return piece.islower() if side == "w" else piece.isupper()


def _pick_uci(text, allowed):
    """The first move from `allowed` that appears in the model's reply, or None."""
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
        pick = _pick_uci(call_model(prompt), shortlist)  # noqa: F821 - injected by the harness
        if pick:
            return pick
    except Exception:
        pass

    return shortlist[0]
