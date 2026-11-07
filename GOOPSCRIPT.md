# GoopScript Reference

GoopScript is the small scripting language Goops uses to decide what happens when an attack lands. Each class can have a script written at the bottom of its `class_info.txt`, right after its stats.

This reference covers the class file layout, every command, the variables you can read, how hits and knockback actually work, and what the server prints when a script has a mistake.

## Class files

Every class lives in its own folder inside `classes/`:

```
classes/
  Yodeler/
    class_info.txt    stats, then the optional script
    player.png
    player_attack.png
    attack.png
```

The server reads these files itself. Players cannot send their own stats or scripts. It re-reads them whenever someone opens the lobby page, so edits to a class file apply without a restart.

## Stats

Stats come first, one per line, written as `key: value` (`key = value` also works). Keys are lowercased and spaces are removed, so `Attack Type: ranged` becomes `attacktype`. Blank lines and lines starting with `#` are ignored.

| Stat | Meaning | Default |
|---|---|---|
| `health` | Starting and maximum health | 100 |
| `speed` | Pixels walked per tick toward the point you clicked (about 30 ticks per second) | 4 |
| `damage` | Damage per hit when the class has no script, and the default amount for `sustain damage` | 10 |
| `range` | How far an attack reaches, in pixels | 60 |
| `knockback` | Default strength for `knockback[...]` | 20 |
| `attacktype` | A label such as `melee` or `ranged`. It does not change gameplay yet | melee |

You can add your own numeric stats, such as `rage: 5`, and read them in a script as `you.rage`.

## Writing a script

The script starts at a line that says exactly `on_hit:` and runs to the end of the file. It runs once for every victim an attack lands on, so a swing that hits two players runs the script twice.

```
attack type: melee
range: 80
damage: 20
health: 100

on_hit:
  sustain damage[victim]
  knockback[victim, 40]
```

- **A script replaces the default hit.** With no `on_hit:` block, a hit simply deals the class's `damage` stat. With one, the script decides everything, so you must write `sustain damage[...]` yourself.
- **Indentation is optional.** Commands and keywords are not case sensitive.
- **Comments** are lines that start with `#`. They must be on their own line, not after a command.
- **Only `on_hit` exists.** Any other `on_something:` line prints a warning and its lines are ignored.

## Commands

| Command | What it does |
|---|---|
| `if[condition]` | Runs the lines below it when the condition is true. |
| `else` | Optional. Runs when the condition was false. |
| `end` | Closes an `if`. Every `if` needs one. |
| `sustain damage[TARGET]` | TARGET takes damage. The default amount is your `damage` stat. |
| `sustain damage[TARGET, amount]` | TARGET takes `amount` damage. |
| `knockback[TARGET]` | TARGET is shoved away. The default strength is your `knockback` stat, or 20 if you have none. |
| `knockback[TARGET, amount]` | The same with an explicit strength. |

`TARGET` is a placeholder. Write one of these two words in its place:

- `you` is the attacker, the player running the script.
- `victim` is the player who was hit.

`if`s can be nested inside each other. There is no `else if`, so put a new `if` inside the `else` instead:

```
if[distance < 50]
  sustain damage[victim, 30]
else
  if[distance < 120]
    sustain damage[victim, 15]
  else
    sustain damage[victim, 5]
  end
end
```

## Expressions

Conditions and amounts are math expressions. Nothing is ever run as real code, and scripts have no loops, so they always finish.

| Kind | Written as |
|---|---|
| Numbers | `5`, `0.25` |
| Math | `+  -  *  /` and parentheses |
| Comparison | `<  >  <=  >=  ==  !=` (a single `=` also means equals) |
| Logic | `and`, `or`, `not` |

True is `1` and false is `0`. Precedence from loosest to tightest is `or`, `and`, `not`, comparisons, `+ -`, `* /`, then a leading minus. Use parentheses whenever you are unsure.

```
if[victim.health < 30 and distance < 100]
if[not (you.health > 50 or distance >= 60)]
sustain damage[victim, damage + (you.maxhealth - you.health) * 0.25]
```

## Variables

| Name | Value |
|---|---|
| `you.health` / `victim.health` | Current health |
| `you.maxhealth` / `victim.maxhealth` | Health the player started with |
| `you.x`, `you.y` / `victim.x`, `victim.y` | Position in the 800 by 600 arena. `y` grows downward |
| `you.isdead` / `victim.isdead` | 1 if dead, otherwise 0 |
| `you.<stat>` / `victim.<stat>` | Any numeric stat from that player's class, such as `you.damage` or `victim.speed` |
| `distance` | Pixels between you and the victim |

A bare name with no `you.` or `victim.` in front means you, so `damage` is the same as `you.damage`. Note that `health` is live health, while the `health` stat only sets the starting value, which you can read as `maxhealth`.

A name that does not exist counts as `0`, and the server prints one warning about it.

## How a hit happens

1. Pressing space starts a swing that lasts about half a second. You cannot start another until it ends.
2. Partway through the swing, the server checks every other living player in the arena.
3. A player is hit if they are within `range` pixels and inside a 90 degree cone, 45 degrees either side of where your mouse was aiming.
4. The script runs once for each player hit. A swing hits each player at most once.

## Damage and knockback details

- **Damage** is never negative, and anything that is not a finite number counts as 0. Health stops at 0, and a player at 0 health dies and respawns after five seconds.
- **Self damage** works. `sustain damage[you, 2]` can even kill you.
- **Knockback slides.** The target is pushed away over a few frames instead of teleporting. The amount is roughly the total distance slid, in pixels.
- **Direction.** `knockback[victim]` pushes the victim away from you. `knockback[you]` pushes you away from the victim, which makes a recoil. If two players are exactly on top of each other there is no direction, so nothing happens.
- **Stacking.** Several knockbacks in one hit add together.
- **Walls.** Players are kept inside the arena, so a shove into a wall stops at the wall.

## Mistakes and warnings

A mistake in a script never crashes the game. The bad line is skipped and the server prints a warning with its line number, for example:

```
[goopscript] Yodeler: line 7: target must be 'you' or 'victim', got 'bob'
[goopscript] Yodeler: line 9: unknown command 'explode[victim]'
[goopscript] Yodeler: missing 'end' for 1 if block(s)
```

Where to look: the window running the server. The warnings appear when the lobby page is opened, because that is when class files are re-read.

Common slips:

- Writing the word `TARGET` instead of `you` or `victim`.
- Forgetting the `end` for an `if`.
- Using `else if`. Nest a new `if` in the `else` instead.
- Using parentheses for commands. Commands use square brackets.
- Putting a comment at the end of a command line.
- Misspelling the `on_hit:` line, or leaving off the colon.

## Examples

**Finisher.** Hits normally, but executes anyone who is low.

```
damage: 10
health: 100

on_hit:
  if[victim.health <= damage * 2]
    sustain damage[victim, damage * 3]
  else
    sustain damage[victim]
    knockback[victim]
  end
```

**Thorns.** Every hit also hurts the attacker.

```
damage: 12
health: 150

on_hit:
  sustain damage[victim]
  sustain damage[you, 2]
```

**Berserker.** Hits harder the more hurt it is. At full health it deals 8, at 60 health 23, and at 20 health 33.

```
damage: 8
health: 120

on_hit:
  # hits harder the more hurt you are
  sustain damage[victim, damage + (you.maxhealth - you.health) * 0.25]
```

**Yodeler.** A wide soundwave. Up close it launches hard, and the push fades with distance.

```
attack type: ranged
range: 220
speed: 3
damage: 5
health: 80
knockback: 80

on_hit:
  if[distance < 70]
    sustain damage[victim, damage * 3]
    knockback[victim, you.knockback * 1.5]
  else
    sustain damage[victim]
    knockback[victim, you.knockback - distance * 0.3]
  end

  knockback[you, 12]
```

## Not supported yet

- Hooks other than `on_hit`.
- Variables you set yourself, loops, and `else if`.
- Healing. Damage amounts below zero are treated as 0.
- Text comparisons. Only numbers can be compared.
- Targets other than `you` and `victim`.
