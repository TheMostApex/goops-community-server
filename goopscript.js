// --------------------------------------------------
// GoopScript
// --------------------------------------------------
// A tiny scripting language for class behavior, written inside a class's
// class_info.txt. Stats come first as "key: value" lines. The first
// "on_hit:" line starts the script, which runs once for every victim an
// attack lands on:
//
//   on_hit:
//     if[victim.health <= damage * 2]
//       sustain damage[victim, damage * 3]
//     else
//       sustain damage[victim]
//       knockback[victim]
//     end
//     knockback[you, 10]
//
// Commands
//   if[condition] ... else ... end   "else" is optional; ifs can nest
//   sustain damage[TARGET]           TARGET takes damage (default: your damage stat)
//   sustain damage[TARGET, amount]
//   knockback[TARGET]                TARGET is shoved away from the other party
//   knockback[TARGET, amount]        (default: your "knockback" stat, else 20)
//
// TARGET is "you" (the attacker) or "victim" (the player being hit).
//
// Conditions and amounts are math expressions: numbers, + - * /, parentheses,
// comparisons (< > <= >= == !=), and, or, not.
//
// Variables: you.health  you.maxhealth  you.x  you.y  you.isdead
//            victim.<same>  distance (between the two players)
//            any numeric stat from class_info.txt, e.g. you.damage, you.knockback
//            a bare name such as "damage" means you.damage
//
// Scripts have no loops, so they always finish. Nothing is ever eval'd.

'use strict';

const DEFAULT_KNOCKBACK = 20;

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

function parseTargetArgs(argText) {
    const parts = argText.split(',');
    const target = parts[0].trim().toLowerCase();
    if (target !== 'you' && target !== 'victim') {
        throw new Error(`target must be 'you' or 'victim', got '${parts[0].trim()}'`);
    }
    if (parts.length > 2) throw new Error('too many arguments');
    const amount = parts.length === 2 ? compileExpression(parts[1]) : null;
    return { target, amount };
}

// lines: [{ text, lineNo }]. Bad lines are reported through warn() and skipped.
function parseScript(lines, warn) {
    const root = [];
    // Each frame is the block currently being filled. Frames for an if/else
    // also remember their node so "else" can switch blocks.
    const stack = [{ node: null, block: root, inElse: false }];

    for (const { text, lineNo } of lines) {
        const line = text.trim();
        if (!line || line.startsWith('#')) continue;
        const frame = stack[stack.length - 1];
        let m;

        try {
            if ((m = line.match(/^if\s*\[(.*)\]$/i))) {
                let cond;
                try {
                    cond = compileExpression(m[1]);
                } catch (err) {
                    // Keep the matching "end" balanced even though this if is unusable.
                    stack.push({ node: null, block: [], inElse: false });
                    throw err;
                }
                const node = { type: 'if', cond, then: [], else: [] };
                frame.block.push(node);
                stack.push({ node, block: node.then, inElse: false });
            } else if (/^else$/i.test(line)) {
                if (stack.length === 1) throw new Error("'else' without a matching if");
                if (frame.inElse) throw new Error("duplicate 'else'");
                frame.inElse = true;
                frame.block = frame.node ? frame.node.else : [];
            } else if (/^end$/i.test(line)) {
                if (stack.length === 1) throw new Error("'end' without a matching if");
                stack.pop();
            } else if ((m = line.match(/^sustain\s+damage\s*\[(.*)\]$/i))) {
                frame.block.push({ type: 'damage', ...parseTargetArgs(m[1]) });
            } else if ((m = line.match(/^knockback\s*\[(.*)\]$/i))) {
                frame.block.push({ type: 'knockback', ...parseTargetArgs(m[1]) });
            } else {
                throw new Error(`unknown command '${line}'`);
            }
        } catch (err) {
            warn(`line ${lineNo}: ${err.message}`);
        }
    }

    if (stack.length > 1) warn(`missing 'end' for ${stack.length - 1} if block(s)`);
    return root;
}

// ---------- class_info.txt ----------

// Returns { stats, script }. stats values are numbers where they look like
// numbers, otherwise strings. script is null when the class has no on_hit block.
function parseClassInfo(text, warn = () => {}) {
    const stats = {};
    const scriptLines = [];
    let section = 'stats';

    text.split(/\r?\n/).forEach((raw, idx) => {
        const lineNo = idx + 1;
        const line = raw.trim();
        if (!line || line.startsWith('#')) return;

        const hook = line.match(/^on_([a-z_]+)\s*:$/i);
        if (hook) {
            if (hook[1].toLowerCase() === 'hit') {
                section = 'hit';
            } else {
                section = 'ignore';
                warn(`line ${lineNo}: unknown hook 'on_${hook[1]}' (only on_hit exists)`);
            }
            return;
        }

        if (section === 'hit') {
            scriptLines.push({ text: line, lineNo });
            return;
        }
        if (section === 'ignore') return;

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

    const script = scriptLines.length > 0 ? parseScript(scriptLines, warn) : null;
    return { stats, script };
}

// ---------- Running ----------

const warnedOnce = new Set();
function warnOnce(warn, message) {
    if (warnedOnce.has(message)) return;
    warnedOnce.add(message);
    warn(message);
}

function readStat(p, key) {
    switch (key) {
        case 'health': return p.health;
        case 'maxhealth': return p.maxHealth;
        case 'x': return p.x;
        case 'y': return p.y;
        case 'isdead': return p.isDead ? 1 : 0;
        default: {
            const v = p.stats ? p.stats[key] : undefined;
            return typeof v === 'number' ? v : undefined;
        }
    }
}

const cleanAmount = (n) => (Number.isFinite(n) ? Math.max(0, n) : 0);

// Runs a parsed script for one attacker/victim pair. The script never touches
// game state directly - it calls actions.damage(player, amount) and
// actions.knockback(player, awayFromPlayer, amount) and the game applies them.
function runScript(script, { you, victim, distance, actions, warn = () => {} }) {
    const ctx = {
        resolve(name) {
            if (name === 'distance') return distance;

            let who = you;
            let key = name;
            const dot = name.indexOf('.');
            if (dot !== -1) {
                const prefix = name.slice(0, dot);
                key = name.slice(dot + 1);
                if (prefix === 'you') who = you;
                else if (prefix === 'victim') who = victim;
                else {
                    warnOnce(warn, `unknown variable '${name}'`);
                    return 0;
                }
            }

            const value = readStat(who, key);
            if (value === undefined) {
                warnOnce(warn, `unknown variable '${name}'`);
                return 0;
            }
            return value;
        }
    };

    (function exec(block) {
        for (const node of block) {
            if (node.type === 'if') {
                exec(node.cond(ctx) ? node.then : node.else);
            } else if (node.type === 'damage') {
                const who = node.target === 'you' ? you : victim;
                const amount = node.amount ? node.amount(ctx) : you.damage;
                actions.damage(who, cleanAmount(amount));
            } else if (node.type === 'knockback') {
                const who = node.target === 'you' ? you : victim;
                const from = node.target === 'you' ? victim : you;
                const fallback = you.stats && typeof you.stats.knockback === 'number'
                    ? you.stats.knockback
                    : DEFAULT_KNOCKBACK;
                const amount = node.amount ? node.amount(ctx) : fallback;
                actions.knockback(who, from, cleanAmount(amount));
            }
        }
    })(script);
}

module.exports = { parseClassInfo, runScript };
