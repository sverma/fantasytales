#!/usr/bin/env python3
"""Consistent, private SQLite snapshots; seven days of local recovery history."""
import datetime
import os
import pathlib
import sqlite3
import shutil

os.umask(0o077)
source = pathlib.Path('/var/lib/fantasytales')
target = pathlib.Path('/var/backups/fantasytales')
target.mkdir(mode=0o700, parents=True, exist_ok=True)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H-%M-%SZ')
folder = target / stamp
folder.mkdir(mode=0o700)
with sqlite3.connect(source / 'fantasytales.sqlite') as original, sqlite3.connect(folder / 'fantasytales.sqlite') as snapshot:
    original.backup(snapshot)
csv = source / 'connections.csv'
if csv.exists():
    shutil.copy2(csv, folder / csv.name)
cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=7)
for item in target.iterdir():
    if item.is_dir() and datetime.datetime.fromtimestamp(item.stat().st_mtime, datetime.timezone.utc) < cutoff:
        shutil.rmtree(item)
print('Fantasy Tales backup completed.')
