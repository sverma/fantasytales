#!/usr/bin/env python3
"""Publish validated aggregate application metrics to local Ganglia every 15 seconds."""
import argparse
import http.client
import json
import math
from pathlib import Path
import signal
import socket
import subprocess
import time

ROOT=Path(__file__).resolve().parent
CATALOG_FILE=ROOT/'metrics-catalog.json'
if not CATALOG_FILE.exists(): CATALOG_FILE=ROOT.parents[1]/'metrics-catalog.json'
CATALOG={item['name']:item for item in json.loads(CATALOG_FILE.read_text())}
SOCKET='/run/fantasytales/metrics.sock'
stopping=False

class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(SOCKET)

def get_json(connection,path):
    try:
        connection.request('GET',path)
        response=connection.getresponse()
        body=response.read(131073)
        if response.status!=200 or len(body)>131072: raise ValueError('Invalid monitoring response')
        return json.loads(body)
    finally: connection.close()

def validate(snapshot,now):
    if not isinstance(snapshot,dict) or snapshot.get('schema')!=1: raise ValueError('Unknown metrics schema')
    timestamp=snapshot.get('generated_at')
    if isinstance(timestamp,bool) or not isinstance(timestamp,(int,float)) or not math.isfinite(timestamp): raise ValueError('Invalid timestamp')
    age=now-timestamp/1000
    if age < -5 or age>45: raise ValueError('Stale metrics snapshot')
    rows=snapshot.get('metrics')
    if not isinstance(rows,list) or not rows or len(rows)>len(CATALOG): raise ValueError('Invalid metric list')
    values={}
    reserved={'app_up','app_metrics_up','app_collector_up','app_snapshot_age_seconds'}
    for row in rows:
        if not isinstance(row,dict): raise ValueError('Invalid metric entry')
        name,value=row.get('name'),row.get('value')
        if not isinstance(name,str) or name not in CATALOG or name in reserved or name in values: raise ValueError('Unknown/duplicate metric')
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value<0: raise ValueError('Invalid metric value')
        values[name]=value
    required={'app_database_up','app_http_requests_per_min','app_process_uptime_seconds'}
    if not required.issubset(values): raise ValueError('Missing core metrics')
    values['app_snapshot_age_seconds']=max(0,age)
    return values

def collect():
    values={'app_collector_up':1,'app_up':0,'app_metrics_up':0}
    try: values['app_up']=int(get_json(http.client.HTTPConnection('127.0.0.1',3000,timeout=3),'/health').get('status')=='ok')
    except (OSError,ValueError,http.client.HTTPException): pass
    try:
        snapshot=get_json(UnixHTTP('localhost',timeout=5),'/metrics')
        values.update(validate(snapshot,time.time()));values['app_metrics_up']=1
    except (OSError,ValueError,http.client.HTTPException): pass
    return values

def publish(values):
    for name,value in values.items():
        item=CATALOG[name]
        subprocess.run(['/usr/bin/gmetric','--conf=/etc/fantasytales/gmetric.conf',
            '--spoof=127.0.0.1:fantasytales-server','--name='+name,'--value='+format(value,'.10g'),
            '--type=double','--units='+item['units'],'--slope=both','--tmax=45','--dmax=120',
            '--group='+item['group'],'--title='+item['title'],'--desc='+item['description']],
            check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=3)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--once',action='store_true');parser.add_argument('--dry-run',action='store_true')
    args=parser.parse_args()
    if args.dry_run:
        values=collect();print(json.dumps({'count':len(values),'application_up':values['app_up'],'metrics_up':values['app_metrics_up']}));return
    previous=None
    while not stopping:
        start=time.monotonic()
        try:
            values=collect();publish(values)
            state=(values['app_up'],values['app_metrics_up'])
            if state!=previous: print(json.dumps({'application_up':state[0],'metrics_up':state[1],'published':len(values)}),flush=True)
            previous=state
        except (OSError,ValueError,subprocess.SubprocessError) as error:
            print('Metric export failed: '+type(error).__name__,flush=True)
            if args.once: raise
        if args.once:return
        remaining=15-(time.monotonic()-start)
        while remaining>0 and not stopping:
            time.sleep(min(1,remaining));remaining=15-(time.monotonic()-start)

def stop(*_):
    global stopping
    stopping=True

if __name__=='__main__':
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    main()
