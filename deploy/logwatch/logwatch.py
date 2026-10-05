#!/usr/bin/python3
"""Read-only Nginx combined access-log viewer with offline IP geolocation."""
import argparse
from collections import OrderedDict
import csv
from datetime import datetime, timedelta, timezone
import ipaddress
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

DEFAULT_LOGS = ['/var/log/nginx/access.log', '/var/log/nginx/fantasytales-access.log']
DATABASE = '/var/lib/fantasytales-logwatch/country.mmdb'
HEADER = ['Date_IST', 'Day_IST', 'Time_IST', 'COUNTRY_OF_IP', 'ERROR|SUCCESS', 'Device', 'IP_ADDRESS']
IST = timezone(timedelta(hours=5, minutes=30), 'IST')
WEEKDAYS = ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday')
QUOTED = r'"(?:[^"\\]|\\.)*"'
COMBINED = re.compile(
    r'^(?P<ip>\S+)\s+\S+\s+\S+\s+\[(?P<timestamp>[^\]]+)\]\s+' + QUOTED +
    r'\s+(?P<status>[1-5]\d{2})\s+(?:\d+|-)\s+' + QUOTED +
    r'\s+"(?P<ua>(?:[^"\\]|\\.)*)"\s*$'
)


def parse_line(line):
    match = COMBINED.match(line.rstrip('\r\n'))
    if not match or '%' in match['ip']:
        return None
    try:
        address = ipaddress.ip_address(match['ip'])
        visited_at = datetime.strptime(match['timestamp'], '%d/%b/%Y:%H:%M:%S %z').astimezone(IST)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    agent = re.sub(r'\\x([0-9a-fA-F]{2})', lambda m: chr(int(m[1], 16)), match['ua'])
    return address, int(match['status']), agent, visited_at


def visit_columns(visited_at):
    return [visited_at.date().isoformat(), WEEKDAYS[visited_at.weekday()], visited_at.strftime('%H:%M:%S')]


def device(agent):
    ua = agent.lower()
    if any(x in ua for x in ('bot', 'spider', 'crawler', 'zgrab', 'masscan', 'nmap',
                              'nikto', 'sqlmap', 'nuclei', 'censys', 'expanse', 'scanner')):
        return 'Bot/Scanner'
    if any(x in ua for x in ('curl/', 'wget/', 'python-', 'python/', 'go-http-client',
                              'httpclient', 'aiohttp', 'libwww', 'postmanruntime', 'undici', 'node-fetch')):
        return 'CLI/Script'
    if 'ipad' in ua or ('macintosh' in ua and 'mobile/' in ua):
        return 'Tablet (iPadOS)'
    if 'android' in ua:
        return 'Mobile (Android)' if 'mobile' in ua else 'Tablet (Android)'
    if 'iphone' in ua or 'ipod' in ua:
        return 'Mobile (iOS)'
    if 'windows phone' in ua:
        return 'Mobile (Windows)'
    if 'tablet' in ua or 'kindle' in ua or 'silk/' in ua:
        return 'Tablet'
    if 'mobile' in ua:
        return 'Mobile'
    if 'windows' in ua:
        return 'Desktop (Windows)'
    if 'macintosh' in ua or 'mac os x' in ua:
        return 'Desktop (macOS)'
    if 'cros' in ua:
        return 'Desktop (ChromeOS)'
    if 'linux' in ua or 'x11' in ua:
        return 'Desktop (Linux)'
    return 'Unknown'


class Countries:
    def __init__(self, path, opener=None):
        if opener is None:
            import maxminddb
            opener = maxminddb.open_database
        self.opener = opener
        self.path = Path(path)
        self.reader = None
        self.signature = None
        self.next_check = 0
        self.cache = OrderedDict()
        self.refresh()

    def refresh(self):
        self.next_check = time.monotonic() + 60
        try:
            stat = self.path.stat()
            signature = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
            if signature != self.signature:
                reader = self.opener(str(self.path))
                previous, self.reader = self.reader, reader
                self.signature = signature
                self.cache.clear()
                if previous:
                    previous.close()
        except (OSError, ValueError) as exc:
            if self.reader is None:
                raise
            print('Country database reload failed; keeping the previous database (' +
                  type(exc).__name__ + ').', file=sys.stderr, flush=True)

    def lookup(self, address):
        if not address.is_global or address.is_multicast or address.is_reserved:
            return 'LOCAL/RESERVED'
        if time.monotonic() >= self.next_check:
            self.refresh()
        key = str(address)
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key]
        record = self.reader.get(key) or {}
        country = record.get('country', {})
        code = country.get('iso_code', '')
        name = country.get('names', {}).get('en', '')
        # Country data is trusted, but still prohibit terminal controls and CSV formulas.
        name = ''.join(c for c in name if c.isprintable()).strip()
        if not re.fullmatch(r'[A-Z]{2}', code) or not name or name[0] in '=+-@':
            label = 'UNKNOWN'
        else:
            label = f'{name} ({code})'
        self.cache[key] = label
        if len(self.cache) > 4096:
            self.cache.popitem(last=False)
        return label

    def close(self):
        if self.reader:
            self.reader.close()


def nonnegative(value):
    result = int(value)
    if result < 0:
        raise argparse.ArgumentTypeError('must be zero or greater')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog=(
        'Date, day, and 24-hour time come from the Nginx request timestamp, converted to IST (UTC+05:30). '
        'HTTP 100–399 = SUCCESS; 400–599 = ERROR. Device is inferred from User-Agent. '
        'Geolocation by DB-IP.com (https://db-ip.com), CC BY 4.0; approximate, not identity. '
        'Access logs only. Ctrl+C stops the viewer.'))
    parser.add_argument('logs', nargs='*', help='combined access logs (defaults to both Nginx logs)')
    parser.add_argument('--database', default=DATABASE, help='local country MMDB')
    parser.add_argument('--lines', type=nonnegative, default=20, help='existing lines per file (default: 20)')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--once', action='store_true', help='print existing lines and exit')
    mode.add_argument('--stdin', action='store_true', help='read combined access logs from stdin')
    parser.add_argument('--no-header', action='store_true')
    parser.add_argument('--errors-only', action='store_true', help='only output HTTP 400–599')
    args = parser.parse_args()
    countries, child = None, None
    skipped = 0
    try:
        countries = Countries(args.database)
        if args.stdin:
            source = sys.stdin
        else:
            paths = args.logs or DEFAULT_LOGS
            # Fail visibly on missing permissions instead of running a silent empty viewer.
            for path in paths:
                with open(path, 'rb'):
                    pass
            command = ['/usr/bin/tail', '-q', '-n', str(args.lines)]
            if not args.once:
                command += ['-F', '--sleep-interval=0.5', '--max-unchanged-stats=1',
                            '--pid=' + str(os.getpid())]
            command += ['--', *paths]
            child = subprocess.Popen(command, stdout=subprocess.PIPE, text=True,
                                     encoding='utf-8', errors='replace')
            source = child.stdout
        output = csv.writer(sys.stdout, lineterminator='\n')
        if not args.no_header:
            output.writerow(HEADER)
            sys.stdout.flush()
        for line in source:
            parsed = parse_line(line)
            if parsed is None:
                skipped += 1
                if skipped == 1 or skipped % 1000 == 0:
                    print(f'Skipped {skipped} malformed/non-combined access-log record(s).',
                          file=sys.stderr, flush=True)
                continue
            address, status, agent, visited_at = parsed
            if args.errors_only and status < 400:
                continue
            output.writerow([*visit_columns(visited_at), countries.lookup(address), 'ERROR' if status >= 400 else 'SUCCESS',
                             device(agent), str(address)])
            sys.stdout.flush()
        if child:
            code = child.wait()
            if code or not args.once:
                raise RuntimeError('Nginx log follower stopped unexpectedly')
        return 0
    except (KeyboardInterrupt, BrokenPipeError):
        return 0
    except Exception as exc:
        print(f'Log watcher failed ({type(exc).__name__}): {exc}', file=sys.stderr, flush=True)
        return 1
    finally:
        if child and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        if countries:
            countries.close()


def stop(*_):
    raise KeyboardInterrupt


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, stop)
    sys.exit(main())
