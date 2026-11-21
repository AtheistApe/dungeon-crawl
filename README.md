# Dungeon Crawl

A turn-based, tile-based roguelike inspired by Matt Dinniman's *Dungeon Crawler Carl* series. Guide Carl and Princess Donut down through a procedurally generated dungeon on a galactic reality show: beat the floor timer, open loot boxes, survive boss fights and keep the audience entertained.

> **Unofficial fan project.** Not affiliated with or endorsed by Matt Dinniman, Dandy House, Soundbooth Theater or any publisher. *Dungeon Crawler Carl*, its characters and its setting belong to their respective owners. All artwork in this game is original and drawn in code.

**Play:** open `docs/index.html` in a browser, or enable GitHub Pages (below) and visit `https://<your-username>.github.io/<repo-name>/`.

## Features

- **Procedural floors**: rooms and corridors, fog of war, a safe room, stairwells and a countdown before the floor collapses.
- **Two crawlers**: Carl, plus Princess Donut as a full party member with her own levels, stats, achievements and loot.
- **Book-style stats and magic**: STR, INT, CON, DEX and CHA. Spells cost mana and level up with use (Magic Missile, Heal, Second Chance). Potions have a CON-based cooldown, and drinking too early causes potion sickness.
- **Monster families with roles**: goblins (Bomb Bards, Shamankas, War Chieftains), rat-kin (janitor rats that eat corpses and grow), bats, a loot-vacuuming robot and neutral Bad Llamas at war with the goblins.
- **Charisma and factions**: charm hostile monsters; neutral monsters turn on you only when provoked.
- **Bosses**: a Neighborhood Boss and an optional Borough Boss on every floor, in lairs that seal shut, with Boss Boxes, stars and persistent loot (maps and field guides).
- **Achievements and loot boxes**: Floor 1 achievements adapted from the series, with six box tiers (Bronze to Celestial) and box types such as Weapon, Apparel, Goblin, Pet, Boss, Survivor's and Benefactor.
- **Race and class selection on Floor 3**: banked stat points cover class minimums, and some classes unlock through achievements.
- **Minimap**: upgraded by reading a dungeon sign; cycles between small, full-floor and off. Safe rooms always show.
- **Monster info cards** on hover (press and hold on touchscreens).
- Works on desktop and tablet/phone, with an on-screen movement pad and tap-to-move.

## Controls

| Key | Action |
|---|---|
| Arrows / WASD / HJKL | Move or attack (Y U B N or the numpad for diagonals) |
| `.` or `5` | Wait a turn |
| Q | Drink a healing potion |
| C | Cast Heal |
| F | Cast Magic Missile (if your class has it) |
| T | Throw a bomb at the nearest visible enemy |
| R | Rest (safe room only, costs 40 turns) |
| O | Open loot boxes (safe room only) |
| M | Cycle the map: small, full floor, off |
| `>` | Take the stairs |
| `?` | How to play |

## Project layout

```
src/
  game.js                 all game logic (heavily commented; see the overview at the top)
  style.css               styles
  index.template.html     page markup with /*@@CSS@@*/ and /*@@JS@@*/ placeholders
docs/
  index.html              the built, self-contained game (served by GitHub Pages)
  .nojekyll               tells GitHub Pages to serve files as-is
build.py                  combines src/ into docs/index.html
tests/smoke_test.py       headless random-play test that fails on any JavaScript error
```

The game has no dependencies and no bundler: plain HTML, CSS and JavaScript drawn on a `<canvas>`.

## Building

Edit files in `src/`, then rebuild:

```bash
python3 build.py
```

Commit both `src/` and the regenerated `docs/index.html`.

## Testing (optional)

```bash
pip install playwright
playwright install chromium
python3 tests/smoke_test.py          # 2,000 random inputs by default
```

## Publishing with GitHub Pages

1. Push this repository to GitHub.
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, then select branch `main` and folder `/docs`.
4. After a minute the game is live at `https://<your-username>.github.io/<repo-name>/`.
