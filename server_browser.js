// --------------------------------------------------
// Server browser (main site only)
// --------------------------------------------------
// Lists the community servers that have connected to this site, lets you pick one from the
// list or by its code, and loads that server's classes. Joining it then goes through the
// main site (see joinServer in game.js). Relies on initLoadoutFromManifest from
// load_classes.js. On a community server's own page nothing here is shown.

let remoteServer = null; // { code, name, motd, online, maxPlayers } while a community server is selected

async function initServerBrowser() {
    try {
        const res = await fetch('/server-info');
        if (!res.ok) return;
        const info = await res.json();
        if (info.mode !== 'main') return;
    } catch (err) {
        return;
    }
    document.getElementById('server-browser').style.display = '';
    refreshServerList();
}

window.addEventListener('DOMContentLoaded', initServerBrowser);

function setLobbyStatus(text) {
    const statusEl = document.getElementById('status-text');
    if (statusEl) statusEl.innerText = text;
}

async function refreshServerList() {
    const list = document.getElementById('server-list');
    if (!list) return;
    try {
        const res = await fetch('/servers');
        if (!res.ok) throw new Error('bad response');
        renderServerList(await res.json());
    } catch (err) {
        list.textContent = 'Could not load the server list.';
    }
}

// Names and messages come from whoever runs each server, so they are only ever shown as text.
function renderServerList(servers) {
    const list = document.getElementById('server-list');
    list.textContent = '';

    if (!servers.length) {
        list.textContent = 'No community servers are online right now.';
        return;
    }

    for (const server of servers) {
        const row = document.createElement('div');
        row.className = 'server-row';

        const text = document.createElement('div');
        text.className = 'server-row-text';
        const name = document.createElement('strong');
        name.textContent = server.name;
        const detail = document.createElement('span');
        detail.textContent = `${server.online}/${server.maxPlayers} players` + (server.motd ? ` - ${server.motd}` : '');
        text.append(name, document.createElement('br'), detail);

        const button = document.createElement('button');
        button.className = 'btn-action';
        button.textContent = 'Select';
        button.onclick = () => selectRemoteServer(server);

        row.append(text, button);
        list.appendChild(row);
    }
}

async function findServerByCode() {
    const input = document.getElementById('server-code-input');
    const code = input.value.trim().toUpperCase();
    if (!code) return;

    try {
        const res = await fetch('/servers/' + encodeURIComponent(code));
        if (!res.ok) {
            setLobbyStatus('No server with that code is online.');
            return;
        }
        selectRemoteServer(await res.json());
    } catch (err) {
        setLobbyStatus('Could not reach the server list.');
    }
}

function selectRemoteServer(server) {
    remoteServer = server;
    initLoadoutFromManifest(`/s/${encodeURIComponent(server.code)}/classes`);

    document.getElementById('server-name').textContent = server.name;
    const motd = document.getElementById('server-motd');
    motd.textContent = server.motd;
    motd.style.display = server.motd ? '' : 'none';
    document.getElementById('server-online').textContent = `${server.online} / ${server.maxPlayers} players online`;

    document.getElementById('server-banner').style.display = '';
    document.getElementById('community-actions').style.display = '';
    document.getElementById('back-button').style.display = '';
    document.getElementById('main-actions').style.display = 'none';
    document.getElementById('server-browser').style.display = 'none';
    setLobbyStatus('Select a class and click Join Server');
}

function leaveRemoteSelection() {
    remoteServer = null;
    initLoadoutFromManifest('./classes');

    document.getElementById('server-banner').style.display = 'none';
    document.getElementById('community-actions').style.display = 'none';
    document.getElementById('back-button').style.display = 'none';
    document.getElementById('main-actions').style.display = '';
    document.getElementById('server-browser').style.display = '';
    setLobbyStatus('Select a class and click Host or Join');
    refreshServerList();
}
