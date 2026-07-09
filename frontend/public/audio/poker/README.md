# Poker sound effects

Optional. Each falls back to the synthesized chip clicks in `src/lib/sound.ts`.
The runner's action label is matched on its verb, so these map to what an agent did.

| File            | Plays when                | Wanted length | Played at |
|-----------------|---------------------------|---------------|-----------|
| `check.mp3`     | "checks"                  | 80-150 ms     | 0.45      |
| `call.mp3`      | "calls 20"                | 100-200 ms    | 0.45      |
| `raise.mp3`     | "raises to 60", all-in    | 150-300 ms    | 0.45      |
| `fold.mp3`      | "folds"                   | 100-200 ms    | 0.45      |
| `showdown.mp3`  | a pot is awarded          | 0.4-1.0 s     | 0.45      |

Notes:

* `check` is a knuckle rap on the table, not a chip.
* `call` and `raise` are both chips; `raise` should sound like MORE chips, not louder ones.
* `fold` is cards hitting felt — soft, papery, no click.
* A table plays a lot of these. Keep them dry and short; reject anything with room reverb.
