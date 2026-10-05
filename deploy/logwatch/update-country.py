#!/usr/bin/python3
"""Install the newest DB-IP Lite country database atomically; no visitor data leaves the host."""
import datetime
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.request

import maxminddb

ROOT = Path('/var/lib/fantasytales-logwatch')
PAGE = 'https://db-ip.com/db/download/ip-to-country-lite'
ATTRIBUTION = ('IP geolocation by DB-IP.com: https://db-ip.com\n'
               'DB-IP IP-to-Country Lite, Creative Commons Attribution 4.0.\n'
               'License: https://creativecommons.org/licenses/by/4.0/\n'
               'Approximate network country; not a verified visitor location.\n')


def open_url(url):
    return urllib.request.urlopen(urllib.request.Request(
        url, headers={'User-Agent': 'FantasyTales-GeoDB-Updater/1.0'}), timeout=45)


def update():
    ROOT.mkdir(mode=0o755, parents=True, exist_ok=True)
    with (ROOT / '.update.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with open_url(PAGE) as response:
            html = response.read(2_000_001)
        if len(html) > 2_000_000:
            raise ValueError('Download page exceeded size limit')
        releases = re.findall(
            r'https://download\.db-ip\.com/free/dbip-country-lite-(\d{4}-\d{2})\.mmdb\.gz',
            html.decode('utf-8'))
        if not releases:
            raise ValueError('No official country MMDB download found')
        release = max(releases)
        target = ROOT / 'country.mmdb'
        metadata_path = ROOT / 'country.json'
        if target.exists() and metadata_path.exists():
            metadata = json.loads(metadata_path.read_text())
            if metadata.get('release', '') >= release:
                with maxminddb.open_database(str(target)) as reader:
                    reader.metadata()
                print(f'Country database is current ({metadata["release"]}).')
                return
        url = f'https://download.db-ip.com/free/dbip-country-lite-{release}.mmdb.gz'
        with tempfile.TemporaryDirectory(prefix='.download-', dir=ROOT) as temp:
            compressed = Path(temp) / 'country.mmdb.gz'
            with open_url(url) as response, compressed.open('wb') as output:
                size = 0
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > 64 * 1024 * 1024:
                        raise ValueError('Download exceeded size limit')
                    output.write(chunk)
            database = Path(temp) / 'country.mmdb'
            with gzip.open(compressed, 'rb') as source, database.open('wb') as output:
                size = 0
                while chunk := source.read(1024 * 1024):
                    size += len(chunk)
                    if size > 256 * 1024 * 1024:
                        raise ValueError('Uncompressed database exceeded size limit')
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            with maxminddb.open_database(str(database)) as reader:
                metadata = reader.metadata()
                if metadata.ip_version != 6 or metadata.node_count < 10000:
                    raise ValueError('Unexpected database metadata')
                for address in ('8.8.8.8', '2001:4860:4860::8888'):
                    if not re.fullmatch(r'[A-Z]{2}', (reader.get(address) or {}).get('country', {}).get('iso_code', '')):
                        raise ValueError('Database failed IPv4/IPv6 validation')
            digest = hashlib.sha256(database.read_bytes()).hexdigest()
            database.chmod(0o644)
            os.replace(database, target)
            metadata = Path(temp) / 'country.json'
            metadata.write_text(json.dumps({
                'release': release, 'source': url, 'sha256': digest,
                'installed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            }, indent=2) + '\n')
            metadata.chmod(0o644)
            os.replace(metadata, metadata_path)
        (ROOT / 'ATTRIBUTION.txt').write_text(ATTRIBUTION)
        print(f'Installed DB-IP Lite {release}; IPv4/IPv6 validated; sha256={digest}.')


if __name__ == '__main__':
    update()
