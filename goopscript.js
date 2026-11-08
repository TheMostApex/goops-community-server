// --------------------------------------------------
// GoopScript
// --------------------------------------------------
// A tiny scripting language for class and prop behavior. Scripts live in a class's
// class_info.txt or a prop's prop_info.txt, after the stats, under a hook line such as
// "on_hit:". Each hook is a separate script that the game runs when something happens.
//
//   on_hit:
//     if[victim.health <= damage * 2]
//       sustain damage[victim, damage * 3]
//     else
//       sustain damage[victim]
//       knockback[victim]
//     end
//
// Hooks
//   classes:  on_hit     once for each player an attack hits
//             on_attack  once per attack, hit or not
//   props:    on_spawn   when the prop appears
//             on_touch   when a player steps onto it
//             on_stay    while a player stands on it, every few moments
//             on_expire  when its lifetime runs out
//
// Commands
//   if[condition] ... else ... end
//   sustain damage[TARGET] / sustain damage[TARGET, amount]
//   knockback[TARGET]      / knockback[TARGET, amount]
//   wait[seconds]                        pause this script, then carry on
//   place prop[Name] / place prop[Name, ANCHOR] / place prop[Name, ANCHOR, distance]
//   shoot prop[Name] / shoot prop[Name, speed] / shoot prop[Name, speed, angle]
//   delete prop[this] / delete prop[all] / delete prop[Name]
//   blast[radius] ... end                runs its lines once for every player in range
//   blast[radius, all] ... end           the same, but you are included too
//
// TARGET is "you" or "victim". ANCHOR is "you", "victim" or "this".
//   you     the player who owns this: the attacker, or whoever placed or shot the prop
//   victim  the player being affected: the one hit, the one touching the prop, or
//           each player in turn inside a blast
//   this    the prop running the script
//
// Conditions and amounts are math expressions: numbers, + - * /, parentheses,
// comparisons (< > <= >= == !=), and, or, not.
//
// Variables: you.health  you.maxhealth  you.x  you.y  you.angle  you.isdead  you.props
//            victim.<same>      this.x  this.y  this.angle  this.age  this.life  this.size
//            distance (from this prop, or from you, to the victim)
//            any numeric stat, e.g. you.damage, this.damage
//            a bare name such as "damage" means you.damage
//
// Scripts have no loops, so they always finish. Nothing is ever eval'd.

'use strict';

const DEFAULT_KNOCKBACK = 20;
const MAX_WAIT_SECONDS = 60;
const MAX_STEPS_PER_ADVANCE = 2000;
const RAD_TO_DEG = 180 / Math.PI;

// ---------- Expressions ----------

function tokenize(src) {
    const tokens = [];
    const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_.]*)|(<=|>=|==|!=|[-+*/()<>=]))/y;
    let pos = 0;

    while (pos < src.length) {
        re.lastIndex = pos;
        const m = re.exec(src);
        if (!m) {
            const rest = src.slice(pos).trim();
            if (rest === '') break;
            throw new Error(`unexpected character '${rest[0]}'`);
        }
        pos = re.lastIndex;

        if (m[1] !== undefined) {
            tokens.push({ t: 'num', v: parseFloat(m[1]) });
        } else if (m[2] !== undefined) {
            const word = m[2].toLowerCase();
            if (word === 'and' || word === 'or' || word === 'not') {
                tokens.push({ t: 'op', v: word });
            } else {
                tokens.push({ t: 'id', v: word });
            }
        } else {
            tokens.push({ t: 'op', v: m[3] === '=' ? '==' : m[3] });
        }
    }
    return tokens;
}

const COMPARE = {
    '<': (a, b) => a < b,
    '>': (a, b) => a > b,
    '<=': (a, b) => a <= b,
    '>=': (a, b) => a >= b,
    '==': (a, b) => a === b,
    '!=': (a, b) => a !== b
};

// Compiles an expression string into a function (ctx) => number.
// Booleans are 1 and 0.
function compileExpression(src) {
    const tokens = tokenize(src);
    if (tokens.length === 0) throw new Error('empty expression');
    let i = 0;

    const isOp = (v) => i < tokens.length && tokens[i].t === 'op' && tokens[i].v === v;

    function parseOr() {
        let left = parseAnd();
        while (isOp('or')) {
            i++;
            const l = left;
            const r = parseAnd();
            left = (c) => (l(c) || r(c) ? 1 : 0);
        }
        return left;
    }

    function parseAnd() {
        let left = parseNot();
        while (isOp('and')) {
            i++;
            const l = left;
            const r = parseNot();
            left = (c) => (l(c) && r(c) ? 1 : 0);
        }
        return left;
    }

    function parseNot() {
        if (isOp('not')) {
            i++;
            const inner = parseNot();
            return (c) => (inner(c) ? 0 : 1);
        }
        return parseCompare();
    }

    function parseCompare() {
        const l = parseAdd();
        if (i < tokens.length && tokens[i].t === 'op' && COMPARE[tokens[i].v]) {
            const fn = COMPARE[tokens[i++].v];
            const r = parseAdd();
            return (c) => (fn(l(c), r(c)) ? 1 : 0);
        }
        return l;
    }

    function parseAdd() {
        let left = parseMul();
        while (isOp('+') || isOp('-')) {
            const plus = tokens[i++].v === '+';
            const l = left;
            const r = parseMul();
            left = plus ? (c) => l(c) + r(c) : (c) => l(c) - r(c);
        }
        return left;
    }

    function parseMul() {
        let left = parseUnary();
        while (isOp('*') || isOp('/')) {
            const times = tokens[i++].v === '*';
            const l = left;
            const r = parseUnary();
            left = times ? (c) => l(c) * r(c) : (c) => l(c) / r(c);
        }
        return left;
    }

    function parseUnary() {
        if (isOp('-')) {
            i++;
            const inner = parseUnary();
            return (c) => -inner(c);
        }
        return parsePrimary();
    }

    function parsePrimary() {
        const tok = tokens[i];
        if (!tok) throw new Error('expression ended unexpectedly');
        if (tok.t === 'num') {
            i++;
            return () => tok.v;
        }
        if (tok.t === 'id') {
            i++;
            return (c) => c.resolve(tok.v);
        }
        if (isOp('(')) {
            i++;
            const inner = parseOr();
            if (!isOp(')')) throw new Error("missing ')'");
            i++;
            return inner;
        }
        throw new Error(`unexpected '${tok.v}'`);
    }

    const expr = parseOr();
    if (i < tokens.length) throw new Error(`unexpected '${tokens[i].v}'`);
    return expr;
}

// ---------- Script parsing ----------

const ANCHORS = ['you', 'victim', 'this'];

function splitArgs(argText) {
    return argText.split(',').map((part) => part.trim());
}

function parseTargetArgs(argText) {
    const parts = splitArgs(argText);
    const target = parts[0].toLowerCase();
    if (target !== 'you' && target !== 'victim') {
        throw new Error(`target must be 'you' or 'victim', got '${parts[0]}'`);
    }
    if (parts.length > 2) throw new Error('too many arguments');
    const amount = parts.length === 2 ? compileExpression(parts[1]) : null;
    return { target, amount };
}

function parsePlaceArgs(argText) {
    const parts = splitArgs(argText);
    if (parts.length > 3) throw new Error('too many arguments');
    if (!parts[0]) throw new Error('missing the prop name');
    let anchor = null;
    if (parts[1]) {
        anchor = parts[1].toLowerCase();
        if (!ANCHORS.includes(anchor)) {
            throw new Error(`the anchor must be 'you', 'victim' or 'this', got '${parts[1]}'`);
        }
    }
    const distance = parts[2] ? compileExpression(parts[2]) : null;
    return { name: parts[0], anchor, distance };
}

function parseShootArgs(argText) {
    const parts = splitArgs(argText);
    if (parts.length > 3) throw new Error('too many arguments');
    if (!parts[0]) throw new Error('missing the prop name');
    const speed = parts[1] ? compileExpression(parts[1]) : null;
    const angle = parts[2] ? compileExpression(parts[2]) : null;
    return { name: parts[0], speed, angle };
}

function parseDeleteArgs(argText) {
    const name = argText.trim();
    if (!name) throw new Error('missing the prop name');
    if (name.includes(',')) throw new Error("delete takes one name: 'this', 'all', or a prop name");
    if (name.toLowerCase() === 'this') return { which: 'this', name: null };
    if (name.toLowerCase() === 'all') return { which: 'all', name: null };
    return { which: 'named', name };
}

function parseBlastArgs(argText) {
    const parts = splitArgs(argText);
    if (parts.length > 2) throw new Error('too many arguments');
    if (!parts[0]) throw new Error('missing the radius');
    let includeOwner = false;
    if (parts[1]) {
        if (parts[1].toLowerCase() !== 'all') {
            throw new Error(`the second argument can only be 'all', got '${parts[1]}'`);
        }
        includeOwner = true;
    }
    return { radius: compileExpression(parts[0]), includeOwner };
}

// lines: [{ text, lineNo }]. Bad lines are reported through warn() and skipped.
function parseScript(lines, warn) {
    const root = [];
    // Each frame is the block currently being filled. Frames for an if/else or a blast
    // also remember their node so "else" can switch blocks.
    const stack = [{ node: null, block: root, inElse: false }];

    for (const { text, lineNo } of lines) {
        const line = text.trim();
        if (!line || line.startsWith('#')) continue;
        const frame = stack[stack.length - 1];
        let m;

        const add = (node) => frame.block.push({ ...node, line: lineNo });
        const open = (type, build) => {
            let node;
            try {
                node = build();
            } catch (err) {
                // Keep the matching "end" balanced even though this block is unusable.
                stack.push({ node: null, block: [], inElse: false });
                throw err;
            }
            node.type = type;
            node.line = lineNo;
            frame.block.push(node);
            stack.push({ node, block: type === 'if' ? node.then : node.body, inElse: false });
        };

        try {
            if ((m = line.match(/^if\s*\[(.*)\]$/i))) {
                open('if', () => ({ cond: compileExpression(m[1]), then: [], else: [] }));
            } else if ((m = line.match(/^blast\s*\[(.*)\]$/i))) {
                open('blast', () => ({ ...parseBlastArgs(m[1]), body: [] }));
            } else if (/^else$/i.test(line)) {
                if (stack.length === 1) throw new Error("'else' without a matching if");
                if (frame.node && frame.node.type !== 'if') throw new Error("'else' only works inside an if");
                if (frame.inElse) throw new Error("duplicate 'else'");
                frame.inElse = true;
                frame.block = frame.node ? frame.node.else : [];
            } else if (/^end$/i.test(line)) {
                if (stack.length === 1) throw new Error("'end' without a matching if or blast");
                stack.pop();
            } else if ((m = line.match(/^wait\s*\[(.*)\]$/i))) {
                add({ type: 'wait', seconds: compileExpression(m[1]) });
            } else if ((m = line.match(/^sustain\s+damage\s*\[(.*)\]$/i))) {
                add({ type: 'damage', ...parseTargetArgs(m[1]) });
            } else if ((m = line.match(/^knockback\s*\[(.*)\]$/i))) {
                add({ type: 'knockback', ...parseTargetArgs(m[1]) });
            } else if ((m = line.match(/^place\s+prop\s*\[(.*)\]$/i))) {
                add({ type: 'place', ...parsePlaceArgs(m[1]) });
            } else if ((m = line.match(/^shoot\s+prop\s*\[(.*)\]$/i))) {
                add({ type: 'shoot', ...parseShootArgs(m[1]) });
            } else if ((m = line.match(/^delete\s+prop\s*\[(.*)\]$/i))) {
                add({ type: 'delete', ...parseDeleteArgs(m[1]) });
            } else {
                throw new Error(`unknown command '${line}'`);
            }
        } catch (err) {
            warn(`line ${lineNo}: ${err.message}`);
        }
    }

    if (stack.length > 1) warn(`missing 'end' for ${stack.length - 1} block(s)`);
    return root;
}

// Every prop a script places, shoots or deletes by name, so the server can check
// the names exist when it loads.
function findPropReferences(script) {
    const found = [];
    (function walk(block) {
        for (const node of block) {
            if (node.type === 'place' || node.type === 'shoot') {
                found.push({ name: node.name, line: node.line, command: node.type });
            } else if (node.type === 'delete' && node.which === 'named') {
                found.push({ name: node.name, line: node.line, command: 'delete' });
            } else if (node.type === 'if') {
                walk(node.then);
                walk(node.else);
            } else if (node.type === 'blast') {
                walk(node.body);
            }
        }
    })(script || []);
    return found;
}

// ---------- class_info.txt and prop_info.txt ----------

// Returns { stats, hooks }. stats values are numbers where they look like numbers,
// otherwise strings. hooks maps a hook name such as "on_hit" to its parsed script.
function parseInfoFile(text, warn, allowedHooks) {
    const stats = {};
    const hookLines = {};
    let section = 'stats';

    text.split(/\r?\n/).forEach((raw, idx) => {
        const lineNo = idx + 1;
        const line = raw.trim();
        if (!line || line.startsWith('#')) return;

        const header = line.match(/^(on_[a-z_]+)\s*:$/i);
        if (header) {
            const hook = header[1].toLowerCase();
            if (!allowedHooks.includes(hook)) {
                section = 'ignore';
                warn(`line ${lineNo}: unknown hook '${hook}' (here you can use: ${allowedHooks.join(', ')})`);
            } else {
                if (hookLines[hook]) warn(`line ${lineNo}: '${hook}' appears twice, the later one is used`);
                hookLines[hook] = [];
                section = hook;
            }
            return;
        }

        if (section === 'ignore') return;
        if (section !== 'stats') {
            hookLines[section].push({ text: line, lineNo });
            return;
        }

        const m = line.match(/^([^:=]+)[:=](.*)$/);
        if (!m) {
            warn(`line ${lineNo}: expected "key: value", got '${line}'`);
            return;
        }
        const key = m[1].trim().toLowerCase().replace(/\s+/g, '');
        const value = m[2].trim();
        const num = Number(value);
        stats[key] = value !== '' && Number.isFinite(num) ? num : value;
    });

    const hooks = {};
    for (const hook of Object.keys(hookLines)) {
        hooks[hook] = hookLines[hook].length > 0
        ? parseScript(hookLines[hook], (message) => warn(`${hook}: ${message}`))
        : null;
    }
    return { stats, hooks };
}

function parseClassInfo(text, warn = () => {}) {
    const info = parseInfoFile(text, warn, ['on_hit', 'on_attack']);
    return { stats: info.stats, hooks: info.hooks, script: info.hooks.on_hit || null };
}

function parsePropInfo(text, warn = () => {}) {
    return parseInfoFile(text, warn, ['on_spawn', 'on_touch', 'on_stay', 'on_expire']);
}

// ---------- Running ----------

const warnedOnce = new Set();
function warnOnce(env, message) {
    const key = `${env.label || ''}|${message}`;
    if (warnedOnce.has(key)) return;
    warnedOnce.add(key);
    if (env.warn) env.warn(message);
}

// Lets problems in a script that was fixed (or broke again) be reported afresh.
function resetWarnings() {
    warnedOnce.clear();
}

const cleanAmount = (n) => (Number.isFinite(n) ? Math.max(0, n) : 0);
const finiteOr = (n, fallback) => (Number.isFinite(n) ? n : fallback);

function readPlayerValue(env, p, key) {
    switch (key) {
        case 'health': return p.health;
        case 'maxhealth': return p.maxHealth;
        case 'x': return p.x;
        case 'y': return p.y;
        case 'angle': return (p.aimAngle || 0) * RAD_TO_DEG;
        case 'isdead': return p.isDead ? 1 : 0;
        case 'props': return env.actions.countProps ? env.actions.countProps(p) : 0;
        default: {
            const v = p.stats ? p.stats[key] : undefined;
            return typeof v === 'number' ? v : undefined;
        }
    }
}

function readPropValue(prop, key) {
    switch (key) {
        case 'x': return prop.x;
        case 'y': return prop.y;
        case 'angle': return (prop.angle || 0) * RAD_TO_DEG;
        case 'size': return prop.size;
        case 'age': return (Date.now() - prop.born) / 1000;
        case 'life': return prop.expiresAt ? Math.max(0, (prop.expiresAt - Date.now()) / 1000) : 0;
        default: {
            const v = prop.stats ? prop.stats[key] : undefined;
            return typeof v === 'number' ? v : undefined;
        }
    }
}

function makeContext(run) {
    return {
        resolve(name) {
            const env = run.env;

            if (name === 'distance') {
                const from = env.prop || env.you;
                if (!env.victim) {
                    warnOnce(env, "'distance' needs a victim, and this hook doesn't have one");
                    return 0;
                }
                return Math.hypot(env.victim.x - from.x, env.victim.y - from.y);
            }

            let prefix = 'you';
            let key = name;
            const dot = name.indexOf('.');
            if (dot !== -1) {
                prefix = name.slice(0, dot);
                key = name.slice(dot + 1);
            }

            let who;
            if (prefix === 'you') who = env.you;
            else if (prefix === 'victim') who = env.victim;
            else if (prefix === 'this') who = env.prop;
            else {
                warnOnce(env, `unknown variable '${name}'`);
                return 0;
            }
            if (!who) {
                warnOnce(env, `'${prefix}' is not available in this hook (used in '${name}')`);
                return 0;
            }

            const value = prefix === 'this' ? readPropValue(who, key) : readPlayerValue(env, who, key);
            if (value === undefined) {
                warnOnce(env, `unknown variable '${name}'`);
                return 0;
            }
            return value;
        }
    };
}

// A script run that can be paused. env is:
//   you      the owner (a player)       victim  the player affected, or null
//   prop     the prop running it, or null
//   label    a name for warnings        warn    function(message)
//   actions  what the game does for each command (see server.js)
function createRun(script, env) {
    const run = { stack: [{ block: script || [], i: 0 }], env, wakeAt: 0, done: false };
    run.ctx = makeContext(run);
    return run;
}

function nextBlastVictim(frame, env) {
    while (frame.vi < frame.victims.length) {
        const candidate = frame.victims[frame.vi++];
        if (env.actions.isLive(candidate)) {
            env.victim = candidate;
            return true;
        }
    }
    return false;
}

// Runs the script until it finishes or reaches a wait. Returns true when finished.
// Call it again once `now` reaches run.wakeAt to carry on.
function advance(run, now = Date.now()) {
    if (run.done) return true;
    if (now < run.wakeAt) return false;

    const env = run.env;
    const ctx = run.ctx;
    const stack = run.stack;
    const subject = () => env.prop || env.you;
    const entity = (which) => (which === 'you' ? env.you : which === 'victim' ? env.victim : env.prop);
    let steps = 0;

    while (stack.length > 0) {
        if (++steps > MAX_STEPS_PER_ADVANCE) {
            warnOnce(env, 'this script did too much at once and was stopped');
            run.done = true;
            return true;
        }

        const frame = stack[stack.length - 1];
        if (frame.i >= frame.block.length) {
            if (frame.blast) {
                if (nextBlastVictim(frame, env)) {
                    frame.i = 0; // run the body again for the next player
                    continue;
                }
                env.victim = frame.savedVictim;
            }
            stack.pop();
            continue;
        }

        const node = frame.block[frame.i++];

        if (node.type === 'if') {
            const branch = node.cond(ctx) ? node.then : node.else;
            if (branch.length > 0) stack.push({ block: branch, i: 0 });
        } else if (node.type === 'wait') {
            const seconds = Math.min(MAX_WAIT_SECONDS, cleanAmount(node.seconds(ctx)));
            run.wakeAt = now + seconds * 1000;
            return false;
        } else if (node.type === 'damage') {
            const who = entity(node.target);
            if (!who) {
                warnOnce(env, `'${node.target}' is not available in this hook (line ${node.line})`);
                continue;
            }
            const propDamage = env.prop && env.prop.stats && typeof env.prop.stats.damage === 'number'
            ? env.prop.stats.damage
            : null;
            const amount = node.amount ? node.amount(ctx) : (propDamage !== null ? propDamage : env.you.damage);
            env.actions.damage(who, cleanAmount(amount));
        } else if (node.type === 'knockback') {
            const who = entity(node.target);
            if (!who) {
                warnOnce(env, `'${node.target}' is not available in this hook (line ${node.line})`);
                continue;
            }
            // Pushed away from the prop if there is one, otherwise from the other player.
            const from = node.target === 'victim' ? subject() : (env.prop || env.victim || null);
            let fallback = DEFAULT_KNOCKBACK;
            if (env.prop && env.prop.stats && typeof env.prop.stats.knockback === 'number') {
                fallback = env.prop.stats.knockback;
            } else if (env.you.stats && typeof env.you.stats.knockback === 'number') {
                fallback = env.you.stats.knockback;
            }
            const amount = node.amount ? node.amount(ctx) : fallback;
            env.actions.knockback(who, from, cleanAmount(amount));
        } else if (node.type === 'place') {
            const anchor = node.anchor ? entity(node.anchor) : subject();
            if (!anchor) {
                warnOnce(env, `'${node.anchor}' is not available in this hook (line ${node.line})`);
                continue;
            }
            env.actions.place({
                name: node.name,
                anchor,
                distance: node.distance ? finiteOr(node.distance(ctx), 0) : 0,
                              owner: env.you,
                              label: env.label
            });
        } else if (node.type === 'shoot') {
            env.actions.shoot({
                name: node.name,
                shooter: subject(),
                              speed: node.speed ? cleanAmount(node.speed(ctx)) : null,
                              angleOffset: node.angle ? finiteOr(node.angle(ctx), 0) : 0,
                              owner: env.you,
                              label: env.label
            });
        } else if (node.type === 'delete') {
            env.actions.deleteProps({ which: node.which, name: node.name, owner: env.you, prop: env.prop });
        } else if (node.type === 'blast') {
            if (node.body.length === 0) continue;
            const center = subject();
            const radius = cleanAmount(node.radius(ctx));
            const victims = env.actions.playersInRadius(center, radius, node.includeOwner ? null : env.you);
            const blastFrame = { block: node.body, i: 0, blast: true, victims, vi: 0, savedVictim: env.victim };
            if (nextBlastVictim(blastFrame, env)) stack.push(blastFrame);
        }
    }

    run.done = true;
    return true;
}

// Runs a script straight away (up to its first wait). Returns the run so the caller can
// keep advancing it if it paused.
function runScript(script, env) {
    const run = createRun(script, env);
    advance(run, Date.now());
    return run;
}

module.exports = { parseClassInfo, parsePropInfo, createRun, advance, runScript, findPropReferences, resetWarnings };
