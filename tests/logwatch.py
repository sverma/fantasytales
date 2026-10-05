#!/usr/bin/env python3
"""Offline parser tests; Linux integration tests additionally use the installed MMDB."""
import csv
import importlib.util
from importlib.machinery import SourceFileLoader
import io
import ipaddress
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest

SOURCE = Path(os.environ.get('LOGWATCH_SOURCE', str(Path(__file__).resolve().parents[1] / 'deploy/logwatch/logwatch.py')))
spec = importlib.util.spec_from_loader('logwatch', SourceFileLoader('logwatch', str(SOURCE)))
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)


def line(ip='8.8.8.8', status=200, agent='curl/8.1', request='GET /health HTTP/1.1', timestamp='04/Oct/2026:16:30:00 +0000'):
    return f'{ip} - - [{timestamp}] "{request}" {status} 42 "-" "{agent}"\n'


class ParserTests(unittest.TestCase):
    def test_ist_dates_days_and_offsets(self):
        cases = [
            ('04/Oct/2026:16:30:00 +0000', ['2026-10-04', 'Sunday', '22:00:00']),
            ('04/Oct/2026:20:00:01 +0000', ['2026-10-05', 'Monday', '01:30:01']),
            ('31/Dec/2026:19:00:00 +0000', ['2027-01-01', 'Friday', '00:30:00']),
            ('29/Feb/2024:20:00:00 +0000', ['2024-03-01', 'Friday', '01:30:00']),
            ('04/Oct/2026:16:30:00 +0530', ['2026-10-04', 'Sunday', '16:30:00']),
            ('04/Oct/2026:16:30:00 -0700', ['2026-10-05', 'Monday', '05:00:00']),
            ('01/Jan/2027:00:15:00 +1200', ['2026-12-31', 'Thursday', '17:45:00']),
        ]
        for timestamp, expected in cases:
            with self.subTest(timestamp=timestamp):
                parsed = watch.parse_line(line(timestamp=timestamp))
                self.assertEqual(watch.visit_columns(parsed[3]), expected)
                self.assertEqual(parsed[3].tzname(), 'IST')

    def test_invalid_timestamp_is_skipped(self):
        for timestamp in ('29/Feb/2026:12:00:00 +0000', '04/Oct/2026:25:00:00 +0000',
                          '04/Oct/2026:12:00:00 +2500', '04/Oct/2026:12:00:00', 'not-a-date'):
            self.assertIsNone(watch.parse_line(line(timestamp=timestamp)))

    def test_http_status_range_and_ipv6(self):
        for status in (100, 200, 204, 301, 304, 399, 400, 401, 403, 404, 429, 499, 500, 503, 599):
            with self.subTest(status=status):
                result = watch.parse_line(line(ip='2001:4860:4860::8888', status=status))
                self.assertEqual(result[1], status)
                self.assertEqual(str(result[0]), '2001:4860:4860::8888')

    def test_ip_validation_and_status_validation(self):
        for address in ('not-an-ip', '1.2.3.999', 'example.com', 'fe80::1%eth0', '=cmd', '8.8.8.8:443'):
            self.assertIsNone(watch.parse_line(line(ip=address)))
        for status in (0, 99, 600, 999):
            self.assertIsNone(watch.parse_line(line(status=status)))
        self.assertIsNone(watch.parse_line('2026/10/04 [error] unrelated nginx error\n'))
        self.assertIsNone(watch.parse_line('8.8.8.8 - - [date] "incomplete'))

    def test_escaped_request_and_user_agent(self):
        result = watch.parse_line(line(request=r'GET /\x22attack\x22 HTTP/1.1',
                                       agent=r'Mozilla/5.0 (Android 16; Mobile) \x22quoted\x22'))
        self.assertEqual(result[2], 'Mozilla/5.0 (Android 16; Mobile) "quoted"')
        self.assertEqual(watch.device(result[2]), 'Mobile (Android)')

    def test_mapped_ipv4_and_missing_agent(self):
        self.assertEqual(str(watch.parse_line(line(ip='::ffff:8.8.8.8'))[0]), '8.8.8.8')
        self.assertEqual(watch.device(watch.parse_line(line(agent='-'))[2]), 'Unknown')

    def test_device_categories(self):
        cases = {
            'Mozilla/5.0 (Linux; Android 16) Chrome/154 Mobile Safari Instagram': 'Mobile (Android)',
            'Mozilla/5.0 (Linux; Android 13) Chrome/100 Safari': 'Tablet (Android)',
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)': 'Mobile (iOS)',
            'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)': 'Tablet (iPadOS)',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Mobile/15E148': 'Tablet (iPadOS)',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64)': 'Desktop (Windows)',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)': 'Desktop (macOS)',
            'Mozilla/5.0 (X11; Linux x86_64)': 'Desktop (Linux)',
            'Mozilla/5.0 (X11; CrOS x86_64 12345)': 'Desktop (ChromeOS)',
            'Mozilla/5.0 Googlebot/2.1': 'Bot/Scanner',
            'Mozilla/5.0 zgrab/0.x': 'Bot/Scanner',
            'Nmap Scripting Engine': 'Bot/Scanner',
            'curl/8.1': 'CLI/Script', 'python-requests/2.31': 'CLI/Script',
            '': 'Unknown', '-': 'Unknown', '=cmd\x1b[31m': 'Unknown',
        }
        for agent, expected in cases.items():
            with self.subTest(agent=agent):
                self.assertEqual(watch.device(agent), expected)

    def test_country_cache_reload_and_private_addresses(self):
        class Reader:
            def __init__(self):
                self.calls = 0
                self.closed = False

            def get(self, address):
                self.calls += 1
                if address == '1.1.1.1':
                    return None
                return {'country': {'iso_code': 'US', 'names': {'en': 'United States'}}}

            def close(self):
                self.closed = True

        readers = []

        def opener(_):
            reader = Reader()
            readers.append(reader)
            return reader

        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'fake.mmdb'
            path.write_bytes(b'one')
            countries = watch.Countries(path, opener=opener)
            for address in ('127.0.0.1', '10.0.0.1', '192.168.1.1', '::1', 'fe80::1', '2001:db8::1', '224.0.0.1'):
                self.assertEqual(countries.lookup(ipaddress.ip_address(address)), 'LOCAL/RESERVED')
            self.assertEqual(readers[0].calls, 0)
            for _ in range(2):
                self.assertEqual(countries.lookup(ipaddress.ip_address('8.8.8.8')), 'United States (US)')
            self.assertEqual(readers[0].calls, 1)
            self.assertEqual(countries.lookup(ipaddress.ip_address('1.1.1.1')), 'UNKNOWN')
            replacement = Path(temp) / 'new.mmdb'
            replacement.write_bytes(b'two')
            replacement.replace(path)
            countries.next_check = 0
            countries.lookup(ipaddress.ip_address('8.8.8.8'))
            self.assertEqual(len(readers), 2)
            self.assertTrue(readers[0].closed)
            self.assertEqual(readers[1].calls, 1)
            countries.close()
            self.assertTrue(readers[1].closed)


@unittest.skipUnless(sys.platform.startswith('linux') and Path(watch.DATABASE).exists(),
                     'requires GNU tail and installed GeoIP database on server')
class FollowTests(unittest.TestCase):
    def test_stdin_status_mapping_csv_and_safe_output(self):
        records = ''.join(line(status=status) for status in (100, 200, 301, 399, 400, 429, 499, 500, 599))
        records += line(agent=r'=cmd\x1b[31m') + 'malformed input\n'
        result = subprocess.run([sys.executable, str(SOURCE), '--stdin'], input=records,
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = list(csv.reader(io.StringIO(result.stdout)))
        self.assertEqual(rows[0], watch.HEADER)
        self.assertEqual([row[4] for row in rows[1:10]], ['SUCCESS'] * 4 + ['ERROR'] * 5)
        self.assertTrue(all(row[3] == 'United States (US)' for row in rows[1:]))
        self.assertTrue(all(row[:3] == ['2026-10-04', 'Sunday', '22:00:00'] for row in rows[1:]))
        self.assertEqual(rows[-1][5], 'Unknown')
        self.assertNotIn('\x1b', result.stdout)
        self.assertIn('Skipped 1', result.stderr)

    def test_two_logs_rotation_truncation_and_child_cleanup(self):
        with tempfile.TemporaryDirectory(prefix='fantasytales-logwatch-test-') as temp:
            first, second = Path(temp) / 'access.log', Path(temp) / 'other.log'
            first.write_text(line(status=200))
            second.write_text(line(status=301))
            process = subprocess.Popen([sys.executable, str(SOURCE), '--lines', '1', str(first), str(second)],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            entries = queue.Queue()
            thread = threading.Thread(target=lambda: [entries.put(item) for item in process.stdout], daemon=True)
            thread.start()

            def read():
                return next(csv.reader([entries.get(timeout=8)]))

            def append(path, value):
                with path.open('a') as output:
                    output.write(value)

            child_pid = None
            try:
                self.assertEqual(read(), watch.HEADER)
                self.assertEqual([read()[4], read()[4]], ['SUCCESS', 'SUCCESS'])
                child_pid = int(subprocess.check_output(['pgrep', '-P', str(process.pid)], text=True).strip())
                append(first, line(status=404))
                self.assertEqual(read()[4], 'ERROR')
                first.rename(Path(temp) / 'access.log.1')
                first.write_text(line(status=429))
                self.assertEqual(read()[4], 'ERROR')
                append(second, line(ip='2001:4860:4860::8888', status=201))
                self.assertEqual(read()[6], '2001:4860:4860::8888')
                # Copytruncate is detected when the follower observes the shorter file.
                second.write_text('')
                time.sleep(1.5)
                append(second, line(ip='127.0.0.1', status=503))
                row = read()
                self.assertEqual(row, ['2026-10-04', 'Sunday', '22:00:00',
                                       'LOCAL/RESERVED', 'ERROR', 'CLI/Script', '127.0.0.1'])
                with self.assertRaises(queue.Empty):
                    entries.get(timeout=0.7)
            finally:
                process.terminate()
                process.wait(timeout=5)
                process.stdout.close()
                process.stderr.close()
            self.assertEqual(process.returncode, 0)
            if child_pid:
                self.assertFalse(Path(f'/proc/{child_pid}').exists(), 'orphaned tail process')


if __name__ == '__main__':
    unittest.main(verbosity=2)
