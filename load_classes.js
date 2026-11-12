// --------------------------------------------------
// Class Loading & Character Select UI
// --------------------------------------------------
// Exposes globals used by game.js:
//   loadedClasses, activeClasses, selectedClass

const loadedClasses = {};
const loadedProps = {}; // prop name -> { sprite, activeSprite }
let activeClasses = [];
let selectedClass = '';

window.addEventListener('DOMContentLoaded', () => {
    initLoadoutFromManifest();
});

// Only the most recent call is allowed to fill in the class list, so picking a server and
// then going back quickly can't leave two servers' classes mixed together.
let loadToken = 0;

// classesBase is where the class list and files come from: this site's own ./classes, or a
// community server's classes when joining it through the main site (/s/<code>/classes).
async function initLoadoutFromManifest(classesBase = './classes') {
    const container = document.getElementById('class-buttons');
    const label = document.getElementById('char-label');
    const statusEl = document.getElementById('status-text');
    if (!container || !label) return;

    const token = ++loadToken;
    // Props come from the same place as the classes: ./props, or /s/<code>/props on a community server.
    loadProps(classesBase.replace(/\/classes$/, '/props'));
    container.innerHTML = '';
    activeClasses.length = 0;
    Object.keys(loadedClasses).forEach((name) => delete loadedClasses[name]);
    selectedClass = '';

    let folderList = [];
    try {
        const res = await fetch(`${classesBase}/list.txt`);
        if (res.ok) {
            const text = await res.text();
            folderList = text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
        } else {
            throw new Error('Could not find list.txt');
        }
    } catch (err) {
        if (token !== loadToken) return;
        console.warn('Could not read the class list:', err);
        // Fallback: if no manifest is reachable (e.g. running from file:// without a server),
        // fall back to a single default class so the game is still playable.
        if (statusEl) {
            statusEl.innerText = 'Could not load the class list (are you running a local server?). Using default class.';
        }
        loadedClasses['Default'] = {
            attackType: 'melee',
            range: 60,
            speed: 4,
            damage: 10,
            health: 100,
            sprites: {
                player: new Image(),
                playerAttack: new Image(),
                attack: new Image()
            }
        };
        activeClasses.push('Default');
        finishClassSetup(container, label);
        return;
    }

    if (token !== loadToken) return;
    folderList = folderList.slice(0, 50); // a server can't flood the lobby with classes

    for (const folderName of folderList) {
        const basePath = `${classesBase}/${encodeURIComponent(folderName)}`;
        let config = { attackType: 'melee', range: 60, speed: 4, damage: 10, health: 100 };

        try {
            // class_info.txt is the current name; attack_info.txt is accepted as a fallback.
            let res = await fetch(`${basePath}/class_info.txt`);
            if (!res.ok) res = await fetch(`${basePath}/attack_info.txt`);
            if (res.ok) {
                const text = await res.text();
                config = parseClassInfo(text);
            }
        } catch (err) {
            console.warn(`Could not read class_info.txt for ${folderName}, using default fallback stats.`);
        }
        if (token !== loadToken) return;

        const playerImg = new Image();
        playerImg.onerror = () => console.error(`[${folderName}] Failed to load player sprite at: ${playerImg.src}`);
        playerImg.onload = () => console.log(`[${folderName}] Loaded player.png (${playerImg.naturalWidth}x${playerImg.naturalHeight})`);
        playerImg.src = `${basePath}/player.png`;

        const playerAttackImg = new Image();
        playerAttackImg.onerror = () => console.error(`[${folderName}] Failed to load player_attack sprite at: ${playerAttackImg.src}`);
        playerAttackImg.onload = () => console.log(`[${folderName}] Loaded player_attack.png (${playerAttackImg.naturalWidth}x${playerAttackImg.naturalHeight})`);
        playerAttackImg.src = `${basePath}/player_attack.png`;

        const attackImg = new Image();
        attackImg.onerror = () => console.error(`[${folderName}] Failed to load attack sprite at: ${attackImg.src}`);
        attackImg.onload = () => console.log(`[${folderName}] Loaded attack.png (${attackImg.naturalWidth}x${attackImg.naturalHeight})`);
        attackImg.src = `${basePath}/attack.png`;

        loadedClasses[folderName] = {
            attackType: config.attacktype || config.attackType || 'melee',
            range: Number(config.range) || 60,
            speed: Number(config.speed) || 4,
            damage: Number(config.damage) || 10,
            health: Number(config.health) || 100,
            sprites: {
                player: playerImg,
                playerAttack: playerAttackImg,
                attack: attackImg
            }
        };

        activeClasses.push(folderName);
    }

    if (activeClasses.length === 0) return;

    finishClassSetup(container, label);
}

// Loads the sprite for every prop the server has. What a prop does is decided by the server,
// and its size comes with the game state, so only the image is needed here.
let propsToken = 0;
async function loadProps(propsBase) {
    const token = ++propsToken;
    Object.keys(loadedProps).forEach((name) => delete loadedProps[name]);
    try {
        const res = await fetch(`${propsBase}/list.txt`);
        if (!res.ok) return;
        const names = (await res.text())
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .slice(0, 50);
        if (token !== propsToken) return;

        for (const name of names) {
            const sprite = new Image();
            sprite.src = `${propsBase}/${encodeURIComponent(name)}/prop.png`;
            // Optional picture shown while the prop is activated. If the file isn't there it is simply never used.
            const activeSprite = new Image();
            activeSprite.src = `${propsBase}/${encodeURIComponent(name)}/prop_activate.png`;
            loadedProps[name] = { sprite, activeSprite };
        }
    } catch (err) {
        // This server has no props.
    }
}

function finishClassSetup(container, label) {
    selectedClass = activeClasses[0];

    activeClasses.forEach((folderName) => {
        const btn = document.createElement('button');
        btn.innerText = folderName;
        btn.id = `btn-${folderName}`;
        if (folderName === selectedClass) btn.classList.add('selected');
        btn.onclick = () => selectClass(folderName);
        container.appendChild(btn);
    });

    if (label) label.innerText = selectedClass;
}

// Reads the stat lines of class_info.txt. The goopscript section (from the first
// "on_hit:" line on) is run by the server, so the client stops reading there.
function parseClassInfo(text) {
    const result = {};
    const lines = text.split('\n');

    for (const line of lines) {
        const cleanLine = line.trim();
        if (!cleanLine || cleanLine.startsWith('#')) continue;
        if (/^on_[a-z_]+\s*:$/i.test(cleanLine)) break;

        let parts = cleanLine.split(':');
        if (parts.length < 2) {
            parts = cleanLine.split('=');
        }

        if (parts.length >= 2) {
            const key = parts[0].trim().toLowerCase().replace(/\s+/g, '');
            const val = parts.slice(1).join(':').trim();
            result[key] = val;
        }
    }

    return result;
}

function selectClass(className) {
    selectedClass = className;
    const label = document.getElementById('char-label');
    if (label) label.innerText = className;

    activeClasses.forEach(c => {
        const btn = document.getElementById(`btn-${c}`);
        if (btn) btn.classList.toggle('selected', c === className);
    });
}
