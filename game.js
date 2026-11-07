// --------------------------------------------------
// Client: Networking (Socket.io) & Rendering
// --------------------------------------------------
// Relies on globals from load_classes.js: loadedClasses, activeClasses, selectedClass
// The server is authoritative for all game state - this file only sends input
// and renders whatever state the server broadcasts.

let socket = null;
let myId = null;
let isHost = false;
let players = {};
let roundTimeRemaining = null;
let roundOver = false;
let nextRoundStartsAt = null;
const keys = {};
let mouseX = 400;
let mouseY = 300;

window.addEventListener('keydown', (e) => keys[e.key] = true);
window.addEventListener('keyup', (e) => keys[e.key] = false);

window.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('gameCanvas');
    if (canvas) {
        // Converts a mouse event to canvas coordinates. Scales in case the canvas is
        // displayed at a different size than its internal width/height (e.g. via CSS).
        const toCanvas = (e) => {
            const rect = canvas.getBoundingClientRect();
            return {
                x: (e.clientX - rect.left) * (canvas.width / rect.width),
                y: (e.clientY - rect.top) * (canvas.height / rect.height)
            };
        };

        canvas.addEventListener('mousemove', (e) => {
            const pos = toCanvas(e);
            mouseX = pos.x;
            mouseY = pos.y;
        });

        // Left click = walk there.
        canvas.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            const pos = toCanvas(e);
            if (socket && socket.connected) socket.emit('move-to', pos);
        });
    }
});

function connectSocket() {
    if (socket) return socket;
    socket = io();

    socket.on('connect', () => {
        myId = socket.id;
    });

    socket.on('state-update', (data) => {
        players = data.players;
        roundTimeRemaining = data.timeRemaining;
        roundOver = data.roundOver;
        nextRoundStartsAt = data.nextRoundStartsAt || null;
        updateRoundTimerBadge();
    });

    socket.on('join-error', (data) => {
        const statusEl = document.getElementById('status-text');
        if (statusEl) statusEl.innerText = `Error: ${data.message}`;
    });

    socket.on('disconnect', () => {
        const statusEl = document.getElementById('status-text');
        if (statusEl) statusEl.innerText = 'Disconnected from server.';
    });

    // Playing on a community server through the main site, and that server went offline.
    socket.on('server-closed', () => {
        alert('The server you were playing on went offline.');
        location.reload();
    });

    return socket;
}

function hostGame() {
    const statusEl = document.getElementById('status-text');
    if (statusEl) statusEl.innerText = 'Connecting to server...';

    isHost = true;
    connectSocket();

    socket.emit('host-room', { className: selectedClass });

    socket.off('room-created');
    socket.once('room-created', ({ code }) => {
        if (statusEl) statusEl.innerText = `Hosting room ${code}`;
        showHostCodeBadge(code);
        startGame();
    });
}

function joinGame() {
    const roomCode = document.getElementById('host-id-input').value.trim();
    const statusEl = document.getElementById('status-text');
    if (!roomCode) return;

    if (statusEl) statusEl.innerText = `Joining room ${roomCode}...`;

    isHost = false;
    connectSocket();

    socket.emit('join-room', { code: roomCode, className: selectedClass });

    socket.off('joined');
    socket.once('joined', () => {
        if (statusEl) statusEl.innerText = `Joined room ${roomCode}`;
        startGame();
    });
}

// Community servers: swap the Host/Join controls for a single Join Server button and
// show the server's name, message of the day and player count. On the normal site
// (or if the lookup fails) the lobby is left exactly as it is.
async function initServerInfo() {
    try {
        const res = await fetch('/server-info');
        if (!res.ok) return;
        const info = await res.json();
        if (info.mode !== 'community') return;

        document.title = info.name;
        // textContent (not innerHTML): the name and message come from whoever runs the server.
        document.getElementById('server-name').textContent = info.name;
        const motd = document.getElementById('server-motd');
        motd.textContent = info.motd;
        motd.style.display = info.motd ? '' : 'none';
        document.getElementById('server-online').textContent = `${info.online} / ${info.maxPlayers} players online`;
        document.getElementById('server-banner').style.display = '';
        document.getElementById('community-actions').style.display = '';
        document.getElementById('main-actions').style.display = 'none';

        const statusEl = document.getElementById('status-text');
        if (statusEl) statusEl.innerText = 'Select a class and click Join Server';
    } catch (err) {
        // No /server-info (older server): keep the normal lobby.
    }
}

window.addEventListener('DOMContentLoaded', initServerInfo);

function joinServer() {
    const statusEl = document.getElementById('status-text');
    if (statusEl) statusEl.innerText = 'Joining server...';

    isHost = false;
    connectSocket();

    // remoteServer is set by server_browser.js when a community server was picked from the
    // main site's list. Those players are relayed through the main site.
    const remote = typeof remoteServer !== 'undefined' ? remoteServer : null;
    if (remote) {
        socket.emit('join-remote', { code: remote.code, className: selectedClass });
    } else {
        socket.emit('join-server', { className: selectedClass });
    }

    socket.off('joined');
    socket.once('joined', (data) => {
        if (statusEl) statusEl.innerText = 'Joined server';
        const badge = document.getElementById('host-code-badge');
        if (badge) {
            badge.innerText = data.serverName || 'Community Server';
            badge.style.display = 'block';
        }
        startGame();
    });
}

function showHostCodeBadge(code) {
    const badge = document.getElementById('host-code-badge');
    if (!badge) return;
    badge.innerText = `Room Code: ${code}`;
    badge.style.display = 'block';
}

function updateRoundTimerBadge() {
    const badge = document.getElementById('round-timer-badge');
    if (!badge) return;

    if (roundOver) {
        badge.innerText = 'Round Over';
    } else if (typeof roundTimeRemaining === 'number') {
        const totalSeconds = Math.ceil(roundTimeRemaining / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        badge.innerText = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }
    badge.style.display = 'block';
}

let gameStarted = false;

function startGame() {
    if (gameStarted) return;
    gameStarted = true;
    document.getElementById('ui').style.display = 'none';
    const canvas = document.getElementById('gameCanvas');
    canvas.style.display = 'block';
    requestAnimationFrame(gameLoop);
}

// The server only reads input about 30 times a second, so there's no point sending more.
const INPUT_SEND_INTERVAL_MS = 33;
let lastInputSentAt = 0;

function gameLoop() {
    if (socket && socket.connected) {
        const now = performance.now();
        if (now - lastInputSentAt >= INPUT_SEND_INTERVAL_MS) {
            lastInputSentAt = now;
            const me = players[myId];
            const originX = me ? me.x : 400;
            const originY = me ? me.y : 300;
            const aimAngle = Math.atan2(mouseY - originY, mouseX - originX);

            socket.emit('input', { keys, aimAngle });
        }
    }

    render();
    requestAnimationFrame(gameLoop);
}

// Given an image and a target bounding box, returns {width, height} that
// preserves the image's aspect ratio while fitting inside the box.
function fitWithinBox(img, maxWidth, maxHeight) {
    if (!img || !img.naturalWidth || !img.naturalHeight) {
        return { width: maxWidth, height: maxHeight };
    }
    const scale = Math.min(maxWidth / img.naturalWidth, maxHeight / img.naturalHeight);
    return {
        width: img.naturalWidth * scale,
        height: img.naturalHeight * scale
    };
}

function render() {
    const canvas = document.getElementById('gameCanvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (roundOver) {
        renderRoundOverOverlay(ctx, canvas);
        return;
    }

    for (let id in players) {
        const p = players[id];

        if (p.isDead) continue; // dead players are invisible on the field until respawn

        const classAssets = loadedClasses[p.className];

        let sprite = classAssets?.sprites.player;
        if (p.isAttacking && classAssets?.sprites.playerAttack) {
            sprite = classAssets.sprites.playerAttack;
        }

        const facing = p.aimAngle || 0;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(facing); // sprite's own "right" side is treated as its front

        if (sprite && sprite.complete && sprite.naturalWidth !== 0) {
            const { width, height } = fitWithinBox(sprite, 32, 32);
            ctx.drawImage(sprite, -width / 2, -height / 2, width, height);
        } else {
            ctx.fillStyle = '#2ecc71';
            ctx.beginPath();
            ctx.arc(0, 0, 16, 0, Math.PI * 2);
            ctx.fill();
        }

        if (p.isAttacking) {
            const attackSprite = classAssets?.sprites.attack;
            if (attackSprite && attackSprite.complete && attackSprite.naturalWidth !== 0) {
                const { width, height } = fitWithinBox(attackSprite, p.range, 32);
                ctx.drawImage(attackSprite, 16, -height / 2, width, height);
            } else {
                ctx.strokeStyle = 'rgba(231, 76, 60, 0.6)';
                ctx.lineWidth = 3;
                ctx.beginPath();
                // Draw the attack cone in local (rotated) space, matching the
                // server's actual hit-detection cone (see ATTACK_CONE_HALF_ANGLE).
                const coneHalfAngle = Math.PI / 4;
                ctx.moveTo(0, 0);
                ctx.arc(0, 0, p.range, -coneHalfAngle, coneHalfAngle);
                ctx.closePath();
                ctx.stroke();
            }
        }

        ctx.restore();

        // Health bar and label are drawn unrotated, in world space.
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(p.x - 20, p.y - 30, 40, 5);
        ctx.fillStyle = '#00ff00';
        ctx.fillRect(p.x - 20, p.y - 30, 40 * (p.health / p.maxHealth), 5);

        // Label
        ctx.fillStyle = '#ffffff';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${p.className}`, p.x, p.y - 35);
    }

    drawMoveMarker(ctx);
    renderDeathOverlay(ctx, canvas);
}

// Small ring + cross at the spot you clicked, until you get there.
function drawMoveMarker(ctx) {
    const me = players[myId];
    if (!me || me.isDead || !me.target) return;

    const { x, y } = me.target;
    ctx.strokeStyle = '#c98456';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.moveTo(x - 5, y);
    ctx.lineTo(x + 5, y);
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x, y + 5);
    ctx.stroke();
}

function renderDeathOverlay(ctx, canvas) {
    const me = players[myId];
    if (!me || !me.isDead) return;

    const secondsLeft = Math.max(0, Math.ceil((me.respawnAt - Date.now()) / 1000));

    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#e74c3c';
    ctx.font = 'bold 48px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('You Died', canvas.width / 2, canvas.height / 2 - 20);

    ctx.fillStyle = '#ffffff';
    ctx.font = '24px sans-serif';
    ctx.fillText(`Respawning in ${secondsLeft}...`, canvas.width / 2, canvas.height / 2 + 30);
}

function renderRoundOverOverlay(ctx, canvas) {
    const secondsLeft = nextRoundStartsAt ? Math.max(0, Math.ceil((nextRoundStartsAt - Date.now()) / 1000)) : 0;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#c98456';
    ctx.font = 'bold 48px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Round Over', canvas.width / 2, canvas.height / 2 - 20);

    ctx.fillStyle = '#ffffff';
    ctx.font = '24px sans-serif';
    ctx.fillText(`Next round starts in ${secondsLeft}...`, canvas.width / 2, canvas.height / 2 + 30);
}
