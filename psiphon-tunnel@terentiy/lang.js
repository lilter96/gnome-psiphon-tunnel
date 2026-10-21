// The words of the popup, the notifications and the settings, in English and
// in Russian. Plain data and small functions, no Shell, so the tests check
// both languages under plain gjs. T is the language in use: '' in the
// settings follows the system, and anything without Russian gets English.

import GLib from 'gi://GLib';

// Country names for Psiphon's egress regions, and a few more it has offered.
const REGIONS = {
    AE: ['United Arab Emirates', 'ОАЭ'], AM: ['Armenia', 'Армения'], AT: ['Austria', 'Австрия'],
    AU: ['Australia', 'Австралия'], BE: ['Belgium', 'Бельгия'], BG: ['Bulgaria', 'Болгария'],
    BR: ['Brazil', 'Бразилия'], CA: ['Canada', 'Канада'], CH: ['Switzerland', 'Швейцария'],
    CY: ['Cyprus', 'Кипр'], CZ: ['Czechia', 'Чехия'], DE: ['Germany', 'Германия'],
    DK: ['Denmark', 'Дания'], EE: ['Estonia', 'Эстония'], ES: ['Spain', 'Испания'],
    FI: ['Finland', 'Финляндия'], FR: ['France', 'Франция'], GB: ['United Kingdom', 'Великобритания'],
    GE: ['Georgia', 'Грузия'], GR: ['Greece', 'Греция'], HK: ['Hong Kong', 'Гонконг'],
    HR: ['Croatia', 'Хорватия'], HU: ['Hungary', 'Венгрия'], ID: ['Indonesia', 'Индонезия'],
    IE: ['Ireland', 'Ирландия'], IL: ['Israel', 'Израиль'], IN: ['India', 'Индия'],
    IS: ['Iceland', 'Исландия'], IT: ['Italy', 'Италия'], JP: ['Japan', 'Япония'],
    KR: ['South Korea', 'Южная Корея'], KZ: ['Kazakhstan', 'Казахстан'], LT: ['Lithuania', 'Литва'],
    LU: ['Luxembourg', 'Люксембург'], LV: ['Latvia', 'Латвия'], MD: ['Moldova', 'Молдова'],
    MX: ['Mexico', 'Мексика'], MY: ['Malaysia', 'Малайзия'], NL: ['Netherlands', 'Нидерланды'],
    NO: ['Norway', 'Норвегия'], NZ: ['New Zealand', 'Новая Зеландия'], PL: ['Poland', 'Польша'],
    PT: ['Portugal', 'Португалия'], RO: ['Romania', 'Румыния'], RS: ['Serbia', 'Сербия'],
    SE: ['Sweden', 'Швеция'], SG: ['Singapore', 'Сингапур'], SI: ['Slovenia', 'Словения'],
    SK: ['Slovakia', 'Словакия'], TR: ['Turkey', 'Турция'], TW: ['Taiwan', 'Тайвань'],
    UA: ['Ukraine', 'Украина'], US: ['United States', 'США'], ZA: ['South Africa', 'ЮАР'],
};

// 3 h 12 min, 45 min, 40 s, 2 d 3 h
function duration(seconds, [sec, min, hour, day]) {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60)
        return `${s} ${sec}`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m} ${min}`;
    const h = Math.floor(m / 60), r = m % 60;
    if (h < 24)
        return r ? `${h} ${hour} ${r} ${min}` : `${h} ${hour}`;
    const d = Math.floor(h / 24), rh = h % 24;
    return rh ? `${d} ${day} ${rh} ${hour}` : `${d} ${day}`;
}

// 12 KB/s, 1.4 MB/s
function rate(bytes, units, point) {
    let v = Math.max(0, bytes), i = 0;
    while (v >= 1000 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    const n = v < 10 && i > 0 ? v.toFixed(1).replace('.', point) : String(Math.round(v));
    return `${n} ${units[i]}`;
}

// A, A and B, A, B and C
function join(names, and) {
    if (names.length <= 1)
        return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} ${and} ${names[names.length - 1]}`;
}

const seconds = (ms, point) => (ms / 1000).toFixed(1).replace('.', point);

export function pluralRu(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11)
        return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14))
        return few;
    return many;
}

const en = {
    code: 'en',
    name: 'English',
    region: code => REGIONS[code]?.[0] ?? code ?? '',
    duration: s => duration(s, ['s', 'min', 'h', 'd']),
    rate: b => rate(b, ['B/s', 'KB/s', 'MB/s', 'GB/s'], '.'),
    ago: s => (s < 60 ? 'just now' : `${en.duration(s)} ago`),
    join: names => join(names, 'and'),

    titles: {
        off: 'Tunnel is off',
        starting: 'Starting Psiphon',
        connecting: 'Digging a tunnel…',
        on: 'Tunnel is open',
        reconnecting: 'Lost the line, digging again',
        stopping: 'Closing the tunnel',
        switching: 'Changing the country',
    },
    failed: {port: 'Port taken', missing: 'Psiphon not found', crash: 'Psiphon crashed'},
    sub: {
        closedIn: ms => `Closed cleanly in ${seconds(ms, '.')} s`,
        killed: s => `Psiphon did not answer in ${s} s, so it was killed`,
        stuck: 'Psiphon will not stop, have a look in a terminal',
        asleep: 'The mole is asleep, Psiphon is not running',
        moment: 'Just a second…',
        searching: (clock, where) => `Looking for a server${where ? ` in ${where}` : ''} · ${clock}`,
        offline: (clock, was) => `No connection for ${clock}${was ? ` · was ${was}` : ''}`,
        goodbye: 'Psiphon is saying goodbye to the server',
        switching: where => `Next: ${where}`,
        portTaken: port => `Port ${port} is taken by another program`,
        noFile: path => `No file at ${path}. install.sh from the repository sets it up`,
        crashedWith: message => `Closed by itself: ${message}`,
        crashed: 'Closed by itself without a goodbye',
    },
    main: {on: 'Turn on', again: 'Start again', retry: 'Try again', stopping: 'Turning off…', off: 'Turn off'},
    sheet: {
        text: names => (names.length > 1
            ? `${en.join(names)} are using the tunnel. Close it and they lose their connection.`
            : `${names[0]} is using the tunnel. Close it and ${names[0]} loses its connection.`),
        later: names => (names.length > 1 ? 'When they close' : `When ${names[0]} closes`),
        now: 'Turn off now',
        cancel: 'Cancel',
    },
    wait: {
        text: names => `I'll turn it off once ${en.join(names)} ${names.length > 1 ? 'close' : 'closes'}`,
        stopping: 'Turning off…',
        keep: 'Keep it on',
        now: 'Turn off now',
    },
    tiles: {
        server: 'Server',
        searching: 'searching…',
        auto: 'picked by Psiphon',
        chosen: 'your choice',
        changed: n => `changed ${n} ${n === 1 ? 'time' : 'times'}`,
        open: 'Open',
        running: 'Psiphon running',
        drops: n => (n ? `${n} ${n === 1 ? 'drop' : 'drops'}` : 'no drops'),
        dropsIn: (drops, time) => `${drops} in ${time}`,
        latency: 'Latency',
        onceUp: 'once connected',
        measuring: 'measuring',
        noAnswer: 'no answer',
        checkFailed: 'check failed',
        ms: n => `${n} ms`,
        through: 'through the tunnel',
        traffic: 'Traffic',
        counting: 'counting',
    },
    users: {
        through: 'Through the tunnel',
        waiting: 'Waiting for the tunnel',
        count: n => `${n} ${n === 1 ? 'program' : 'programs'}`,
        nobodyNow: 'Nobody right now',
        nobodyYet: 'Nobody yet',
        waits: 'waiting',
        live: 'connected',
        seen: s => en.ago(s),
        env: 'set to use it',
        more: n => `and ${n} more`,
    },
    copies: n => `${n} copies running`,
    settings: {
        country: 'Country',
        fastest: 'Fastest',
        proxy: 'System proxy',
        proxyIdle: 'for browsers and GNOME apps',
        proxyLater: 'comes on with the tunnel',
        proxyOn: 'browsers go through the tunnel',
    },
    picker: {
        back: 'Back',
        title: 'Country',
        fastest: 'Psiphon picks the fastest',
        restart: 'The tunnel reconnects through the new country, a few seconds without a connection.',
    },
    notify: {
        closedTitle: 'Tunnel closed',
        closedBody: names => `${en.join(names)} closed, so the mole closed the tunnel.`,
        agreed: 'The mole closed the tunnel, as agreed.',
        crashTitle: 'Psiphon crashed',
        portBody: port => `Port ${port} is taken by another program.`,
        crashBody: 'Psiphon closed by itself without a goodbye. Everything that went through the tunnel lost its connection.',
        again: 'Start again',
        countryTitle: 'Country not saved',
        countryBody: message => `Could not change client.conf: ${message}`,
    },
    a11y: {
        on: region => `Psiphon: tunnel open${region ? `, ${region}` : ''}`,
        off: 'Psiphon is off',
        failed: 'Psiphon crashed',
        connecting: 'Psiphon: connecting',
    },
    prefs: {
        general: 'General',
        language: 'Language',
        languageSub: 'Of the popup and the notifications',
        system: 'Same as the system',
        proxySub: 'While the tunnel is open, the GNOME proxy setting points at it, so browsers and GNOME apps go through it. Put back as it was once Psiphon stops.',
        psiphon: 'Psiphon',
        folder: 'Folder',
        openFolder: 'Open the folder',
        commands: 'In a terminal',
    },
};

const ru = {
    code: 'ru',
    name: 'Русский',
    region: code => REGIONS[code]?.[1] ?? code ?? '',
    duration: s => duration(s, ['с', 'мин', 'ч', 'д']),
    rate: b => rate(b, ['Б/с', 'КБ/с', 'МБ/с', 'ГБ/с'], ','),
    ago: s => (s < 60 ? 'только что' : `${ru.duration(s)} назад`),
    join: names => join(names, 'и'),

    titles: {
        off: 'Туннель выключен',
        starting: 'Запускаем Psiphon',
        connecting: 'Роем туннель…',
        on: 'Туннель открыт',
        reconnecting: 'Связь пропала, роем заново',
        stopping: 'Закрываем туннель',
        switching: 'Меняем страну',
    },
    failed: {port: 'Порт занят', missing: 'Psiphon не найден', crash: 'Psiphon упал'},
    sub: {
        closedIn: ms => `Закрыт аккуратно за ${seconds(ms, ',')} с`,
        killed: s => `Psiphon не ответил за ${s} с, остановлен силой`,
        stuck: 'Psiphon не останавливается, загляни в терминал',
        asleep: 'Крот спит, Psiphon не запущен',
        moment: 'Секунду…',
        searching: (clock, where) => `Ищем сервер${where ? ` · ${where}` : ''} · ${clock}`,
        offline: (clock, was) => `Без связи ${clock}${was ? ` · был ${was}` : ''}`,
        goodbye: 'Psiphon прощается с сервером',
        switching: where => `Новая страна: ${where}`,
        portTaken: port => `Порт ${port} занят другой программой`,
        noFile: path => `Нет файла ${path}. Его ставит install.sh из репозитория`,
        crashedWith: message => `Закрылся сам: ${message}`,
        crashed: 'Закрылся сам, не попрощавшись',
    },
    main: {on: 'Включить', again: 'Запустить снова', retry: 'Попробовать снова', stopping: 'Выключаем…', off: 'Выключить'},
    sheet: {
        text: names => (names.length > 1
            ? `Через туннель работают ${ru.join(names)}. Если его закрыть, они останутся без связи.`
            : `Через туннель работает ${names[0]}. Если его закрыть, ${names[0]} останется без связи.`),
        later: names => (names.length > 1 ? 'Когда они закроются' : `Когда закроется ${names[0]}`),
        now: 'Выключить сейчас',
        cancel: 'Отмена',
    },
    wait: {
        text: names => `Выключу, когда ${names.length > 1 ? 'закроются' : 'закроется'} ${ru.join(names)}`,
        stopping: 'Выключаю…',
        keep: 'Не выключать',
        now: 'Выключить сейчас',
    },
    tiles: {
        server: 'Сервер',
        searching: 'ищем…',
        auto: 'выбрал Psiphon',
        chosen: 'твой выбор',
        changed: n => `сменился ${n} ${pluralRu(n, 'раз', 'раза', 'раз')}`,
        open: 'Открыт',
        running: 'Psiphon работает',
        drops: n => (n ? `${n} ${pluralRu(n, 'обрыв', 'обрыва', 'обрывов')}` : 'без обрывов'),
        dropsIn: (drops, time) => `${drops} за ${time}`,
        latency: 'Отклик',
        onceUp: 'когда будет связь',
        measuring: 'меряем',
        noAnswer: 'нет ответа',
        checkFailed: 'проверка не прошла',
        ms: n => `${n} мс`,
        through: 'через туннель',
        traffic: 'Трафик',
        counting: 'считаем',
    },
    users: {
        through: 'Через туннель',
        waiting: 'Ждут туннель',
        count: n => `${n} ${pluralRu(n, 'программа', 'программы', 'программ')}`,
        nobodyNow: 'Сейчас никто',
        nobodyYet: 'Пока никого',
        waits: 'ждёт',
        live: 'на связи',
        seen: s => `был ${ru.ago(s)}`,
        env: 'настроен на туннель',
        more: n => `и ещё ${n}`,
    },
    copies: n => `запущено копий: ${n}`,
    settings: {
        country: 'Страна',
        fastest: 'Самая быстрая',
        proxy: 'Системный прокси',
        proxyIdle: 'для браузеров и приложений GNOME',
        proxyLater: 'включится вместе с туннелем',
        proxyOn: 'браузеры идут через туннель',
    },
    picker: {
        back: 'Назад',
        title: 'Страна',
        fastest: 'Psiphon выберет самую быструю',
        restart: 'Туннель переподключится через новую страну, связи не будет несколько секунд.',
    },
    notify: {
        closedTitle: 'Туннель закрыт',
        closedBody: names => `${ru.join(names)} ${names.length > 1 ? 'закрылись' : 'закрылся'}, и крот закрыл туннель.`,
        agreed: 'Крот закрыл туннель, как договаривались.',
        crashTitle: 'Psiphon упал',
        portBody: port => `Порт ${port} занят другой программой.`,
        crashBody: 'Psiphon закрылся сам, не попрощавшись. Всё, что шло через туннель, осталось без связи.',
        again: 'Запустить снова',
        countryTitle: 'Страна не сохранилась',
        countryBody: message => `Не получилось изменить client.conf: ${message}`,
    },
    a11y: {
        on: region => `Psiphon: туннель открыт${region ? `, ${region}` : ''}`,
        off: 'Psiphon выключен',
        failed: 'Psiphon упал',
        connecting: 'Psiphon: подключается',
    },
    prefs: {
        general: 'Общие',
        language: 'Язык',
        languageSub: 'Попапа и уведомлений',
        system: 'Как в системе',
        proxySub: 'Пока туннель открыт, настройка прокси GNOME смотрит на него, и браузеры с приложениями GNOME идут через туннель. Когда Psiphon остановится, всё вернётся как было.',
        psiphon: 'Psiphon',
        folder: 'Папка',
        openFolder: 'Открыть папку',
        commands: 'В терминале',
    },
};

export const LANGUAGES = {en, ru};

// The first of the user's languages we have, else English.
export function systemLanguage(names = GLib.get_language_names()) {
    for (const name of names) {
        const code = /^([a-z]{2,3})(?=[_.@]|$)/.exec(name)?.[1];
        if (code && code in LANGUAGES)
            return code;
    }
    return 'en';
}

export let T = LANGUAGES[systemLanguage()];

// code: 'en', 'ru', or '' for the system's.
export function setLanguage(code = '') {
    T = LANGUAGES[code] ?? LANGUAGES[systemLanguage()];
    return T;
}
