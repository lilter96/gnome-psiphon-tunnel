/* A stand-in for Psiphon's console client, for tests. It takes the same
 * -config flag, listens on the HTTP port from the config, prints notices the
 * way Psiphon does and says goodbye on SIGTERM. Knobs, from the environment:
 *   FAKE_IGNORE_TERM=1   ignore SIGTERM, so only SIGKILL stops it
 *   FAKE_CRASH_MS=n      die after n ms without a goodbye
 *   FAKE_REGION=XX       the server region to report, unless the config's
 *                        EgressRegion asks for one
 *   FAKE_REGIONS=A,B     the regions it offers (DE,NL,NO,SE,US)
 */
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t term;

static void on_term(int sig) { (void)sig; term = 1; }

static void notice(const char *type, const char *data) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    struct tm tm;
    gmtime_r(&tv.tv_sec, &tm);
    char ts[32];
    strftime(ts, sizeof ts, "%Y-%m-%dT%H:%M:%S", &tm);
    fprintf(stderr, "{\"data\":%s,\"noticeType\":\"%s\",\"timestamp\":\"%s.%03ldZ\"}\n",
            data, type, ts, (long)(tv.tv_usec / 1000));
    fflush(stderr);
}

static int port_from(const char *path, const char *key) {
    FILE *f = fopen(path, "r");
    if (!f) return 0;
    char buf[8192];
    size_t n = fread(buf, 1, sizeof buf - 1, f);
    fclose(f);
    buf[n] = 0;
    char *p = strstr(buf, key);
    if (!p) return 0;
    p = strchr(p, ':');
    return p ? atoi(p + 1) : 0;
}

/* The string value of key in the config, into out; "" if there is none. */
static void string_from(const char *path, const char *key, char *out, size_t size) {
    out[0] = 0;
    FILE *f = fopen(path, "r");
    if (!f) return;
    char buf[8192];
    size_t n = fread(buf, 1, sizeof buf - 1, f);
    fclose(f);
    buf[n] = 0;
    char *p = strstr(buf, key);
    if (!p || !(p = strchr(p + strlen(key), ':')) || !(p = strchr(p, '"'))) return;
    char *end = strchr(++p, '"');
    if (!end || (size_t)(end - p) >= size) return;
    memcpy(out, p, end - p);
    out[end - p] = 0;
}

int main(int argc, char **argv) {
    const char *conf = NULL;
    for (int i = 1; i + 1 < argc; i++)
        if (!strcmp(argv[i], "-config")) conf = argv[i + 1];
    if (!conf) return 2;
    int http = port_from(conf, "\"LocalHttpProxyPort\"");
    int socks = port_from(conf, "\"LocalSocksProxyPort\"");
    char egress[8];
    string_from(conf, "\"EgressRegion\"", egress, sizeof egress);
    const char *region = egress[0] ? egress : getenv("FAKE_REGION") ? getenv("FAKE_REGION") : "NO";
    const char *offered = getenv("FAKE_REGIONS") ? getenv("FAKE_REGIONS") : "DE,NL,NO,SE,US";
    int crash = getenv("FAKE_CRASH_MS") ? atoi(getenv("FAKE_CRASH_MS")) : 0;

    if (getenv("FAKE_IGNORE_TERM")) signal(SIGTERM, SIG_IGN);
    else signal(SIGTERM, on_term);
    signal(SIGINT, on_term);

    notice("NetworkID", "{\"ID\":\"UNKNOWN\"}");
    int s = socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(http),
                            .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
    if (bind(s, (struct sockaddr *)&a, sizeof a) || listen(s, 8)) {
        char d[32];
        snprintf(d, sizeof d, "{\"port\":%d}", http);
        notice("HttpProxyPortInUse", d);
        return 0;
    }
    char d[160];
    snprintf(d, sizeof d, "{\"port\":%d}", socks);
    notice("ListeningSocksProxyPort", d);
    snprintf(d, sizeof d, "{\"port\":%d}", http);
    notice("ListeningHttpProxyPort", d);
    char list[512] = "{\"regions\":[";
    for (const char *r = offered; *r;) {
        size_t len = strcspn(r, ",");
        if (len == 2 && strlen(list) + 8 < sizeof list) {
            strcat(list, list[12] ? ",\"" : "\"");
            strncat(list, r, 2);
            strcat(list, "\"");
        }
        r += len + (r[len] == ',');
    }
    strcat(list, "]}");
    notice("AvailableEgressRegions", list);
    usleep(150 * 1000);
    notice("Tunnels", "{\"count\":1}");
    snprintf(d, sizeof d, "{\"serverRegion\":\"%s\"}", region);
    notice("ConnectedServerRegion", d);

    for (int ms = 0; !term; ms += 10) {
        usleep(10 * 1000);
        if (crash && ms >= crash) _exit(3);
    }
    usleep(40 * 1000);
    notice("Tunnels", "{\"count\":0}");
    notice("Exiting", "{}");
    return 0;
}
