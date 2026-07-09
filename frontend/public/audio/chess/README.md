# Chess sound effects

Drop three files here and they are used automatically. Any that are missing fall back to the
synthesized knocks in `src/lib/sound.ts`, so the game is never silent.

| File           | Plays when                        | Wanted length | Suggested volume |
|----------------|-----------------------------------|---------------|------------------|
| `move.mp3`     | any quiet move                    | 60-120 ms     | played at 0.42   |
| `capture.mp3`  | a move that takes a piece         | 120-250 ms    | played at 0.55   |
| `game-end.mp3` | a bracket match is decided        | 0.8-1.5 s     | played at 0.50   |

Rules of thumb, because a tournament plays a few hundred moves:

* `move` must be SHORT and quiet. Anything with a tail becomes a drone at one move every few
  seconds. A single wooden click with almost no ring.
* `capture` should read as *heavier*, not merely louder: a lower, broader knock. If it is just
  a louder `move` the ear cannot tell them apart.
* `game-end` is a resolution, not a fanfare. The win celebration already has a chime.
* Mono is fine. Trim leading silence — even 40 ms of it makes a move feel late.
