// The two languages, the country in client.conf and the system proxy: plain
// functions, no processes. The proxy runs against a fake store, never dconf.
import {LANGUAGES, pluralRu, setLanguage, systemLanguage} from '../psiphon-tunnel@terentiy/lang.js';
import {SystemProxy, proxyPlan, tunnelValues} from '../psiphon-tunnel@terentiy/proxy.js';
import {DEFAULT_REGIONS, NoticeLog, setEgressRegion} from '../psiphon-tunnel@terentiy/tunnel.js';
import {assert, deepEqual, equal, test} from './harness.js';

const {en, ru} = LANGUAGES;

function shape(o, path = '') {
    return Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object'
        ? shape(v, `${path}${k}.`) : [`${path}${k}:${typeof v}`])).sort();
}

test('both languages have every phrase, of the same kind', () => {
    deepEqual(shape(en), shape(ru));
    const cyrillic = /[А-Яа-яЁё]/;
    const strings = o => Object.values(o).flatMap(v => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? strings(v) : []));
    for (const s of strings(en).filter(s => s !== en.name))
        assert(!cyrillic.test(s), `Russian in English: ${s}`);
});

test('every country Psiphon offers has a name in both languages', () => {
    for (const code of DEFAULT_REGIONS) {
        assert(en.region(code) !== code, `no English name for ${code}`);
        assert(ru.region(code) !== code, `no Russian name for ${code}`);
    }
});

test('phrases that depend on how many', () => {
    equal(ru.sheet.text(['Codex']), 'Через туннель работает Codex. Если его закрыть, Codex останется без связи.');
    equal(ru.sheet.later(['Firefox', 'Codex']), 'Когда они закроются');
    equal(en.sheet.text(['Firefox', 'Codex']), 'Firefox and Codex are using the tunnel. Close it and they lose their connection.');
    equal(en.wait.text(['Codex']), "I'll turn it off once Codex closes");
    equal(ru.users.count(1), '1 программа');
    equal(ru.users.count(3), '3 программы');
    equal(ru.users.count(11), '11 программ');
    equal(en.users.count(1), '1 program');
    equal(pluralRu(22, 'a', 'b', 'c'), 'b');
    equal(en.tiles.drops(0), 'no drops');
    equal(ru.tiles.drops(2), '2 обрыва');
});

test('the language follows the system unless one is set', () => {
    equal(systemLanguage(['ru_RU.UTF-8', 'ru_RU', 'ru', 'C']), 'ru');
    equal(systemLanguage(['en_US.UTF-8', 'en', 'C']), 'en');
    equal(systemLanguage(['de_DE.UTF-8', 'de', 'C']), 'en');
    equal(systemLanguage(['de_DE', 'ru_RU', 'C']), 'ru', 'LANGUAGE=de:ru');
    equal(systemLanguage(['C']), 'en');
    equal(setLanguage('ru').code, 'ru');
    equal(setLanguage('en').code, 'en');
    equal(setLanguage('xx').code, systemLanguage());
});

// --- the country --------------------------------------------------------------

// The layout of the client.conf Psiphon's Linux installers hand out.
const CONF = `{
"LocalHttpProxyPort": 8081,
"LocalSocksProxyPort": 1081,
"EgressRegion": "US",
"SponsorId": "0000",
"UseIndistinguishableTLS":true
}
`;

test('a new country changes that one value and nothing else in the file', () => {
    const out = setEgressRegion(CONF, 'DE');
    equal(out, CONF.replace('"EgressRegion": "US"', '"EgressRegion": "DE"'));
    equal(setEgressRegion(out, ''), CONF.replace('"EgressRegion": "US"', '"EgressRegion": ""'));
    equal(setEgressRegion(CONF, 'US'), CONF, 'the same country leaves it as it is');
});

test('a config without EgressRegion gets it, in its own layout', () => {
    const indented = '{\n    "LocalHttpProxyPort": 8081,\n    "SponsorId": "0000"\n}\n';
    equal(setEgressRegion(indented, 'NL'),
        '{\n    "EgressRegion": "NL",\n    "LocalHttpProxyPort": 8081,\n    "SponsorId": "0000"\n}\n');
    const flat = '{"LocalHttpProxyPort": 8081}';
    deepEqual(JSON.parse(setEgressRegion(flat, 'NL')), {EgressRegion: 'NL', LocalHttpProxyPort: 8081});
    deepEqual(JSON.parse(setEgressRegion('{}', 'NL')), {EgressRegion: 'NL'});
});

test('a config it cannot edit in place is written out whole, the same settings', () => {
    // the name inside a nested object first: the in-place edit would hit the wrong one
    const nested = '{"Sub": {"EgressRegion": "X"}, "EgressRegion": "US"}';
    deepEqual(JSON.parse(setEgressRegion(nested, 'SE')), {Sub: {EgressRegion: 'X'}, EgressRegion: 'SE'});
});

test('nonsense is refused, and the file is never half-written', () => {
    for (const bad of ['DEU', 'de', '1', null]) {
        let threw = false;
        try {
            setEgressRegion(CONF, bad);
        } catch {
            threw = true;
        }
        assert(threw, `took ${bad}`);
    }
    for (const text of ['not json', '[1]', 'null']) {
        let threw = false;
        try {
            setEgressRegion(text, 'DE');
        } catch {
            threw = true;
        }
        assert(threw, `edited ${text}`);
    }
});

test('the offered countries are read from the log', () => {
    const log = new NoticeLog();
    log.feed(`${JSON.stringify({data: {regions: ['DE', 'NL']}, noticeType: 'AvailableEgressRegions',
        timestamp: '2026-10-21T10:00:00Z'})}\n`);
    deepEqual(log.regions, ['DE', 'NL']);
});

// --- the system proxy ---------------------------------------------------------------

function fakeStore(values = {}) {
    const v = {'mode': 'none', 'http.host': '', 'http.port': 8080, 'https.host': '', 'https.port': 0,
        'socks.host': '', 'socks.port': 0, ...values};
    const writes = [];
    return {
        v,
        writes,
        get: k => v[k],
        set: (k, x) => {
            writes.push(k);
            v[k] = x;
        },
    };
}

const PORTS = {http: 8081, socks: 1081};

test('the proxy follows the tunnel: on once it is up, off once Psiphon is gone', () => {
    const applied = {http: 8081, socks: 1081};
    equal(proxyPlan({want: true, state: 'connecting', ports: PORTS, applied: null}), null, 'not before the tunnel is up');
    equal(proxyPlan({want: true, state: 'on', ports: PORTS, applied: null}), 'apply');
    equal(proxyPlan({want: false, state: 'on', ports: PORTS, applied: null}), null);
    equal(proxyPlan({want: true, state: 'reconnecting', ports: PORTS, applied}), null, 'kept through a drop');
    equal(proxyPlan({want: true, state: 'stopping', ports: PORTS, applied}), null);
    equal(proxyPlan({want: true, state: 'off', ports: PORTS, applied}), 'restore');
    equal(proxyPlan({want: true, state: 'failed', ports: PORTS, applied}), 'restore');
    equal(proxyPlan({want: true, state: 'off', ports: PORTS, applied, holding: true}), null, 'kept through a country switch');
    equal(proxyPlan({want: false, state: 'on', ports: PORTS, applied}), 'restore', 'switched off');
    equal(proxyPlan({want: true, state: 'on', ports: {http: 9000, socks: 1081}, applied}), 'apply', 'new ports');
});

test('the proxy is pointed at the tunnel and put back exactly as it was', () => {
    const store = fakeStore({'mode': 'auto', 'http.host': 'corp', 'http.port': 3128});
    const before = {...store.v};
    const sp = new SystemProxy(store);
    const applied = sp.apply(PORTS);
    deepEqual(store.v, {...before, ...tunnelValues(PORTS)});
    equal(store.writes[store.writes.length - 1], 'mode', 'the mode goes last');
    deepEqual(applied.previous, before);

    // new ports: the first "before" is the one kept
    const again = sp.apply({http: 9000, socks: 9001}, applied);
    deepEqual(again.previous, before);
    store.writes.length = 0;
    assert(sp.restore(again));
    deepEqual(store.v, before);
    equal(store.writes[0], 'mode', 'the mode goes first');
});

test('a proxy someone changed meanwhile is theirs: left alone', () => {
    const store = fakeStore();
    const sp = new SystemProxy(store);
    const applied = sp.apply(PORTS);
    store.v['http.port'] = 3128;
    assert(!sp.restore(applied));
    equal(store.v.mode, 'manual');
    equal(store.v['http.port'], 3128);
});
