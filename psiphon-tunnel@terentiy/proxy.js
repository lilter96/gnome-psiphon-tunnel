// The GNOME system proxy, pointed at the tunnel while it is open and put
// back the way it was once Psiphon is gone. Browsers and GNOME apps follow
// that setting, so they go through the tunnel without being set up one by
// one. No Shell here: the settings come in as a store, and the tests pass a
// fake one, so they never touch the real dconf.

import Gio from 'gi://Gio';

const ALIVE = new Set(['starting', 'connecting', 'on', 'reconnecting', 'stopping']);
const KEYS = ['mode', 'http.host', 'http.port', 'https.host', 'https.port', 'socks.host', 'socks.port'];

// What to do now: 'apply', 'restore' or null. want: the switch is on.
// state: the tunnel's. applied: what we set and what was there before, or
// null. holding: Psiphon is gone on purpose and coming right back, as when
// the country changes; the browsers keep their setting through it.
export function proxyPlan({want, state, ports, applied, holding = false}) {
    if (applied) {
        if (!want || (!ALIVE.has(state) && !holding))
            return 'restore';
        if (state === 'on' && ports.http && (applied.http !== ports.http || applied.socks !== (ports.socks ?? null)))
            return 'apply';
        return null;
    }
    // only once the tunnel is up: until then the proxy would only fail
    return want && state === 'on' && ports.http ? 'apply' : null;
}

// The values the settings get for the tunnel's ports. Psiphon's HTTP proxy
// does CONNECT, so it serves https too.
export function tunnelValues({http, socks}) {
    return {
        'mode': 'manual',
        'http.host': '127.0.0.1',
        'http.port': http,
        'https.host': '127.0.0.1',
        'https.port': http,
        'socks.host': socks ? '127.0.0.1' : '',
        'socks.port': socks ?? 0,
    };
}

// store: {get(key), set(key, value)}, keys as in KEYS.
export class SystemProxy {
    constructor(store = gnomeStore()) {
        this._store = store;
    }

    read() {
        return Object.fromEntries(KEYS.map(k => [k, this._store.get(k)]));
    }

    // Points the settings at the tunnel. -> the record to keep: the ports,
    // the values set, and what was there before the first time.
    apply(ports, applied = null) {
        const values = tunnelValues(ports);
        const previous = applied?.previous ?? this.read();
        // hosts and ports first, the mode last: apps switch once, to a whole setting
        for (const [k, v] of Object.entries(values)) {
            if (k !== 'mode')
                this._store.set(k, v);
        }
        this._store.set('mode', values.mode);
        return {http: ports.http, socks: ports.socks ?? null, values, previous};
    }

    // Puts back what was there, unless someone changed the settings since:
    // then they are theirs. -> true if put back
    restore(applied) {
        const now = this.read();
        if (!Object.entries(applied.values).every(([k, v]) => now[k] === v))
            return false;
        // the mode first: apps stop using the tunnel before its ports go
        this._store.set('mode', applied.previous.mode);
        for (const [k, v] of Object.entries(applied.previous)) {
            if (k !== 'mode')
                this._store.set(k, v);
        }
        return true;
    }
}

// The real settings: org.gnome.system.proxy and its http, https and socks children.
export function gnomeStore() {
    const schemas = new Map();
    const settings = child => {
        if (!schemas.has(child))
            schemas.set(child, new Gio.Settings({schema_id: child ? `org.gnome.system.proxy.${child}` : 'org.gnome.system.proxy'}));
        return schemas.get(child);
    };
    const split = key => (key.includes('.') ? key.split('.') : ['', key]);
    return {
        get(key) {
            const [child, name] = split(key);
            return name === 'port' ? settings(child).get_int(name) : settings(child).get_string(name);
        },
        set(key, value) {
            const [child, name] = split(key);
            if (name === 'port')
                settings(child).set_int(name, value);
            else
                settings(child).set_string(name, value);
        },
    };
}
