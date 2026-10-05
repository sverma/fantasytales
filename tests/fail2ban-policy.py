#!/usr/bin/env python3
"""Run on the server with fail2ban-regex installed; no firewall changes."""
import argparse
import collections
import configparser
import datetime
import json
from pathlib import Path
import re
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--filter', default='/etc/fail2ban/filter.d/fantasytales-probes.conf')
parser.add_argument('--logs', nargs='*', default=[])
args = parser.parse_args()
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%d/%b/%Y:%H:%M:%S %z')

def line(path, status=404, method='GET', ip='198.51.100.99', agent='Browser', referrer='-'):
    return f'{ip} - - [{stamp}] "{method} {path} HTTP/1.1" {status} 42 "{referrer}" "{agent}"\n'

bad_paths = ['/.env', '/.env.production', '/public/.env.backup', '/.git/HEAD',
             '/data/.git/config', '/.svn/entries', '/.aws/credentials', '/.ssh/id_rsa',
             '/id_rsa', '/wp-login.php', '/wp-admin/', '/blog/wp-content/plugins/shell.php',
             '/wp-includes/wlwmanifest.xml', '/xmlrpc.php', '/index.php?a=1',
             '/cgi-bin/.%2e/.%2e/bin/sh', '/boaform/admin/formLogin', '/HNAP1/',
             '/actuator/env', '//wp-includes/wlwmanifest.xml']
bad = [line(path) for path in bad_paths]
bad += [line('/.env', status=301), line('/.git/config', status=403, method='POST'),
        line('/wp-login.php', ip='2001:db8::99')]
good_paths = ['/', '/health', '/app.js?v=admin-members-1', '/styles.css',
              '/assets/nocturne.svg', '/favicon.ico', '/robots.txt', '/missing-page',
              '/.well-known/acme-challenge/token', '/media/sample/photo-02.jpg',
              '/api/session', '/api/profiles', '/api/events', '/api/auth/login',
              '/api/auth/signup', '/api/me', '/api/connections', '/api/admin/members',
              '/api/admin/members/99/reset-pin', '/api/admin/export',
              '/api/profiles?next=/.env', '/?q=/wp-login.php']
good = [line(path, status=status) for path in good_paths for status in [200, 301, 400, 401, 403, 404, 429]]
good += [line('/missing', agent='GET /.env HTTP/1.1'),
         line('/missing', referrer='https://example.org/wp-login.php'),
         line('/.env', status=200)]

def verify(path, expected=None):
    result = subprocess.run(['fail2ban-regex', str(path), args.filter], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    summary = re.search(r'Lines:\s*(\d+) lines,\s*(\d+) ignored,\s*(\d+) matched,\s*(\d+) missed', result.stdout)
    assert summary, result.stdout + result.stderr
    total, ignored, matched, missed = map(int, summary.groups())
    if expected is not None:
        assert matched == expected, result.stdout + result.stderr
    return {'lines': total, 'matched': matched, 'ignored': ignored, 'missed': missed}

with tempfile.TemporaryDirectory(prefix='fantasytales-f2b-policy-') as temp:
    good_file, bad_file = Path(temp) / 'normal.log', Path(temp) / 'probes.log'
    good_file.write_text(''.join(good)); bad_file.write_text(''.join(bad))
    output = {'normal_fixture': verify(good_file, 0), 'probe_fixture': verify(bad_file, len(bad)), 'real_logs': {}}
    config = configparser.ConfigParser(interpolation=None)
    config.read(args.filter)
    patterns = [re.compile(pattern.replace('<HOST>', r'(?P<ip>[0-9a-fA-F:.]+)'))
                for pattern in config['Definition']['failregex'].splitlines() if pattern]
    for index, name in enumerate(args.logs):
        counts = collections.Counter()
        normal_matches = 0
        snapshot = Path(temp) / f'real-log-{index}.log'
        snapshot.write_text(Path(name).read_text(errors='replace'))
        for entry in snapshot.read_text().splitlines():
            match = next((pattern.search(entry) for pattern in patterns if pattern.search(entry)), None)
            if match:
                counts[match['ip']] += 1
                if re.search(r'"\S+ /(?:media/[a-z]+/(?:portrait|photo-\d{2})\.(?:jpg|png)|api/(?:session|profiles|events|auth/(?:login|signup)|me|connections|admin/members)(?:\?[^ "]*)?) HTTP/', entry):
                    normal_matches += 1
        assert normal_matches == 0, 'A normal application route matched the scanner filter.'
        actual = verify(snapshot)
        assert sum(counts.values()) == actual['matched'], 'Replay and Fail2ban disagree.'
        output['real_logs'][name] = {**actual, 'normal_app_matches': normal_matches, 'top_probe_sources': counts.most_common(8)}
    print(json.dumps({'passed': True, **output}, indent=2))
