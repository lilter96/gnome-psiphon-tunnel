// install.sh: turns the downloaded client config into ours. The fastest
// country, Psiphon's data in its own folder, ports nothing listens on yet.
//
//   gjs -m tools/client-conf.js <client.conf> <data dir>    -> "<http> <socks>"
import GLib from 'gi://GLib';

import {busyPorts} from '../psiphon-tunnel@terentiy/psiphon.js';

const [path, data] = ARGV;
const config = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(path)[1]));
if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error(`${path}: not a Psiphon config`);

// the usual port, or the next one nobody holds
const busy = busyPorts();
const free = from => {
    for (let port = from; port < from + 100; port++) {
        if (!busy.has(port)) {
            busy.add(port);
            return port;
        }
    }
    throw new Error(`no free port from ${from}`);
};

config.LocalHttpProxyPort = free(8081);
config.LocalSocksProxyPort = free(1081);
config.EgressRegion = '';
config.DataRootDirectory = data;
GLib.file_set_contents(path, `${JSON.stringify(config, null, 4)}\n`);
print(`${config.LocalHttpProxyPort} ${config.LocalSocksProxyPort}`);
