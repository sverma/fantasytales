// Successful authentication history is independent of client-supplied visit IDs.
export const LOGIN_RETENTION_DAYS=30;
export const ACTIVITY_PAGE_SIZE=10;
export function initActivity(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS auth_activity (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('login','signup','pin_migration')),
    created_at TEXT NOT NULL,
    UNIQUE(user_id,kind,created_at)
  );
  CREATE INDEX IF NOT EXISTS auth_activity_latest ON auth_activity(created_at DESC,id DESC);
  CREATE INDEX IF NOT EXISTS connections_latest ON connections(created_at DESC,id DESC);`);
}
export function recordAuthentication(db,userId,kind,at=new Date().toISOString()) {
  db.prepare('INSERT OR IGNORE INTO auth_activity(user_id,kind,created_at) VALUES(?,?,?)').run(userId,kind,at);
  return at;
}
export function pruneAuthentication(db,now=Date.now()) {
  db.prepare('DELETE FROM auth_activity WHERE created_at<?').run(new Date(now-LOGIN_RETENTION_DAYS*86400000).toISOString());
}
export function activityOptions(query) {
  const page=key=>{
    const value=query.get(key)||'1';
    if(!/^[1-9]\d{0,5}$/.test(value))throw new Error('Choose a valid activity page.');
    return Number(value);
  };
  const recipient=query.get('recipient')||'all',status=query.get('status')||'all';
  if(!['all','admin'].includes(recipient)||!['all','pending','accepted','declined','withdrawn'].includes(status))
    throw new Error('Choose a valid introduction filter.');
  return {loginPage:page('loginPage'),introductionPage:page('introductionPage'),recipient,status};
}
export function readAdminActivity(db,options,{hasContact,now=Date.now()}={}) {
  const cutoff=new Date(now-LOGIN_RETENTION_DAYS*86400000).toISOString(),day=new Date(now-86400000).toISOString();
  const paginate=(requested,total)=>{
    const pages=Math.max(1,Math.ceil(total/ACTIVITY_PAGE_SIZE)),page=Math.min(requested,pages);
    return {page,pages,total,pageSize:ACTIVITY_PAGE_SIZE};
  };
  const logins=paginate(options.loginPage,db.prepare('SELECT count(*) FROM auth_activity WHERE created_at>=?').get(cutoff)['count(*)']);
  logins.items=db.prepare(`SELECT a.id,a.kind,a.created_at,u.username,u.name,u.role,u.suspended,u.auth_kind,u.whatsapp,u.telegram,u.line
    FROM auth_activity a JOIN users u ON u.id=a.user_id WHERE a.created_at>=?
    ORDER BY a.created_at DESC,a.id DESC LIMIT ? OFFSET ?`).all(cutoff,ACTIVITY_PAGE_SIZE,(logins.page-1)*ACTIVITY_PAGE_SIZE)
    .map(({whatsapp,telegram,line,auth_kind,...row})=>({...row,setupComplete:Boolean(row.name&&auth_kind==='pin'&&hasContact({whatsapp,telegram,line}))}));
  const from=`FROM connections c JOIN users sender ON sender.id=c.user_id
    JOIN profiles p ON p.id=c.profile_id LEFT JOIN users owner ON owner.profile_id=p.id`;
  const where="WHERE (?='all' OR owner.role='admin') AND (?='all' OR c.status=?)";
  const params=[options.recipient,options.status,options.status];
  const introductions=paginate(options.introductionPage,db.prepare('SELECT count(*) AS n '+from+' '+where).get(...params).n);
  introductions.items=db.prepare(`SELECT c.id,c.status,c.created_at,c.updated_at,sender.username,sender.name,
    p.name AS recipientName,p.id AS profileId,owner.role='admin' AS toAdmin `+from+' '+where+
    ' ORDER BY c.created_at DESC,c.id DESC LIMIT ? OFFSET ?').all(...params,ACTIVITY_PAGE_SIZE,(introductions.page-1)*ACTIVITY_PAGE_SIZE);
  return {asOf:new Date(now).toISOString(),retentionDays:LOGIN_RETENTION_DAYS,logins,introductions,filters:{recipient:options.recipient,status:options.status},
    summary:{logins24h:db.prepare('SELECT count(*) AS n FROM auth_activity WHERE created_at>=?').get(day).n,
      introductions24h:db.prepare('SELECT count(*) AS n FROM connections WHERE created_at>=?').get(day).n,
      pendingToAdmin:db.prepare('SELECT count(*) AS n '+from+" WHERE owner.role='admin' AND c.status='pending'").get().n}};
}
