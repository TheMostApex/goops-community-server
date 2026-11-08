# GoopScript Reference

GoopScript is the small scripting language Goops uses to decide what happens in the game. You write it in two kinds of files:

- A **class** (`classes/<Name>/class_info.txt`) can react when its player attacks or hits someone.
- A **prop** (`props/<Name>/prop_info.txt`) is a thing in the arena that a script can place, shoot or delete. Props have their own scripts too, so they can hurt people, burn them, explode, or wait and then do something.

This reference covers the file layouts, every hook and command, the variables you can read, and how it all behaves in play.

## Contents

1. Class files
2. Prop files
3. Writing a script
4. Commands
5. Expressions and variables
6. How hits, props and delays behave
7. Mistakes and warnings
8. Examples
9. Not supported yet

## 1. Class files

Every class lives in its own folder inside `classes/`:

```
classes/
  Yodeler/
    class_info.txt    stats, then optional scripts
    player.png
    player_attack.png
    attack.png
```

The server reads these files itself. Players cannot send their own stats or scripts. It re-reads them whenever someone opens the lobby page, so edits apply without a restart.

Stats come first, one per line, as `key: value` (`key = value` also works). Keys are lowercased and spaces are removed, so `Attack Type: ranged` becomes `attacktype`. Blank lines and lines starting with `#` are ignored.

| Stat | Meaning | Default |
|---|---|---|
| `health` | Starting and maximum health | 100 |
| `speed` | Pixels walked per tick toward the point you clicked (about 30 ticks per second) | 4 |
| `damage` | Damage per hit when the class has no `on_hit`, and the default amount for `sustain damage` | 10 |
| `range` | How far an attack reaches, in pixels | 60 |
| `knockback` | Default strength for `knockback[...]` | 20 |
| `attacktype` | A label such as `melee` or `ranged`. It does not change gameplay | melee |

You can add your own numeric stats, such as `rage: 5`, and read them as `you.rage`.

### Class hooks

| Hook | When it runs |
|---|---|
| `on_attack` | Once per attack, at the moment the swing lands, whether or not it hits anyone. There is no `victim`. |
| `on_hit` | Once for every player the attack hits. `victim` is that player. |

A class with an `on_hit` script controls everything a hit does, so you must write `sustain damage[...]` yourself. A class without one just deals its `damage` stat to whoever it hits.

A class that only shoots or places props should have `range: 0` and `damage: 0`, so its swing hits nobody on its own and the prop does all the work.

## 2. Prop files

Every prop lives in its own folder inside `props/`:

```
props/
  Mine/
    prop_info.txt    stats, then optional scripts
    prop.png         the picture
```

Props are found automatically, like classes. There is no list to edit, and refreshing the lobby page picks up new ones. A prop name cannot contain `,` `[` or `]`, and cannot be `this` or `all`. In scripts, names are matched without regard to capital letters, so `place prop[mine]` finds the `Mine` folder.

The right side of `prop.png` is its front. The picture is rotated to face the way the prop was placed or shot, and drawn to fit a square twice the prop's `size` across.

### Prop stats

| Stat | Meaning | Default |
|---|---|---|
| `size` | The prop's radius in pixels, used for drawing and for touching (2 to 200) | 16 |
| `speed` | Pixels per tick when shot without a speed of its own (0 to 60) | 8 |
| `drag` | The fraction of its speed a moving prop loses every tick. 0 never slows, 0.07 slows to a stop in about a second and a half (0 to 1) | 0 |
| `lifetime` | Seconds until it expires. 0 means it never does | 0 |
| `armdelay` | Seconds after appearing before it reacts to anyone touching it | 0 |
| `stayinterval` | Seconds between `on_stay` runs for a player standing on it (0.1 or more) | 0.5 |
| `touchowner` | `yes` if the player who placed it can also set it off. By default they cannot | no |
| `walls` | What happens at the edge of the arena: `vanish` (removed), `stop` or `bounce` | vanish |
| `damage`, `knockback` | The default amounts for `sustain damage[...]` and `knockback[...]` inside this prop's scripts | the owner's |

You can add your own numeric stats and read them as `this.<stat>`.

### Prop hooks

| Hook | When it runs |
|---|---|
| `on_spawn` | When the prop appears, starting on the next tick. There is no `victim`. |
| `on_touch` | When a player steps onto it. `victim` is that player. It runs once per visit. |
| `on_stay` | The moment a player steps onto it, and then every `stayinterval` seconds while they stay. |
| `on_expire` | When its `lifetime` runs out. It does not run when the prop is deleted or leaves the arena. |

**What counts as touching.** A player touches a prop when their body is within the prop's `size` plus 16 pixels (the player's radius) of the path the prop travelled this tick, so a fast prop cannot skip over someone. The owner is ignored unless `touchowner` is on. Dead players are ignored. A prop with an `armdelay` ignores everyone until the delay is over.

## 3. Writing a script

A script starts at a hook line such as `on_touch:` and runs until the next hook line or the end of the file. A file can have several hooks.

```
size: 14
damage: 35

on_touch:
  sustain damage[victim]
  delete prop[this]

on_expire:
  place prop[Fire]
```

- **Indentation is optional.** Commands and keywords are not case sensitive.
- **Comments** are lines that start with `#`. They must be on their own line, not after a command.
- **Unknown hooks** print a warning, and their lines are ignored. A class file only accepts class hooks, and a prop file only accepts prop hooks.

### Who is who

Every script has these names, and the commands below take them as `TARGET` or `ANCHOR`:

| Name | Meaning |
|---|---|
| `you` | The owner: the attacker in a class script, or whoever placed or shot the prop in a prop script |
| `victim` | The player being affected: the one hit, the one touching the prop, or each player in turn inside a `blast` |
| `this` | The prop running the script. It does not exist in class scripts |

Using a name where it does not exist, such as `victim` in `on_attack`, prints a warning once, and the command is skipped.

## 4. Commands

| Command | What it does |
|---|---|
| `if[condition]` ... `else` ... `end` | Runs the first part when the condition is true, otherwise the `else` part. `else` is optional, and `if`s can nest. |
| `sustain damage[TARGET]` | TARGET takes damage. |
| `sustain damage[TARGET, amount]` | TARGET takes `amount` damage. |
| `knockback[TARGET]` | TARGET is shoved away. |
| `knockback[TARGET, amount]` | The same with an explicit strength. |
| `wait[seconds]` | Pauses this script, then carries on. |
| `place prop[Name]` | Puts a prop in the arena. |
| `place prop[Name, ANCHOR]` | ...at the position of `you`, `victim` or `this`. |
| `place prop[Name, ANCHOR, distance]` | ...that many pixels ahead of the anchor, in the direction it faces. |
| `shoot prop[Name]` | Launches a prop in the shooter's facing direction. |
| `shoot prop[Name, speed]` | ...at that many pixels per tick. |
| `shoot prop[Name, speed, angle]` | ...turned by that many degrees. |
| `delete prop[this]` | Removes the prop running the script. |
| `delete prop[Name]` | Removes every prop called Name that you own. |
| `delete prop[all]` | Removes every prop you own. |
| `blast[radius]` ... `end` | Runs the lines inside once for each living player within `radius` pixels, with `victim` set to each in turn. It does not include you. |
| `blast[radius, all]` ... `end` | The same, but you are included. |

`TARGET` is `you` or `victim`. `ANCHOR` is `you`, `victim` or `this`.

### Damage and knockback

- **Default damage** in a class script is your `damage` stat. In a prop script it is the prop's `damage` stat if it has one, otherwise the owner's.
- **Default knockback** is the prop's `knockback` stat, then the owner's, then 20.
- **Knockback slides.** The target is pushed away over a few frames instead of teleporting, and the amount is roughly the total distance slid, in pixels. Several knockbacks add together.
- **Direction.** In a prop script, `knockback[victim]` pushes the victim away from the prop, and `knockback[you]` pushes the owner away from the prop. In a class script, `knockback[victim]` pushes them away from you, and `knockback[you]` pushes you away from the victim. In `on_attack` there is no victim, so `knockback[you]` pushes you backwards, away from where you are facing, like recoil.
- **Damage is never negative,** and anything that is not a finite number counts as 0. Health stops at 0. Damage and knockback do nothing to a player who is dead or has left.

### place and shoot

- **Where.** With no anchor, `place` uses `you` in a class script and `this` in a prop script. The distance is measured along the direction the anchor faces: where a player is aiming, or the direction a prop was placed or is travelling. Positions are kept inside the arena.
- **Shooting.** `shoot` launches from the shooter, who is `you` in a class script and `this` in a prop script, starting at the shooter's edge. A positive angle turns the shot clockwise as seen on screen. Several `shoot` lines with different angles make a spread:

```
on_attack:
  shoot prop[Pellet, 10, -15]
  shoot prop[Pellet, 10, 0]
  shoot prop[Pellet, 10, 15]
```

- **Ownership.** A new prop belongs to `you`, the owner of the script that made it, and counts toward your `you.props`.
- **No prop of that name** prints a warning with the line number when the server loads, and the command is skipped.

### wait

`wait[seconds]` pauses only the script it is in. The game carries on, and the rest of the script runs when the time is up. Waiting works anywhere in a script, including inside an `if` or a `blast`.

- A wait is at most 60 seconds. A negative or missing amount means 0, which resumes on the next tick.
- Conditions are checked again when the script resumes. Positions, health and `distance` are read at that moment, not when the script started.
- **Waiting inside a `blast`** deals with the players one at a time, so a wait makes the effect ripple from one to the next.
- A player who dies or leaves while a script is waiting is skipped, and commands aimed at them do nothing.
- A new round removes every prop and cancels every waiting script.

## 5. Expressions and variables

Conditions and amounts are math expressions. Nothing is ever run as real code, and scripts have no loops, so they always finish.

| Kind | Written as |
|---|---|
| Numbers | `5`, `0.25` |
| Math | `+  -  *  /` and parentheses |
| Comparison | `<  >  <=  >=  ==  !=` (a single `=` also means equals) |
| Logic | `and`, `or`, `not` |

True is `1` and false is `0`. Precedence from loosest to tightest is `or`, `and`, `not`, comparisons, `+ -`, `* /`, then a leading minus. Use parentheses whenever you are unsure.

| Name | Value |
|---|---|
| `you.health` / `victim.health` | Current health |
| `you.maxhealth` / `victim.maxhealth` | Health the player started with |
| `you.x`, `you.y` / `victim.x`, `victim.y` | Position in the 800 by 600 arena. `y` grows downward |
| `you.angle` / `victim.angle` | The direction the player is aiming, in degrees |
| `you.isdead` / `victim.isdead` | 1 if dead, otherwise 0 |
| `you.props` / `victim.props` | How many props that player owns right now |
| `you.<stat>` / `victim.<stat>` | Any numeric stat from that player's class, such as `you.damage` |
| `this.x`, `this.y` | The prop's position |
| `this.angle` | The direction the prop faces, in degrees |
| `this.age` | Seconds since the prop appeared |
| `this.life` | Seconds until it expires, or 0 if it never does |
| `this.size` | The prop's radius |
| `this.<stat>` | Any numeric stat from the prop's file, such as `this.damage` |
| `distance` | Pixels from the prop (or from you, in a class script) to the victim, measured when the line runs |

A bare name with no `you.` in front means you, so `damage` is the same as `you.damage`. `health` is live health, while the `health` stat only sets the starting value, which you can read as `maxhealth`. A name that does not exist counts as `0`, and the server prints one warning about it.

## 6. How hits, props and delays behave

1. Pressing space starts a swing that lasts about half a second. You cannot start another until it ends.
2. Partway through the swing, `on_attack` runs once. Then the server checks every other living player in the arena: a player is hit if they are within `range` pixels and inside a 90 degree cone, 45 degrees either side of where your mouse was aiming. `on_hit` (or the default damage) runs once for each player hit. A swing hits each player at most once.
3. Props are updated about 30 times a second: they expire, move, slow down, turn at walls, and check who is touching them.
4. A prop's `on_spawn` runs on the tick after it appears, so a prop that places more props cannot loop forever within one tick.

**Limits.** To keep one script from flooding the game, each player can own at most 40 props and an arena holds at most 150. At most 500 scripts can be waiting at once, and a single run that does more than 2000 steps in one go is stopped. When a limit is hit, the extra prop or script is skipped and the server window prints one warning.

## 7. Mistakes and warnings

A mistake in a script never crashes the game. The bad line is skipped and the server prints a warning with its line number, for example:

```
[goopscript] Mage: on_attack: line 8: there is no prop called "Fireboll" in the props folder
[goopscript] prop Mine: on_touch: line 3: unknown command 'explode[victim]'
[goopscript] prop Mine: on_touch: missing 'end' for 1 block(s)
```

Where to look: the window running the server. Prop names are checked when the server loads, so a typo shows up straight away instead of in the middle of a match.

Common slips:

- Writing the word `TARGET` instead of `you` or `victim`.
- Forgetting the `end` for an `if` or a `blast`.
- Using `else if`. Nest a new `if` in the `else` instead.
- Using parentheses for commands. Commands use square brackets.
- Putting a comment at the end of a command line.
- Using `victim` in `on_attack` or `on_spawn`, where nobody has been hit or has touched anything yet.
- Misspelling a hook line, or leaving off its colon.

## 8. Examples

**Fireball** (a prop). A fast shot that hurts the first player it touches and then disappears.

```
size: 10
speed: 9
lifetime: 2
damage: 18
knockback: 25

on_touch:
  sustain damage[victim]
  knockback[victim]
  delete prop[this]
```

**Mage** (a class). Throws fireballs.

```
attack type: ranged
range: 0
speed: 4
damage: 0
health: 70

on_attack:
  shoot prop[Fireball]
```

**Mine** (a prop). Arms after a second, then blows up. The closer you are to the middle, the harder it hits. The owner can walk over it safely.

```
size: 14
armdelay: 1
lifetime: 45
damage: 35
knockback: 50

on_touch:
  blast[70]
    sustain damage[victim, this.damage - distance * 0.3]
    knockback[victim]
  end
  delete prop[this]
```

**Trapper** (a class). Lays mines just ahead of itself, up to three at a time.

```
attack type: ranged
range: 0
speed: 5
damage: 0
health: 90

on_attack:
  if[you.props < 3]
    place prop[Mine, you, 30]
  end
```

**Fire** (a prop). Burns anyone standing in it, twice a second, even whoever lit it.

```
size: 30
lifetime: 4
stayinterval: 0.5
touchowner: yes
damage: 4

on_stay:
  sustain damage[victim]
```

**Grenade** (a prop). Slows to a stop, explodes, leaves fire behind, and a moment later goes off again more weakly.

```
size: 10
speed: 12
drag: 0.07
lifetime: 1.6
walls: bounce
damage: 40

on_expire:
  blast[90, all]
    sustain damage[victim, this.damage - distance * 0.35]
    knockback[victim, 60 - distance * 0.4]
  end
  place prop[Fire]

  wait[1.5]
  blast[60]
    sustain damage[victim, 8]
  end
```

**Finisher** (a class). Hits normally, but executes anyone who is low.

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

**Berserker** (a class). Hits harder the more hurt it is. At full health it deals 8, at 60 health 23, and at 20 health 33.

```
damage: 8
health: 120

on_hit:
  sustain damage[victim, damage + (you.maxhealth - you.health) * 0.25]
```

**Yodeler** (a class). A wide soundwave. Up close it launches hard, and the push fades with distance.

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

## 9. Not supported yet

- Props that block movement, or that can be attacked and destroyed.
- Hooks other than the ones listed above, such as on death.
- Variables you set yourself, loops, and `else if`.
- Healing. Damage amounts below zero are treated as 0.
- Text comparisons. Only numbers can be compared.
- Targets other than `you` and `victim`.
