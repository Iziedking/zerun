# Chess sound effects

Drop these files here and they are used automatically. Any that are missing fall back to the
synthesized knocks in `src/lib/sound.ts`, so the game is never silent.

| File             | Plays when                     | Wanted length | Played at |
|------------------|--------------------------------|---------------|-----------|
| `game-start.mp3` | the first ply of a game        | 0.5-1.2 s     | 0.50      |
| `move.mp3`       | any quiet move                 | 60-120 ms     | 0.42      |
| `capture.mp3`    | a move that takes a piece      | 120-250 ms    | 0.55      |
| `game-end.mp3`   | a game is decided             | 0.8-1.5 s     | 0.50      |

Rules of thumb, because a match plays over a hundred moves:

* `move` must be SHORT and quiet. Anything with a tail becomes a drone at one move every few
  seconds. A single wooden click with almost no ring.
* `capture` should read as *heavier*, not merely louder: a lower, broader knock. If it is just
  a louder `move` the ear cannot tell them apart.
* `game-start` and `game-end` should not both be fanfares. Start rises, end settles.
* `game-end` is a resolution, not a celebration. The win overlay has its own chime.
* Mono is fine. Trim leading silence — even 40 ms of it makes a move feel late.

In a bracket, `game-start` fires once per match (the ply counter restarts each game).
