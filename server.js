// --------------------------------------------------
// Goops - Authoritative Game Server
// --------------------------------------------------
// Serves the static game files and runs the real-time
// game loop. The server is the single source of truth
// for player positions, movement, and combat - clients
// only ever send input and receive state.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const goopscript = require('./goopscript');

// --------------------------------------------------
// Community mode
// --------------------------------------------------
// A community.json next to this file turns the server into a community server:
// one permanent arena that people join by address (no room codes), with a name
// and message of the day on the lobby screen. No community.json = the normal site.
const COMMUNITY_ROOM = 'community';

function loadCommunityConfig() {
    let raw;
    try {
        raw = fs.readFileSync(path.join(__dirname, 'community.json'), 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        console.error(`[config] could not read community.json: ${err.message}`);
        process.exit(1);
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        console.error(`[config] community.json is not valid JSON: ${err.message}`);
        process.exit(1);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.error('[config] community.json must contain a JSON object like { "name": "My Server" }');
        process.exit(1);
    }

    const clamp = (value, fallback, min, max) => {
        const n = Number(value);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    let mainSite = null;
    if (typeof parsed.mainSite === 'string' && parsed.mainSite.trim() !== '') {
        mainSite = parsed.mainSite.trim().replace(/\/+$/, '');
        if (!/^https?:\/\/[^\s]+$/i.test(mainSite)) {
            console.error('[config] community.json: "mainSite" must start with http:// or https:// (or leave it out to stay on your own network)');
            process.exit(1);
        }
    }

    return {
        name: String(parsed.name || 'Goops Community Server').slice(0, 40),
        motd: String(parsed.motd || '').slice(0, 200),
        port: parsed.port === undefined ? null : Math.floor(clamp(parsed.port, 3000, 0, 65535)),
        maxPlayers: Math.floor(clamp(parsed.maxPlayers, 8, 1, 32)),
        roundMinutes: clamp(parsed.roundMinutes, 5, 0.5, 120),
        mainSite,                      // e.g. https://goops.wasmer.app, or null to stay on your own network
        listed: parsed.listed !== false // false = reachable by code only, not shown in the server list
    };
}

const communityConfig = loadCommunityConfig();
const COMMUNITY_MODE = communityConfig !== null;

// A community server that has connected to the main site (see "Relay link" near the bottom).
let relayLink = null;          // socket.io-client connection to the main site's /host namespace
let relayRegistered = false;   // true once the main site has accepted this server
const relaySockets = new Map(); // playerId -> stand-in socket for a player being relayed

// Sends to everyone in a room: local sockets through Socket.io, plus, on a community
// server connected to the main site, the players being relayed through it.
function broadcastToRoom(room, event, data) {
    io.to(room).emit(event, data);
    if (room === COMMUNITY_ROOM && relayRegistered && relaySockets.size > 0) {
        relayLink.emit('broadcast', { event, data });
    }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const envPort = process.env.PORT;
const PORT = envPort !== undefined && envPort !== '' && Number.isFinite(Number(envPort))
? Number(envPort)
: ((communityConfig && communityConfig.port) || 3000);
const TICK_RATE_MS = 33; // ~30 updates per second
const MAX_PLAYERS_PER_ROOM = COMMUNITY_MODE ? communityConfig.maxPlayers : 4;

// Rooms live in this process's memory only. If a host runs more than one copy of the
// server (or restarts it), a room made on one copy doesn't exist on the other. The
// instance id below makes that visible: reload /healthz a few times and see if it changes.
const INSTANCE_ID = Math.random().toString(36).slice(2, 8);

// Quick check that the server process is up (open /healthz in a browser).
app.get('/healthz', (req, res) => res.json({
    ok: true,
    instance: INSTANCE_ID,
    rooms: Object.keys(rooms).length,
                                           uptimeSeconds: Math.round(process.uptime())
}));

// Lets the lobby page know which kind of server it's talking to.
app.get('/server-info', (req, res) => {
    const arena = rooms[COMMUNITY_ROOM];
    res.json({
        mode: COMMUNITY_MODE ? 'community' : 'main',
        name: COMMUNITY_MODE ? communityConfig.name : 'Goops',
        motd: COMMUNITY_MODE ? communityConfig.motd : '',
        online: arena ? Object.keys(arena.players).length : 0,
             maxPlayers: MAX_PLAYERS_PER_ROOM
    });
});

// The class list the page loads. Built by the server (and the classes re-read) every time
// someone opens the page, so dropping a new folder into classes/ shows up on the next
// refresh with no restart and no list.txt to maintain.
function safeReload() {
    try {
        reloadContent();
    } catch (err) {
        console.warn('[content] reload failed:', err.message);
    }
}

app.get('/classes/list.txt', (req, res) => {
    safeReload();
    res.type('text/plain').send(Object.keys(classRegistry).join('\n') + '\n');
});

// The same for props. props/ is optional, so a missing folder is just an empty list.
app.get('/props/list.txt', (req, res) => {
    safeReload();
    res.type('text/plain').send(Object.keys(propRegistry).join('\n') + '\n');
});

// --------------------------------------------------
// Main site: community server relay
// --------------------------------------------------
// Community servers connect OUT to this site (the /host namespace) and register themselves.
// Players pick a server from the list, or type its code, and play through this site: it
// passes their input to the server and the server's game state back to them. Because the
// server dials out, it needs no port forwarding and no public address.
// The registry is held in memory in this one process.
const hosts = new Map(); // code -> { socket, keyHash, name, motd, maxPlayers, online, listed }
const MAX_REMOTE_SERVERS = 100;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike characters
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ASSET_TYPES = { '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };
const assetCache = new Map(); // "CODE/path" -> { body, type, expires }

// A server's code is worked out from its key, so it stays the same every time it connects.
function codeFromKeyHash(keyHash) {
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += CODE_CHARS[parseInt(keyHash.slice(i * 2, i * 2 + 2), 16) % CODE_CHARS.length];
    }
    return code;
}

function publicServerInfo(code, host) {
    return { code, name: host.name, motd: host.motd, online: host.online, maxPlayers: host.maxPlayers };
}

app.get('/servers', (req, res) => {
    const list = [...hosts.entries()]
    .filter(([, host]) => host.listed)
    .map(([code, host]) => publicServerInfo(code, host))
    .sort((a, b) => b.online - a.online);
    res.json(list);
});

app.get('/servers/:code', (req, res) => {
    const code = String(req.params.code || '').toUpperCase();
    const host = hosts.get(code);
    if (!host) return res.status(404).json({ error: 'No server with that code is online.' });
    res.json(publicServerInfo(code, host));
});

function toBuffer(value) {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (typeof value === 'string') return Buffer.from(value);
    return null;
}

// A community server's class images and stat files, fetched through its link to this site.
// Only .png and .txt files are passed on, always labelled as such, so a server can't use
// this site to serve a web page or script from this site's address.
function sendAsset(res, type, body) {
    res.set({
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'public, max-age=30'
    });
    res.send(body);
}

// kind is 'classes' or 'props'. Props need a community server new enough to have them.
function relayAsset(kind) {
    return (req, res) => {
        const code = String(req.params.code || '').toUpperCase();
        const host = hosts.get(code);
        const filePath = String(req.params[0] || '');
        const ext = path.extname(filePath).toLowerCase();
        const allowed = kind === 'props' ? (ext === '.png' || filePath === 'list.txt') : !!ASSET_TYPES[ext];
        if (!host || !allowed || (kind === 'props' && host.version < 2)) return res.status(404).end();

        const cacheKey = `${code}/${kind}/${filePath}`;
        const cached = assetCache.get(cacheKey);
        if (cached && cached.expires > Date.now()) return sendAsset(res, cached.type, cached.body);

        host.socket.timeout(5000).emit('fetch-file', { kind, path: filePath }, (err, reply) => {
            if (err) return res.status(504).end();
            const body = reply && reply.ok ? toBuffer(reply.body) : null;
            if (!body) return res.status(404).end();
            if (body.length > MAX_ASSET_BYTES) return res.status(413).end();
            if (ext === '.png' && !body.subarray(0, 8).equals(PNG_SIGNATURE)) return res.status(415).end();

            if (assetCache.size > 500) assetCache.clear();
            assetCache.set(cacheKey, { body, type: ASSET_TYPES[ext], expires: Date.now() + 30000 });
            sendAsset(res, ASSET_TYPES[ext], body);
        });
    };
}

app.get('/s/:code/classes/*', relayAsset('classes'));
app.get('/s/:code/props/*', relayAsset('props'));

// Passes a relayed player's message up to the server they chose.
function forwardToHost(socket, event, data) {
    const host = hosts.get(socket.data.remoteServer);
    if (!host) return;
    if (event === 'input') {
        const now = Date.now();
        if (now - (socket.data.lastInputAt || 0) < 20) return; // limit how fast one player can send
        socket.data.lastInputAt = now;
    }
    host.socket.emit('player-event', { playerId: socket.id, event, data });
}

function closeHost(code, reason) {
    const host = hosts.get(code);
    if (!host) return;
    hosts.delete(code);

    for (const player of io.sockets.sockets.values()) {
        if (player.data.remoteServer === code) {
            player.data.remoteServer = null;
            player.leave('remote:' + code);
            player.emit('server-closed', { reason });
        }
    }
    try { host.socket.disconnect(true); } catch (err) { /* already gone */ }
    console.log(`[relay] server ${code} "${host.name}" removed (${reason}), ${hosts.size} online`);
}

function setupHostNamespace() {
    io.of('/host').on('connection', (socket) => {
        let myCode = null;
        const mine = () => (myCode && hosts.get(myCode) && hosts.get(myCode).socket === socket ? hosts.get(myCode) : null);

        socket.on('register', (info, ack) => {
            if (typeof ack !== 'function') return;
            const keyHash = info && typeof info.keyHash === 'string' ? info.keyHash : '';
            if (!/^[a-f0-9]{64}$/.test(keyHash)) return ack({ ok: false, message: 'Invalid server key.' });

            const code = codeFromKeyHash(keyHash);
            const existing = hosts.get(code);
            if (existing && existing.keyHash !== keyHash) {
                return ack({ ok: false, message: 'Server code collision. Delete server.key and restart to get a new code.' });
            }
            if (!existing && hosts.size >= MAX_REMOTE_SERVERS) {
                return ack({ ok: false, message: 'The server list is full. Try again later.' });
            }
            if (existing) closeHost(code, 'replaced by a new connection');

            const clampInt = (value, fallback, min, max) => {
                const n = Math.floor(Number(value));
                return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
            };
            hosts.set(code, {
                socket,
                keyHash,
                name: String(info.name || 'Unnamed Server').slice(0, 40),
                      motd: String(info.motd || '').slice(0, 200),
                      maxPlayers: clampInt(info.maxPlayers, 8, 1, 32),
                      version: clampInt(info.version, 1, 1, 99), // 1 = no props
                      online: 0,
                      listed: info.listed !== false
            });
            myCode = code;
            console.log(`[relay] server ${code} "${hosts.get(code).name}" connected (${hosts.size} online)`);
            ack({ ok: true, code });
        });

        socket.on('status', (data) => {
            const host = mine();
            if (!host) return;
            const online = Math.floor(Number(data && data.online));
            if (Number.isFinite(online)) host.online = Math.min(host.maxPlayers, Math.max(0, online));
        });

            // The only replies a server may send to one player. Anything else is ignored.
            socket.on('to-player', (msg) => {
                const host = mine();
                if (!host || !msg || typeof msg.playerId !== 'string') return;
                const player = io.sockets.sockets.get(msg.playerId);
                if (!player || player.data.remoteServer !== myCode) return; // only its own players
                const data = msg.data && typeof msg.data === 'object' ? msg.data : {};

                if (msg.event === 'joined') {
                    player.join('remote:' + myCode);
                    player.emit('joined', { code: myCode, serverName: String(data.serverName || host.name).slice(0, 40) });
                } else if (msg.event === 'join-error') {
                    player.data.remoteServer = null;
                    player.emit('join-error', { message: String(data.message || 'Could not join.').slice(0, 100) });
                }
            });

            // The only thing a server may broadcast is the game state.
            socket.on('broadcast', (msg) => {
                if (!mine() || !msg || msg.event !== 'state-update') return;
                if (!msg.data || typeof msg.data !== 'object') return;
                io.to('remote:' + myCode).emit('state-update', msg.data);
            });

            socket.on('disconnect', () => {
                if (mine()) closeHost(myCode, 'went offline');
            });
    });
}

if (!COMMUNITY_MODE) setupHostNamespace();

// Serve all static files (index.html, game.js, load_classes.js, classes/) from this directory.
app.use(express.static(__dirname));

// --------------------------------------------------
// Room / lobby management
// --------------------------------------------------
// rooms[code] = {
//   hostSocketId: string,
//   players: { [socketId]: playerState },
//   intervalHandle: NodeJS.Timeout
// }
const rooms = {};

function makeRoomCode() {
    let code;
    do {
        code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (rooms[code]); // avoid collisions with active rooms
    return code;
}

function createRoom(code, hostSocketId, persistent = false) {
    const room = {
        hostSocketId,
        players: {},
        intervalHandle: null,
        persistent, // a persistent room (the community arena) stays open when everyone leaves
        props: new Map(),   // id -> prop currently in the arena
        nextPropId: 1,
        tasks: [],          // GoopScript runs that are paused in a wait
        actions: null,      // what script commands do in this room (built on first use)
        tickNow: 0,         // the time of the tick being processed
        roundEndsAt: Date.now() + ROUND_DURATION_MS,
        roundOver: false,
        nextRoundStartsAt: null
    };
    room.intervalHandle = setInterval(() => tickRoom(code), TICK_RATE_MS);
    rooms[code] = room;
    return room;
}

// --------------------------------------------------
// Class definitions
// --------------------------------------------------
// Read from the classes/ folder by the server itself, so a client can never
// claim stats or scripts it doesn't have. classRegistry[name] = { stats, script }
const classRegistry = {};

// classes/list.txt (one folder name per line) if it exists, otherwise every folder inside classes/.
function readClassNames(classesDir) {
    try {
        return fs.readFileSync(path.join(classesDir, 'list.txt'), 'utf8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    return fs.readdirSync(classesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort();
}

function loadClasses() {
    const classesDir = path.join(__dirname, 'classes');
    let names;
    try {
        names = readClassNames(classesDir);
    } catch (err) {
        console.warn('[classes] could not read the classes folder:', err.message);
        return; // keep whatever was loaded before
    }

    for (const key of Object.keys(classRegistry)) delete classRegistry[key];

    for (const name of names) {
        try {
            const dir = path.join(classesDir, name);
            const file = ['class_info.txt', 'attack_info.txt']
            .map(f => path.join(dir, f))
            .find(f => fs.existsSync(f));

            if (!file) {
                console.warn(`[classes] ${name}: no class_info.txt found, using default stats`);
                classRegistry[name] = { stats: {}, hooks: {}, script: null };
                continue;
            }
            if (path.basename(file) === 'attack_info.txt') {
                console.warn(`[classes] ${name}: attack_info.txt is the old name, rename it to class_info.txt`);
            }

            classRegistry[name] = goopscript.parseClassInfo(
                fs.readFileSync(file, 'utf8'),
                                                            (message) => console.warn(`[goopscript] ${name}: ${message}`)
            );
            const hookNames = Object.keys(classRegistry[name].hooks).filter(h => classRegistry[name].hooks[h]);
            logLoaded(`[classes] loaded ${name}${hookNames.length ? ' (' + hookNames.join(', ') + ')' : ''}`);
        } catch (err) {
            console.warn(`[classes] ${name}: could not load (${err.message}), using default stats`);
            classRegistry[name] = { stats: {}, hooks: {}, script: null };
        }
    }
}

// The "loaded" lines are only printed the first time. The content is re-read every time
// someone opens the page, and the console would otherwise fill up.
let contentLoadedBefore = false;
function logLoaded(message) {
    if (!contentLoadedBefore) console.log(message);
}

// --------------------------------------------------
// Prop definitions
// --------------------------------------------------
// One folder per prop inside props/: prop_info.txt (stats and GoopScript hooks) and
// prop.png. Found automatically, like classes. propRegistry[name] = a description of the prop.
const propRegistry = {};
const RESERVED_PROP_NAMES = new Set(['this', 'all']);
const WALL_MODES = ['vanish', 'stop', 'bounce'];

const truthy = (value) => value === 1 || /^(1|yes|true|on)$/i.test(String(value));
const clampNumber = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function describeProp(name, stats, hooks) {
    const walls = String(stats.walls || 'vanish').toLowerCase();
    return {
        name,
        stats,
        hooks,
        size: clampNumber(stats.size, 16, 2, 200),             // radius, in pixels
        speed: clampNumber(stats.speed, 8, 0, 60),             // pixels per tick when shot without a speed
        drag: clampNumber(stats.drag, 0, 0, 1),                // fraction of its speed lost every tick
        lifetimeMs: clampNumber(stats.lifetime, 0, 0, 3600) * 1000,
        armMs: clampNumber(stats.armdelay, 0, 0, 60) * 1000,
        stayMs: clampNumber(stats.stayinterval, 0.5, 0.1, 60) * 1000,
        touchOwner: truthy(stats.touchowner),
        walls: WALL_MODES.includes(walls) ? walls : 'vanish'
    };
}

function loadProps() {
    const propsDir = path.join(__dirname, 'props');
    let names;
    try {
        names = fs.readdirSync(propsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .sort();
    } catch (err) {
        if (err.code !== 'ENOENT') console.warn('[props] could not read the props folder:', err.message);
        names = [];
    }

    for (const key of Object.keys(propRegistry)) delete propRegistry[key];

    for (const name of names) {
        try {
            if (/[,\[\]]/.test(name) || RESERVED_PROP_NAMES.has(name.toLowerCase())) {
                console.warn(`[props] ${name}: skipped. A prop name can't contain , [ ] and can't be "this" or "all"`);
                continue;
            }

            let parsed = { stats: {}, hooks: {} };
            const file = path.join(propsDir, name, 'prop_info.txt');
            if (fs.existsSync(file)) {
                parsed = goopscript.parsePropInfo(
                    fs.readFileSync(file, 'utf8'),
                                                  (message) => console.warn(`[goopscript] prop ${name}: ${message}`)
                );
            }
            if (parsed.stats.walls !== undefined && !WALL_MODES.includes(String(parsed.stats.walls).toLowerCase())) {
                console.warn(`[props] ${name}: walls must be vanish, stop or bounce (using vanish)`);
            }

            propRegistry[name] = describeProp(name, parsed.stats, parsed.hooks);
            const hookNames = Object.keys(parsed.hooks).filter(h => parsed.hooks[h]);
            logLoaded(`[props] loaded ${name}${hookNames.length ? ' (' + hookNames.join(', ') + ')' : ''}`);
        } catch (err) {
            console.warn(`[props] ${name}: could not load (${err.message})`);
        }
    }
}

// Prop names are matched without regard to capital letters, so "mine" finds the Mine folder.
function findPropDef(name) {
    const lower = String(name || '').toLowerCase();
    for (const key of Object.keys(propRegistry)) {
        if (key.toLowerCase() === lower) return propRegistry[key];
    }
    return null;
}

// Catches typos in prop names when the server starts, instead of mid-game.
function validateScripts() {
    const check = (label, hooks) => {
        for (const [hookName, script] of Object.entries(hooks || {})) {
            for (const ref of goopscript.findPropReferences(script)) {
                if (!findPropDef(ref.name)) {
                    console.warn(`[goopscript] ${label}: ${hookName}: line ${ref.line}: there is no prop called "${ref.name}" in the props folder`);
                }
            }
        }
    };
    for (const [name, info] of Object.entries(classRegistry)) check(name, info.hooks);
    for (const [name, def] of Object.entries(propRegistry)) check(`prop ${name}`, def.hooks);
}

function reloadContent() {
    goopscript.resetWarnings();
    loadClasses();
    loadProps();
    validateScripts();
    contentLoadedBefore = true;
}

const numberOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);

function createPlayer(requestedClass) {
    const className = classRegistry[requestedClass]
    ? requestedClass
    : (Object.keys(classRegistry)[0] || 'Unknown');
    const stats = classRegistry[className] ? classRegistry[className].stats : {};
    const health = Math.max(1, numberOr(stats.health, 100));

    const player = {
        x: 400 + (Math.random() * 80 - 40),
        y: 300 + (Math.random() * 80 - 40),
        className,
        speed: numberOr(stats.speed, 4),
        range: numberOr(stats.range, 60),
        damage: numberOr(stats.damage, 10),
        health,
        maxHealth: health,
        isAttacking: false,
        attackTimer: 0,
        hasHitThisAttack: false,
        isDead: false,
        respawnAt: null,
        aimAngle: 0,
        target: null, // where the player clicked to walk to ({x, y}), or null
        kbx: 0, // knockback velocity, decays every tick
        kby: 0,
        keys: {} // last-known input state for this player
    };
    // Non-enumerable so the full stat sheet isn't re-sent to every client every tick.
    Object.defineProperty(player, 'stats', { value: stats, enumerable: false });
    return player;
}

const RESPAWN_DELAY_MS = 5000;
const ROUND_DURATION_MS = (COMMUNITY_MODE ? communityConfig.roundMinutes : 5) * 60 * 1000;
const ROUND_OVER_DISPLAY_MS = 5000; // pause on the "Round Over" screen before the next round

function respawnPlayer(p) {
    p.health = p.maxHealth;
    p.isDead = false;
    p.respawnAt = null;
    p.isAttacking = false;
    p.attackTimer = 0;
    p.hasHitThisAttack = false;
    p.kbx = 0;
    p.kby = 0;
    p.target = null;
    p.x = 400 + (Math.random() * 200 - 100);
    p.y = 300 + (Math.random() * 200 - 100);
}

const ATTACK_CONE_HALF_ANGLE = Math.PI / 4; // 45 degrees either side = 90 degree cone

function normalizeAngleDiff(diff) {
    // Wrap into [-PI, PI] so cone comparisons work across the -PI/PI boundary.
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return diff;
}

const KNOCKBACK_FRICTION = 0.85; // fraction of knockback velocity kept each tick

// --------------------------------------------------
// Props and script commands
// --------------------------------------------------
const ARENA_WIDTH = 800;
const ARENA_HEIGHT = 600;
const PLAYER_RADIUS = 16;
const MAX_PROPS_PER_ROOM = 150;
const MAX_PROPS_PER_PLAYER = 40;
const MAX_TASKS_PER_ROOM = 500;

const isMember = (room, player) => !!player && Object.values(room.players).includes(player);
const facingOf = (entity) => (typeof entity.aimAngle === 'number' ? entity.aimAngle : (entity.angle || 0));

const serverWarned = new Set();
function warnServerOnce(key, message) {
    if (serverWarned.has(key)) return;
    serverWarned.add(key);
    console.warn(message);
}

function removeProp(room, prop) {
    prop.removed = true;
    room.props.delete(prop.id);
}

function scriptEnv(room, { you, victim = null, prop = null, label }) {
    return {
        you,
        victim,
        prop,
        label,
        actions: actionsFor(room),
        warn: (message) => console.warn(`[goopscript] ${label}: ${message}`)
    };
}

// Runs a script now, up to its first wait. If it paused, the rest is picked up by runTasks.
function startScript(room, script, parts) {
    if (!script) return;
    if (room.tasks.length >= MAX_TASKS_PER_ROOM) {
        warnServerOnce('tasks', '[goopscript] too many scripts are waiting at once, new ones are being skipped');
        return;
    }
    const run = goopscript.createRun(script, scriptEnv(room, parts));
    if (!goopscript.advance(run, Date.now())) room.tasks.push(run);
}

function runPropHook(room, prop, hookName, victim) {
    startScript(room, prop.def.hooks[hookName], { you: prop.owner, victim, prop, label: `prop ${prop.name}` });
}

function spawnProp(room, def, x, y, angle, vx, vy, owner) {
    let owned = 0;
    for (const existing of room.props.values()) if (existing.owner === owner) owned++;
    if (room.props.size >= MAX_PROPS_PER_ROOM || owned >= MAX_PROPS_PER_PLAYER || room.tasks.length >= MAX_TASKS_PER_ROOM) {
        warnServerOnce('prop-limit', `[props] prop limit reached (${MAX_PROPS_PER_ROOM} in the arena, ${MAX_PROPS_PER_PLAYER} per player), new props are being skipped`);
        return null;
    }

    const now = room.tickNow || Date.now();
    const prop = {
        id: room.nextPropId++,
        name: def.name,
        def,
        stats: def.stats,
        x: Math.max(0, Math.min(ARENA_WIDTH, x)),
        y: Math.max(0, Math.min(ARENA_HEIGHT, y)),
        angle,
        vx,
        vy,
        size: def.size,
        owner,
        born: now,
        expiresAt: def.lifetimeMs > 0 ? now + def.lifetimeMs : null,
        armedAt: now + def.armMs,
        touching: new Set(),   // players currently standing on it
        nextStay: new Map(),   // player -> when on_stay may run for them again
        removed: false
    };
    room.props.set(prop.id, prop);

    if (def.hooks.on_spawn) {
        // Starts on the next tick, so a prop whose on_spawn places more props can't loop within one tick.
        const run = goopscript.createRun(def.hooks.on_spawn, scriptEnv(room, { you: owner, prop, label: `prop ${def.name}` }));
        run.wakeAt = now;
        room.tasks.push(run);
    }
    return prop;
}

// What GoopScript commands actually do to the game, for one room.
function actionsFor(room) {
    if (room.actions) return room.actions;
    const alive = (player) => isMember(room, player) && !player.isDead;

    room.actions = {
        isLive: alive,

        damage(player, amount) {
            if (alive(player)) player.health = Math.max(0, player.health - amount);
        },

        // Pushes `player` away from `from` (or, with no `from`, backwards from where they face).
        // `amount` is roughly the total distance slid.
        knockback(player, from, amount) {
            if (!alive(player)) return;
            let dx;
            let dy;
            if (from) {
                dx = player.x - from.x;
                dy = player.y - from.y;
            } else {
                dx = -Math.cos(facingOf(player));
                dy = -Math.sin(facingOf(player));
            }
            const length = Math.sqrt(dx * dx + dy * dy);
            if (length === 0) return;
            const initialSpeed = amount * (1 - KNOCKBACK_FRICTION);
            player.kbx += (dx / length) * initialSpeed;
            player.kby += (dy / length) * initialSpeed;
        },

        playersInRadius(center, radius, exclude) {
            return Object.values(room.players).filter((player) =>
            player !== exclude && !player.isDead && Math.hypot(player.x - center.x, player.y - center.y) <= radius);
        },

        countProps(player) {
            let count = 0;
            for (const prop of room.props.values()) if (prop.owner === player) count++;
            return count;
        },

        place({ name, anchor, distance, owner, label }) {
            const def = findPropDef(name);
            if (!def) {
                warnServerOnce(`${label}|${name}`, `[goopscript] ${label}: there is no prop called "${name}"`);
                return;
            }
            const angle = facingOf(anchor);
            spawnProp(room, def, anchor.x + Math.cos(angle) * distance, anchor.y + Math.sin(angle) * distance, angle, 0, 0, owner);
        },

        shoot({ name, shooter, speed, angleOffset, owner, label }) {
            const def = findPropDef(name);
            if (!def) {
                warnServerOnce(`${label}|${name}`, `[goopscript] ${label}: there is no prop called "${name}"`);
                return;
            }
            const angle = facingOf(shooter) + (angleOffset * Math.PI) / 180;
            const velocity = speed === null ? def.speed : Math.min(60, speed);
            // Starts at the edge of the shooter.
            const startDistance = shooter.size || PLAYER_RADIUS;
            spawnProp(room, def,
                      shooter.x + Math.cos(angle) * startDistance, shooter.y + Math.sin(angle) * startDistance,
                      angle, Math.cos(angle) * velocity, Math.sin(angle) * velocity, owner);
        },

        deleteProps({ which, name, owner, prop }) {
            if (which === 'this') {
                if (prop) removeProp(room, prop);
                return;
            }
            const lower = name ? name.toLowerCase() : null;
            for (const existing of [...room.props.values()]) {
                if (existing.owner !== owner) continue;
                if (which === 'all' || existing.name.toLowerCase() === lower) removeProp(room, existing);
            }
        }
    };
    return room.actions;
}

// How close a point comes to a line segment. Props are checked along the whole path they
// travelled this tick, so a fast one can't skip over a player, and a player standing on
// top of the shooter is still hit.
function distanceToSegment(x, y, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;
    let t = lengthSquared === 0 ? 0 : ((x - x1) * dx + (y - y1) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

// Once per tick: expire, move and bounce props, and run their touch hooks.
function updateProps(room, now) {
    if (room.props.size === 0) return;
    const players = Object.values(room.players);

    for (const prop of [...room.props.values()]) {
        if (prop.removed) continue;

        if (prop.expiresAt !== null && now >= prop.expiresAt) {
            removeProp(room, prop);
            runPropHook(room, prop, 'on_expire', null);
            continue;
        }

        const startX = prop.x;
        const startY = prop.y;
        if (prop.vx !== 0 || prop.vy !== 0) {
            prop.x += prop.vx;
            prop.y += prop.vy;
            if (prop.def.drag > 0) {
                prop.vx *= 1 - prop.def.drag;
                prop.vy *= 1 - prop.def.drag;
                if (Math.hypot(prop.vx, prop.vy) < 0.05) {
                    prop.vx = 0;
                    prop.vy = 0;
                }
            }

            if (prop.x < 0 || prop.x > ARENA_WIDTH || prop.y < 0 || prop.y > ARENA_HEIGHT) {
                if (prop.def.walls === 'vanish') {
                    removeProp(room, prop);
                    continue;
                }
                if (prop.def.walls === 'bounce') {
                    if (prop.x < 0 || prop.x > ARENA_WIDTH) prop.vx = -prop.vx;
                    if (prop.y < 0 || prop.y > ARENA_HEIGHT) prop.vy = -prop.vy;
                    prop.angle = Math.atan2(prop.vy, prop.vx);
                } else {
                    prop.vx = 0;
                    prop.vy = 0;
                }
                prop.x = Math.max(0, Math.min(ARENA_WIDTH, prop.x));
                prop.y = Math.max(0, Math.min(ARENA_HEIGHT, prop.y));
            }
        }

        if (now < prop.armedAt) continue;

        const reach = prop.size + PLAYER_RADIUS;
        for (const player of players) {
            if (prop.removed) break;

            const ignored = player.isDead || (player === prop.owner && !prop.def.touchOwner);
            const overlapping = !ignored && distanceToSegment(player.x, player.y, startX, startY, prop.x, prop.y) <= reach;
            if (!overlapping) {
                prop.touching.delete(player);
                prop.nextStay.delete(player);
                continue;
            }

            if (!prop.touching.has(player)) {
                prop.touching.add(player);
                runPropHook(room, prop, 'on_touch', player);
                if (prop.removed) break;
            }
            if (prop.def.hooks.on_stay && now >= (prop.nextStay.get(player) || 0)) {
                prop.nextStay.set(player, now + prop.def.stayMs);
                runPropHook(room, prop, 'on_stay', player);
            }
        }
    }
}

// Carries on every script that is waiting and whose delay is up.
function runTasks(room, now) {
    if (room.tasks.length === 0) return;
    const pending = room.tasks;
    room.tasks = []; // scripts started while these run wait for the next tick
    for (const run of pending) {
        if (run.wakeAt > now) {
            room.tasks.push(run);
            continue;
        }
        if (!goopscript.advance(run, now)) room.tasks.push(run);
    }
}

function propsForClient(room) {
    const out = [];
    for (const prop of room.props.values()) {
        out.push({
            id: prop.id,
            name: prop.name,
            x: Math.round(prop.x * 10) / 10,
                 y: Math.round(prop.y * 10) / 10,
                 angle: Math.round(prop.angle * 100) / 100,
                 size: prop.size
        });
    }
    return out;
}

function applyAttackDamage(room, attackerId, attacker) {
    const classInfo = classRegistry[attacker.className];
    const hooks = (classInfo && classInfo.hooks) || {};
    const label = attacker.className;

    // Once per attack, whether or not it hits anyone.
    if (hooks.on_attack) startScript(room, hooks.on_attack, { you: attacker, label });

    for (const targetId in room.players) {
        if (targetId === attackerId) continue;
        const target = room.players[targetId];
        if (!target || target.health <= 0 || target.isDead) continue;

        const dx = target.x - attacker.x;
        const dy = target.y - attacker.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > attacker.range) continue;

        const angleToTarget = Math.atan2(dy, dx);
        const angleDiff = Math.abs(normalizeAngleDiff(angleToTarget - (attacker.aimAngle || 0)));
        if (angleDiff > ATTACK_CONE_HALF_ANGLE) continue;

        if (hooks.on_hit) {
            // A class with an on_hit script controls exactly what a hit does.
            startScript(room, hooks.on_hit, { you: attacker, victim: target, label });
        } else {
            target.health = Math.max(0, target.health - attacker.damage);
        }
    }
}

function startNewRound(room) {
    for (const id in room.players) {
        respawnPlayer(room.players[id]);
    }
    room.props.clear();
    room.tasks = [];
    room.roundEndsAt = Date.now() + ROUND_DURATION_MS;
    room.roundOver = false;
    room.nextRoundStartsAt = null;
}

function tickRoom(code) {
    const room = rooms[code];
    if (!room) return;

    // An empty community arena idles, and its round clock restarts so the next
    // person to join gets a full round.
    if (room.persistent && Object.keys(room.players).length === 0) {
        room.props.clear();
        room.tasks = [];
        room.roundEndsAt = Date.now() + ROUND_DURATION_MS;
        room.roundOver = false;
        room.nextRoundStartsAt = null;
        return;
    }

    const now = Date.now();
    room.tickNow = now; // props spawned during this tick are stamped with it, so they take part in it fully

    // If the round already ended, just wait out the display pause, then
    // reset everyone and kick off the next round.
    if (room.roundOver) {
        if (now >= room.nextRoundStartsAt) {
            startNewRound(room);
        } else {
            broadcastToRoom(code, 'state-update', {
                players: room.players,
                timeRemaining: 0,
                roundOver: true,
                nextRoundStartsAt: room.nextRoundStartsAt
            });
            return;
        }
    }

    const timeRemaining = Math.max(0, room.roundEndsAt - now);
    if (timeRemaining <= 0) {
        room.roundOver = true;
        room.nextRoundStartsAt = now + ROUND_OVER_DISPLAY_MS;
        broadcastToRoom(code, 'state-update', {
            players: room.players,
            timeRemaining: 0,
            roundOver: true,
            nextRoundStartsAt: room.nextRoundStartsAt
        });
        return;
    }

    for (const id in room.players) {
        const p = room.players[id];

        if (p.isDead) {
            if (now >= p.respawnAt) {
                respawnPlayer(p);
            }
            continue; // dead players don't move or attack
        }

        const keys = p.keys || {};

        // Click-to-move: walk toward the clicked point, `speed` pixels per tick.
        if (p.target) {
            const dx = p.target.x - p.x;
            const dy = p.target.y - p.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist <= p.speed) {
                p.x = p.target.x;
                p.y = p.target.y;
                p.target = null; // arrived
            } else {
                p.x += (dx / dist) * p.speed;
                p.y += (dy / dist) * p.speed;
            }
        }

        if (keys[' '] && !p.isAttacking) {
            p.isAttacking = true;
            p.attackTimer = 15;
            p.hasHitThisAttack = false;
        }

        if (p.isAttacking) {
            if (!p.hasHitThisAttack && p.attackTimer <= 10) {
                applyAttackDamage(room, id, p);
                p.hasHitThisAttack = true;
            }
            p.attackTimer--;
            if (p.attackTimer <= 0) p.isAttacking = false;
        }

        // Slide from any knockback, losing speed each tick.
        p.x += p.kbx;
        p.y += p.kby;
        p.kbx *= KNOCKBACK_FRICTION;
        p.kby *= KNOCKBACK_FRICTION;
        if (Math.abs(p.kbx) < 0.05) p.kbx = 0;
        if (Math.abs(p.kby) < 0.05) p.kby = 0;

        // Match the client canvas size (800x600) for boundary clamping.
        p.x = Math.max(20, Math.min(780, p.x));
        p.y = Math.max(20, Math.min(580, p.y));
    }

    updateProps(room, now);
    runTasks(room, now);

    // Second pass: catch anyone who just dropped to 0 health this tick
    // and start their respawn timer.
    for (const id in room.players) {
        const p = room.players[id];
        if (!p.isDead && p.health <= 0) {
            p.isDead = true;
            p.respawnAt = Date.now() + RESPAWN_DELAY_MS;
            p.isAttacking = false;
        }
    }

    broadcastToRoom(code, 'state-update', {
        players: room.players,
        props: propsForClient(room),
                    timeRemaining,
                    roundOver: false
    });
}

function removePlayerFromAllRooms(socketId) {
    for (const code in rooms) {
        const room = rooms[code];
        if (room.players[socketId]) {
            delete room.players[socketId];

            const remaining = Object.keys(room.players).length;
            if (remaining === 0 && !room.persistent) {
                // No one left - tear down the room entirely.
                clearInterval(room.intervalHandle);
                delete rooms[code];
                console.log(`[rooms] closed ${code} (last player left)`);
            } else if (remaining > 0) {
                broadcastToRoom(code, 'state-update', { players: room.players });
            }
            reportStatus();
        }
    }
}

// --------------------------------------------------
// Socket.io connection handling
// --------------------------------------------------
// One of these runs for every connected socket - a real Socket.io connection, or (on a
// community server) a stand-in for a player who is being relayed through the main site.
function handleConnection(socket) {
    socket.on('host-room', ({ className } = {}) => {
        if (COMMUNITY_MODE) {
            socket.emit('join-error', { message: 'This is a community server - use Join Server.' });
            return;
        }
        reloadContent(); // pick up any edits to classes and props without restarting
        const code = makeRoomCode();
        const room = createRoom(code, socket.id);
        room.players[socket.id] = createPlayer(className);

        socket.join(code);
        socket.data.roomCode = code;
        console.log(`[rooms] created ${code} (instance ${INSTANCE_ID})`);
        socket.emit('room-created', { code });
    });

    socket.on('join-server', ({ className } = {}) => {
        const arena = rooms[COMMUNITY_ROOM];
        if (!COMMUNITY_MODE || !arena) {
            socket.emit('join-error', { message: 'This is not a community server.' });
            return;
        }
        if (arena.players[socket.id]) return; // already in
        if (Object.keys(arena.players).length >= MAX_PLAYERS_PER_ROOM) {
            socket.emit('join-error', { message: 'Server is full.' });
            return;
        }

        arena.players[socket.id] = createPlayer(className);
        socket.join(COMMUNITY_ROOM);
        socket.data.roomCode = COMMUNITY_ROOM;
        console.log(`[server] ${socket.id} joined (${Object.keys(arena.players).length}/${MAX_PLAYERS_PER_ROOM})`);
        reportStatus();
        socket.emit('joined', { code: COMMUNITY_ROOM, serverName: communityConfig.name });
    });

    // Main site only: play on a community server through this site.
    socket.on('join-remote', ({ code, className } = {}) => {
        if (COMMUNITY_MODE) {
            socket.emit('join-error', { message: 'This server does not take relayed players.' });
            return;
        }
        if (socket.data.remoteServer) return; // already on a server
        const serverCode = String(code || '').trim().toUpperCase();
        if (!hosts.has(serverCode)) {
            socket.emit('join-error', { message: 'That server is offline, or the code is wrong.' });
            return;
        }
        socket.data.remoteServer = serverCode;
        forwardToHost(socket, 'join-server', { className: String(className || '').slice(0, 60) });
    });

    socket.on('join-room', ({ code, className } = {}) => {
        if (COMMUNITY_MODE) {
            socket.emit('join-error', { message: 'This is a community server - use Join Server.' });
            return;
        }
        const room = rooms[code];
        if (!room) {
            console.warn(`[rooms] join failed: no room '${code}' (instance ${INSTANCE_ID}, active rooms: ${Object.keys(rooms).join(', ') || 'none'})`);
            socket.emit('join-error', { message: 'Room not found. Check the code and try again.' });
            return;
        }
        if (Object.keys(room.players).length >= MAX_PLAYERS_PER_ROOM) {
            socket.emit('join-error', { message: 'Room is full.' });
            return;
        }

        room.players[socket.id] = createPlayer(className);
        socket.join(code);
        socket.data.roomCode = code;
        console.log(`[rooms] ${socket.id} joined ${code} (${Object.keys(room.players).length} players)`);
        socket.emit('joined', { code });
    });

    socket.on('move-to', (data) => {
        if (socket.data.remoteServer) { forwardToHost(socket, 'move-to', data); return; }
        const room = rooms[socket.data.roomCode];
        const p = room && room.players[socket.id];
        if (!p || p.isDead || room.roundOver) return;
        const x = Number(data && data.x);
        const y = Number(data && data.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        // Keep the destination inside the 800x600 arena (same bounds as the movement clamp).
        p.target = { x: Math.max(20, Math.min(780, x)), y: Math.max(20, Math.min(580, y)) };
    });

    socket.on('input', (data) => {
        if (socket.data.remoteServer) { forwardToHost(socket, 'input', data); return; }
        if (!data || typeof data !== 'object') return;
        const code = socket.data.roomCode;
        const room = rooms[code];
        if (!room || !room.players[socket.id]) return;
        room.players[socket.id].keys = data.keys && typeof data.keys === 'object' ? data.keys : {};
        if (Number.isFinite(data.aimAngle)) {
            room.players[socket.id].aimAngle = data.aimAngle;
        }
    });

    socket.on('disconnect', () => {
        const remote = socket.data.remoteServer && hosts.get(socket.data.remoteServer);
        if (remote) remote.socket.emit('player-left', { playerId: socket.id });
        removePlayerFromAllRooms(socket.id);
    });
}

io.on('connection', handleConnection);

try {
    reloadContent();
} catch (err) {
    console.error('[content] failed to load classes and props, continuing without them:', err);
}

// --------------------------------------------------
// Relay link (community servers)
// --------------------------------------------------
// With "mainSite" set in community.json, this server connects OUT to the main site, tells it
// its name and size, and then handles the players the main site relays to it, exactly as if
// they had connected directly. Nothing needs to be opened on this computer's network.

// A secret saved next to this file the first time the server runs. The main site works the
// server's code out from it, so the code stays the same every time. Don't share it.
function loadServerKey() {
    const file = path.join(__dirname, 'server.key');
    try {
        const saved = fs.readFileSync(file, 'utf8').trim();
        if (/^[a-f0-9]{32,}$/i.test(saved)) return saved;
    } catch (err) { /* first run */ }

    const key = crypto.randomBytes(24).toString('hex');
    try {
        fs.writeFileSync(file, key + '\n', { mode: 0o600 });
    } catch (err) {
        console.warn(`[relay] could not save server.key (${err.message}), so this server's code will change every time it starts`);
    }
    return key;
}

let lastRelayProblem = { message: '', at: 0 };
function logRelayProblem(message) {
    const now = Date.now();
    if (message === lastRelayProblem.message && now - lastRelayProblem.at < 60000) return;
    lastRelayProblem = { message, at: now };
    console.warn(`[relay] ${message}`);
}

function reportStatus() {
    if (!relayLink || !relayRegistered) return;
    const arena = rooms[COMMUNITY_ROOM];
    relayLink.emit('status', { online: arena ? Object.keys(arena.players).length : 0 });
}

// Stand-in for a relayed player. It looks like a Socket.io socket to the game code, but what
// the game sends it goes back over the link instead.
function createRelaySocket(playerId) {
    const handlers = {};
    return {
        id: playerId,
        data: {},
        handlers,
        on(event, handler) { handlers[event] = handler; },
        join() { /* relayed players are reached through broadcastToRoom */ },
        emit(event, data) {
            if (relayLink && relayLink.connected) relayLink.emit('to-player', { playerId, event, data });
            if (event === 'join-error') relaySockets.delete(playerId); // never got in
        }
    };
}

function dropRelayedPlayers() {
    for (const standIn of [...relaySockets.values()]) {
        if (standIn.handlers.disconnect) standIn.handlers.disconnect();
    }
    relaySockets.clear();
}

const RELAYED_EVENTS = new Set(['join-server', 'move-to', 'input']);

// A class or prop file the main site asked for, for players who are loading this server's content.
function readContentFile(kind, requestedPath) {
    try {
        const isProps = kind === 'props';
        const registry = isProps ? propRegistry : classRegistry;
        const relPath = String(requestedPath || '');

        if (relPath === 'list.txt') {
            reloadContent();
            return { ok: true, body: Buffer.from(Object.keys(registry).join('\n') + '\n') };
        }

        const ext = path.extname(relPath).toLowerCase();
        if (isProps ? ext !== '.png' : (ext !== '.png' && ext !== '.txt')) return { ok: false };

        const baseDir = path.resolve(__dirname, isProps ? 'props' : 'classes');
        const full = path.resolve(baseDir, relPath);
        if (!full.startsWith(baseDir + path.sep)) return { ok: false };
        const folder = path.relative(baseDir, full).split(path.sep)[0];
        if (!Object.prototype.hasOwnProperty.call(registry, folder)) return { ok: false };

        const info = fs.statSync(full);
        if (!info.isFile() || info.size > MAX_ASSET_BYTES) return { ok: false };
        return { ok: true, body: fs.readFileSync(full) };
    } catch (err) {
        return { ok: false };
    }
}

function connectToMainSite() {
    let connect;
    try {
        connect = require('socket.io-client').io;
    } catch (err) {
        console.warn('[relay] socket.io-client is not installed, so this server cannot connect to the main site. Run "npm install" in this folder.');
        return;
    }

    const keyHash = crypto.createHash('sha256').update(loadServerKey()).digest('hex');
    relayLink = connect(communityConfig.mainSite + '/host', { reconnectionDelay: 2000, reconnectionDelayMax: 20000 });

    // A mistake in one relayed message should never take the whole server down.
    const safely = (fn) => (...args) => {
        try { fn(...args); } catch (err) { console.warn('[relay] ignored a bad message:', err.message); }
    };

    relayLink.on('connect', () => {
        relayLink.emit('register', {
            keyHash,
            name: communityConfig.name,
            motd: communityConfig.motd,
            maxPlayers: MAX_PLAYERS_PER_ROOM,
            listed: communityConfig.listed,
            version: 2 // 2 = also serves props
        }, (reply) => {
            if (!reply || !reply.ok) {
                logRelayProblem(`the main site refused this server: ${reply && reply.message ? reply.message : 'no reason given'}`);
                return;
            }
            relayRegistered = true;
            console.log(`[relay] Online! Players can join through ${communityConfig.mainSite}` +
            (communityConfig.listed ? ' from the server list, or' : ' (not listed)') + ` with the server code ${reply.code}`);
            reportStatus();
        });
    });

    relayLink.on('connect_error', (err) => {
        logRelayProblem(`could not reach ${communityConfig.mainSite} (${err.message}), will keep trying`);
    });

    relayLink.on('disconnect', () => {
        relayRegistered = false;
        dropRelayedPlayers();
        logRelayProblem('lost the connection to the main site, will keep trying');
    });

    relayLink.on('player-event', safely((msg) => {
        if (!msg || typeof msg.playerId !== 'string' || !RELAYED_EVENTS.has(msg.event)) return;
        let standIn = relaySockets.get(msg.playerId);
        if (!standIn) {
            standIn = createRelaySocket(msg.playerId);
            relaySockets.set(msg.playerId, standIn);
            handleConnection(standIn);
        }
        const handler = standIn.handlers[msg.event];
        if (handler) handler(msg.data);
    }));

        relayLink.on('player-left', safely((msg) => {
            const standIn = msg && relaySockets.get(msg.playerId);
            if (!standIn) return;
            relaySockets.delete(msg.playerId);
            if (standIn.handlers.disconnect) standIn.handlers.disconnect();
        }));

            relayLink.on('fetch-file', (request, ack) => {
                if (typeof ack !== 'function') return;
                const kind = request && request.kind === 'props' ? 'props' : 'classes';
                ack(readContentFile(kind, request && request.path));
            });

            setInterval(reportStatus, 5000);
}

if (COMMUNITY_MODE) {
    createRoom(COMMUNITY_ROOM, null, true);
}

function lanAddresses() {
    const found = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const iface of list || []) {
            if ((iface.family === 'IPv4' || iface.family === 4) && !iface.internal) found.push(iface.address);
        }
    }
    return found;
}

function printCommunityBanner() {
    const port = server.address().port;
    console.log('');
    console.log(`=== ${communityConfig.name} ===`);
    console.log(`  Up to ${MAX_PLAYERS_PER_ROOM} players. Join at:`);
    console.log(`    This computer:   http://localhost:${port}`);
    for (const ip of lanAddresses()) console.log(`    Your network:    http://${ip}:${port}`);
        if (communityConfig.mainSite) {
            console.log(`  Connecting to ${communityConfig.mainSite} so players can find this server there...`);
        } else {
            console.log('  Friends outside your network need a tunnel or port forwarding (see README.md).');
        }
        console.log('  Press Ctrl+C to stop the server.');
        console.log('');
}

server.on('error', (err) => {
    console.error(`[startup] could not listen on port ${PORT}: ${err.code || ''} ${err.message}`);
    process.exit(1);
});

// Bind to all interfaces (0.0.0.0) - hosting platforms route traffic in from outside the container.
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[startup] Goops server listening on 0.0.0.0:${PORT} (PORT env: ${process.env.PORT || 'not set'}, node ${process.version}, instance ${INSTANCE_ID})`);
    if (COMMUNITY_MODE) {
        printCommunityBanner();
        if (communityConfig.mainSite) connectToMainSite();
    }
});
