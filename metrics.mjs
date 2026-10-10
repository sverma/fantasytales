import http from 'node:http';
import {chmodSync} from 'node:fs';
import {createHistogram, monitorEventLoopDelay, performance} from 'node:perf_hooks';
import catalog from './metrics-catalog.json' with {type:'json'};

export const metricPages=['welcome','pin-setup','name','contact','discover','profile','introduce','sent','connections','account','admin','privacy','guidelines'];
export const metricRoutes=['auth','profiles','connections','account','admin','events','media','assets','other'];
const events={ACCOUNT_CREATED:'registrations',SIGNED_IN:'logins',INTRODUCTION_SENT:'introductions',MESSAGE_SENT:'messages',PROFILE_OPENED:'profile_views'};
const histogram=()=>createHistogram({lowest:1,highest:3_600_000_000,figures:2});
export function routeGroup(raw) {
  let path;
  try {path=new URL(raw,'http://local').pathname;}catch{return 'other';}
  if(path==='/health'||path==='/api/media-authorize')return null;
  if(path.startsWith('/api/auth/'))return 'auth';
  if(path.startsWith('/api/admin'))return 'admin';
  if(path.startsWith('/api/connections'))return 'connections';
  if(path==='/api/me' || path.startsWith('/api/me/') || path.startsWith('/api/owner/'))return 'account';
  if(path==='/api/events')return 'events';
  if(path.startsWith('/api/profiles') || path.startsWith('/api/favorites') || path==='/api/reports')return 'profiles';
  if(path.startsWith('/media/'))return 'media';
  if(path==='/' || path==='/index.html' || path==='/app.js' || path==='/styles.css' || path.startsWith('/assets/'))return 'assets';
  return 'other';
}

// One histogram/counter bucket per second; no URLs, names, IDs or raw samples retained.
export class RequestWindow {
  constructor(now=()=>performance.now()) {this.now=now;this.buckets=new Map();this.inflight=0;}
  prune() {const second=Math.floor(this.now()/1000);for(const key of this.buckets.keys())if(key<=second-60)this.buckets.delete(key);return second;}
  bucket() {
    const second=this.prune();
    if(!this.buckets.has(second))this.buckets.set(second,{count:0,sum:0,hist:histogram(),values:{}});
    return this.buckets.get(second);
  }
  increment(key) {const bucket=this.bucket();bucket.values[key]=(bucket.values[key] || 0)+1;}
  record(group,status,elapsed,aborted=false) {
    if(!metricRoutes.includes(group))group='other';
    const bucket=this.bucket();
    const time=Math.max(0,Number.isFinite(elapsed)?elapsed:0);
    if(aborted){bucket.values.aborted=(bucket.values.aborted || 0)+1;return;}
    bucket.count++;bucket.sum+=time;
    bucket.hist.record(Math.max(1,Math.min(3_600_000_000,Math.round(time*1000))));
    for(const key of ['route_'+group, 'status_'+Math.floor(status/100)+'xx'])bucket.values[key]=(bucket.values[key] || 0)+1;
  }
  snapshot() {
    this.prune();const combined=histogram();let count=0,sum=0;const values={};
    for(const bucket of this.buckets.values()) {
      count+=bucket.count;sum+=bucket.sum;combined.add(bucket.hist);
      for(const [key,value]of Object.entries(bucket.values))values[key]=(values[key] || 0)+value;
    }
    const result={app_http_requests_per_min:count,app_http_response_avg_ms:count?sum/count:0,
      app_http_response_p95_ms:count?combined.percentile(95)/1000:0,app_http_inflight:this.inflight,
      app_http_aborted_per_min:values.aborted || 0,app_login_failures_per_min:values.login_failures || 0};
    for(const code of ['2xx','3xx','4xx','5xx'])result['app_http_'+code+'_per_min']=values['status_'+code] || 0;
    result.app_http_5xx_percent=count?100*result.app_http_5xx_per_min/count:0;
    for(const route of metricRoutes)result['app_route_'+route+'_per_min']=values['route_'+route] || 0;
    for(const page of metricPages)result['app_page_'+page.replaceAll('-','_')+'_per_min']=values['page_'+page] || 0;
    for(const event of [...Object.values(events),'accepted','declined','withdrawn'])result['app_event_'+event+'_per_min']=values['event_'+event] || 0;
    return result;
  }
}

export function aggregateCounts(db,now=Date.now()) {
  const cutoff=new Date(now-86_400_000).toISOString();
  const users=db.prepare("SELECT count(*) AS total,coalesce(sum(suspended),0) AS suspended,coalesce(sum(created_at>=?),0) AS recent FROM users WHERE role='member'").get(cutoff);
  const connections=db.prepare("SELECT count(*) AS total,coalesce(sum(status='pending'),0) AS pending,coalesce(sum(status='accepted'),0) AS accepted,coalesce(sum(created_at>=?),0) AS recent,coalesce(sum(status='accepted' AND updated_at>=?),0) AS accepted_recent FROM connections").get(cutoff,cutoff);
  return {app_members_total:users.total,app_members_suspended:users.suspended,app_registrations_24h:users.recent,
    app_profiles_published:db.prepare('SELECT count(*) AS n FROM profiles WHERE published=1').get().n,
    app_introductions_total:connections.total,app_introductions_pending:connections.pending,app_connections_accepted:connections.accepted,
    app_introductions_24h:connections.recent,app_connections_accepted_24h:connections.accepted_recent,
    app_messages_24h:db.prepare('SELECT count(*) AS n FROM messages WHERE created_at>=?').get(cutoff).n,
    app_visits_24h:db.prepare('SELECT count(*) AS n FROM visits WHERE created_at>=?').get(now-86_400_000).n,
    app_authenticated_sessions:db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id IS NOT NULL AND expires_at>?').get(now).n};
}

export function createAppMetrics({db,socketPath=process.env.METRICS_SOCKET}={}) {
  if(!socketPath)return {observe(){},event(){},async start(){},async close(){}};
  const window=new RequestWindow();
  const delay=monitorEventLoopDelay({resolution:20});delay.enable();
  let previousCPU=process.cpuUsage(),previousTime=performance.now(),previousUtilization=performance.eventLoopUtilization();
  let runtime={app_process_cpu_percent:0,app_event_loop_utilization_percent:0,app_event_loop_delay_p95_ms:0};
  let aggregates={},lastQuery=-Infinity,dbOK=1;
  const sample=()=>{
    const now=performance.now(),cpu=process.cpuUsage(),utilization=performance.eventLoopUtilization();
    const elapsed=Math.max(1,now-previousTime);
    runtime={app_process_cpu_percent:((cpu.user-previousCPU.user)+(cpu.system-previousCPU.system))/1000/elapsed*100,
      app_event_loop_utilization_percent:performance.eventLoopUtilization(utilization,previousUtilization).utilization*100,
      app_event_loop_delay_p95_ms:delay.count?delay.percentile(95)/1e6:0};
    previousCPU=cpu;previousTime=now;previousUtilization=utilization;delay.reset();window.prune();
  };
  const timer=setInterval(sample,15000);timer.unref();
  function snapshot() {
    const now=performance.now();
    if(now-lastQuery>=15000) {
      try {aggregates=aggregateCounts(db);dbOK=1;}catch{aggregates={};dbOK=0;}
      lastQuery=now;
    }
    const memory=process.memoryUsage();
    const values={...window.snapshot(),...runtime,...aggregates,app_database_up:dbOK,
      app_process_rss_bytes:memory.rss,app_process_heap_used_bytes:memory.heapUsed,
      app_process_heap_total_bytes:memory.heapTotal,app_process_external_bytes:memory.external,
      app_process_uptime_seconds:process.uptime()};
    return {schema:1,generated_at:Date.now(),metrics:catalog.filter(item=>item.name in values).map(item=>({name:item.name,value:values[item.name]}))};
  }
  const endpoint=http.createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(req.method!=='GET' || req.url!=='/metrics'){res.writeHead(404);res.end();return;}
    try {res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(snapshot()));}
    catch {res.writeHead(503);res.end();}
  });
  endpoint.requestTimeout=5000;endpoint.headersTimeout=5000;endpoint.keepAliveTimeout=1000;
  return {
    observe(req,res) {
      const group=routeGroup(req.url);if(group===null)return;
      const start=performance.now();window.inflight++;let recorded=false;
      const done=aborted=>{
        if(recorded)return;recorded=true;window.inflight=Math.max(0,window.inflight-1);
        window.record(group,res.statusCode,performance.now()-start,aborted);
        if(!aborted && group==='auth' && /^\/api\/auth\/(?:login|migrate-pin)(?:\?|$)/.test(req.url) && res.statusCode>=400)window.increment('login_failures');
      };
      res.once('finish',()=>done(false));res.once('close',()=>done(!res.writableFinished));
    },
    event(event,dimension) {
      if(events[event])window.increment('event_'+events[event]);
      else if(event==='PAGE_OPENED' && metricPages.includes(dimension))window.increment('page_'+dimension);
      else if(event==='INTRODUCTION_UPDATED' && ['accepted','declined','withdrawn'].includes(dimension))window.increment('event_'+dimension);
    },
    async start() {
      await new Promise((resolve,reject)=>{endpoint.once('error',reject);endpoint.listen(socketPath,()=>{endpoint.removeListener('error',reject);resolve();});});
      chmodSync(socketPath,0o600);
      endpoint.on('error',error=>console.error('Private metrics listener error:',error.code));
    },
    async close() {clearInterval(timer);delay.disable();if(endpoint.listening){endpoint.closeAllConnections();await new Promise(resolve=>endpoint.close(resolve));}},
  };
}
