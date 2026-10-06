const $ = (selector, root=document) => root.querySelector(selector);
const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function profileBiography(value) {
  return String(value ?? '').split(/(https:\/\/[^\s<>"']+)/g).map((part,index)=>{
    if(index%2)try{
      const url=new URL(part);
      if(url.protocol==='https:')return `<a class="profile-external-link" href="${esc(url.href)}" target="_blank" rel="noopener noreferrer nofollow">${esc(part)}</a>`;
    }catch{}
    return esc(part);
  }).join('');
}
const paths = {
  spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  arrow:'<path d="M4 12h15m-6-6 6 6-6 6"/>',
  external:'<path d="M15 3h6v6m0-6L10 14M11 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6"/>',
  back:'<path d="M20 12H5m6-6-6 6 6 6"/>',
  heart:'<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-5"/>',
  chat:'<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z"/><path d="M7 11h10m-10 4h6"/>',
  eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff:'<path d="m3 3 18 18M10 5a12 12 0 0 1 12 7s-1 2-3 3M6 6a17 17 0 0 0-4 6s4 7 10 7a12 12 0 0 0 5-1M9 9a4 4 0 0 0 6 6"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  send:'<path d="m22 2-7 20-4-9-9-4 20-7ZM11 13 22 2"/>',
  refresh:'<path d="M20 7a9 9 0 1 0 1 9M20 2v6h-6"/>',
  flag:'<path d="M4 22V3s4-3 8 0 8 0 8 0v11s-4 3-8 0-8 0-8 0"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  moon:'<path d="M21 13a9 9 0 0 1-10-10 9 9 0 1 0 10 10Z"/>',
  logout:'<path d="M9 4H4v16h5m4-4 4-4-4-4m-5 4h13"/>',
};
const icon = (name,extra='') => `<svg class="icon ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.spark}</svg>`;
const state = {adminTab:'members',adminSearch:'',adminStatus:'all',adminMemberPage:1,adminMembers:null,user:null,csrf:'',profiles:[],connections:[],featuredRequest:null,authMode:'signup',filter:'all',search:'',lastSent:null,page:'',visit:sessionStorage.getItem('ft_visit') || ''};
let renderSequence=0, discoveryRefresh=0, toastTimeout, connectionTimer;

async function api(path,method='GET',data) {
  const res=await fetch(path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf,'X-Visit-ID':state.visit},...(data!==undefined ? {body:JSON.stringify(data)} : {})});
  let result;try{result=await res.json();}catch{throw new Error('The server is temporarily unavailable. Please try again.');}
  if(!res.ok){const error=new Error(result.error || 'Please try again.');error.status=res.status;error.code=result.code;throw error;}
  return result;
}
function clearAdminState(){state.adminMembers=null;state.adminSearch='';state.adminStatus='all';state.adminMemberPage=1;state.adminTab='members';}
async function initSession() {
  const s=await api('/api/session');state.user=s.user;state.csrf=s.csrf;if(s.user?.role!=='admin')clearAdminState();
  if(s.visitId){state.visit=s.visitId;sessionStorage.setItem('ft_visit',s.visitId);}
}
function event(name,details={}) { api('/api/events','POST',{event:name,...details}).catch(()=>{}); }
function toast(message) {const t=$('#toast');t.textContent=message;t.classList.add('show');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>t.classList.remove('show'),4000);}
function goto(page) {closeModal();if(location.hash===`#${page}`) render();else location.hash=page;}
function nextPage(){if(!state.user)return 'welcome';if(state.user.needs_pin)return 'pin-setup';if(!state.user.name)return 'name';if(!state.user.contact_done)return 'contact';return 'discover';}
function shell() {
  $('#header').innerHTML=`<a class="brand" href="#${nextPage()}" aria-label="Fantasy Tales home"><svg class="brand-symbol" viewBox="0 0 30 40" fill="none" aria-hidden="true"><path d="M13 6c1.8 10 5.5 14.5 13 16-7.5 1.5-11.2 6-13 16C11.2 28 7.5 23.5 0 22 7.5 20.5 11.2 16 13 6Z" fill="currentColor"/><path d="M24 0c.8 4 2 6 6 7-4 1-5.2 3-6 7-.8-4-2-6-6-7 4-1 5.2-3 6-7Z" fill="#b25b77"/></svg><span class="wordmark">fantasy<span class="gold">tales</span><span class="dot">.</span></span></a>${state.user && !state.user.needs_pin && state.user.name && (state.user.contact_done || ['owner','admin'].includes(state.user.role)) ? `<nav class="header-nav" aria-label="Main navigation"><a href="#discover" class="${['discover','introduce','sent'].includes(state.page)?'active':''}" aria-label="Discover">${icon('spark')}<span>Discover</span></a><a href="#connections" class="${state.page==='connections'?'active':''}" aria-label="Connections">${icon('chat')}<span>Connections</span></a><a href="#account" class="${state.page==='account'?'active':''}" aria-label="Account">${icon('user')}<span>Account</span></a>${state.user.role==='admin'?`<a href="#admin" class="${state.page==='admin'?'active':''}" aria-label="Admin">${icon('shield')}<span>Admin</span></a>`:''}</nav><div class="member-badge"><span>Good to see you, ${esc(state.user.name.split(' ')[0])}</span><span class="avatar">${esc(state.user.name[0])}</span></div>`:`<span class="header-note">${icon('moon')} Free · Open source · AI-powered <span class="gold">· 18+</span></span>`}`;
  $('#footer').innerHTML=`<span>© ${new Date().getFullYear()} Fantasy Tales. Free, open-source dating.</span><div class="footer-links"><a href="/">Home</a><a href="/open-source">Open source</a><a href="#privacy">Privacy</a><a href="#guidelines">Community guidelines</a><span>Made for meaningful connections ${icon('spark')}</span></div>`;
}
function secretField(id,name,label,{pin=true,fresh=false}={}) {
  return `<div class="field"><label for="${id}">${label}</label><div class="password-wrap"><input id="${id}" name="${name}" type="password" ${pin?'class="pin-input" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6"':'maxlength="128"'} autocomplete="${fresh?'new-password':'current-password'}" placeholder="${pin?'6 digits':'Your existing password'}" required ${pin?'aria-describedby="'+id+'-help"':''}><button class="password-toggle" type="button" data-action="toggle-secret" data-target="${id}" data-label="${pin?'PIN':'password'}" aria-label="Show ${pin?'PIN':'password'}">${icon('eye')}</button></div>${pin?`<p id="${id}-help" class="field-help">Exactly 6 digits, from 0 to 9.</p>`:''}</div>`;
}
function authPage() {
  const signup=state.authMode==='signup',migrate=state.authMode==='migrate-pin';
  return `<section class="welcome fade-in"><div class="welcome-story"><img class="welcome-art" src="/assets/nocturne.svg" alt="" aria-hidden="true"><span class="eyebrow">Some stories are worth starting</span><h1>A little mystery.<br>A real<br><em>connection.</em></h1><p class="lead">Free, open-source dating with smart AI-powered profile ratings. Start with an unexpected hello and an unhurried conversation.</p><div class="story-bottom"><div>${icon('shield')}Private by design</div><div>${icon('heart')}Always mutual</div><div>${icon('spark')}Entirely you</div></div></div><div class="welcome-form-wrap"><div class="auth-card"><span class="eyebrow">Your next chapter</span><h2>${migrate?'A simpler way back.':signup?'Let a little magic in.':'Your story continues.'}</h2><p class="auth-subtitle">${migrate?'Use your existing password once to choose a six-digit PIN. Your account stays the same.':signup?'Good connections begin with being yourself.':'Your username. Six digits. Back to your story.'}</p><div class="auth-switch" role="group" aria-label="Account options"><button data-action="auth-mode" data-mode="signup" class="${signup?'active':''}" aria-pressed="${signup}">Create an account</button><button data-action="auth-mode" data-mode="login" class="${!signup?'active':''}" aria-pressed="${!signup}">Sign in</button></div><form data-form="auth"><div class="form-error" role="alert"></div><div class="field"><label for="username">Your username</label><input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="${signup?'Choose your little alias':'Your username'}" required minlength="3" maxlength="32" pattern="[a-zA-Z0-9]([a-zA-Z0-9_.]|-){2,31}" aria-describedby="username-help"><p id="username-help" class="field-help">3–32 letters, numbers, dots, dashes, or underscores.</p></div>${migrate?secretField('existing-password','currentPassword','Existing password',{pin:false}):''}${secretField('pin','pin',signup?'Create a 6-digit PIN':migrate?'New 6-digit PIN':'Your 6-digit PIN',{fresh:signup||migrate})}${signup||migrate?secretField('confirm-pin','confirmPin','Confirm your PIN',{fresh:true}):''}${signup?`<label class="check-row"><input type="checkbox" name="adultConsent" required><span>I am 18 or older and agree to the <a href="#guidelines">community guidelines</a>.</span></label><label class="check-row"><input type="checkbox" name="privacyConsent" required><span>I agree to the <a href="#privacy">privacy notice</a>. My account details, IP address, and site activity are recorded to run and protect the community.</span></label>`:''}<button class="btn btn-primary btn-wide" type="submit">${migrate?'Set PIN and sign in':signup?'Begin your story':'Step back inside'} ${icon('arrow')}</button>${!signup?`<p class="forgot-note">Forgot your PIN${migrate?' or existing password':''}? Ask the community organizer to reset your account.</p>`:''}</form>${!signup&&!migrate?'<button class="quiet-link" data-action="auth-mode" data-mode="migrate-pin">Still using a password? Switch to a PIN</button>':''}<p class="auth-note">${icon('lock')} A private space. A connection at your pace.</p></div></div></section>`;
}
function pinForm(legacy=false) {
  return `<form data-form="pin"><div class="form-error" role="alert"></div>${secretField('current-secret',legacy?'currentPassword':'currentPin',legacy?'Existing password':'Current PIN',{pin:!legacy})}${secretField('new-pin','pin','New 6-digit PIN',{fresh:true})}${secretField('confirm-new-pin','confirmPin','Confirm your PIN',{fresh:true})}<button class="btn btn-secondary" type="submit">${legacy?'Set my PIN':'Update PIN'} ${icon('lock')}</button></form>`;
}
function pinSetupPage() {
  return `<section class="page-container document fade-in"><span class="eyebrow">A simpler way back</span><h1>Six digits.<br><em>Your private key.</em></h1><div class="settings-card"><h2>Choose your PIN.</h2><p>We now use a six-digit PIN to sign in. Confirm your existing password once to keep your account and set your PIN.</p>${pinForm(true)}<button class="quiet-link" data-action="logout">Sign out</button></div></section>`;
}
const contactMethods=[['whatsapp','WhatsApp','WhatsApp number','+91 98765 43210'],['telegram','Telegram','Telegram username','@your_username'],['line','LINE','LINE ID / username','your_line_id']];
function contactFields(prefix='',choose=false) {
  const selected=contactMethods.find(([key])=>state.user[key])?.[0] || 'whatsapp';
  const choices=choose?`<div class="contact-methods" role="group" aria-label="Choose a messenger">${contactMethods.map(([key,label])=>`<button type="button" class="contact-method ${key===selected?'active':''}" data-action="contact-method" data-method="${key}" aria-pressed="${key===selected}" aria-controls="contact-field-${key}">${label}</button>`).join('')}</div>`:'';
  return `${choices}${contactMethods.map(([key,label,title,placeholder])=>`<div class="field" ${choose?`id="contact-field-${key}" data-contact-field="${key}" ${key!==selected?'hidden':''}`:''}><label for="${prefix+key}">${title}</label><input id="${prefix+key}" name="${key}" ${key==='whatsapp'?'type="tel" autocomplete="tel" inputmode="tel" maxlength="25"':'type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="100"'} ${choose?(key===selected?'required':'disabled'):''} placeholder="${placeholder}" value="${esc(state.user[key] || '')}"><p class="field-help">${key==='whatsapp'?'Include your country code.':key==='telegram'?'Enter your username, with or without @.':'Enter the ID or username people use to find you on LINE.'}</p></div>`).join('')}`;
}
function onboarding(page) {
  const name=page==='name';
  return `<section class="onboard-layout fade-in"><aside class="onboard-aside"><span class="eyebrow">A little about you</span><h1>${name?'Every story<br>needs a <em>name.</em>':'Stay close.<br>On <em>your terms.</em>'}</h1><p>${name?'The most interesting thing you can be is yourself. Let’s start with what you’d like to be called.':'Choose the messenger you use. One contact detail is enough to meet the community.'}</p><div class="step-ornament" aria-hidden="true">${name?'01':'02'}<span class="gold">.</span></div></aside><div class="form-panel"><div class="step-meta"><span>YOUR INTRODUCTION</span><span>${name?'1':'2'} OF 2</span></div><div class="step-progress"><span class="${name?'half':'full'}"></span></div><h2>${name?'What should we call you?':'A way to stay in touch.'}</h2><p class="intro-copy">${name?'A first name or a nickname is perfect.':'WhatsApp, Telegram, or LINE. Just one is enough. No verification codes.'}</p><form data-form="${page}"><div class="form-error" role="alert"></div>${name?`<div class="field"><label for="name">Your name</label><input id="name" name="name" autocomplete="given-name" minlength="2" maxlength="60" required placeholder="Your name, your way" value="${esc(state.user.name)}"></div>`:contactFields('',true)}${!name?`<p class="field-help contact-privacy">We don’t verify these details or send automated messages. Admin can see them in private records and CSV exports. Sharing with another member is optional and happens only after they accept your hello. You can add more messengers in Account.</p>`:''}<button class="btn btn-primary btn-wide" type="submit">${name?'A little more about you':'Meet the community'} ${icon('arrow')}</button></form>${name?`<button class="quiet-link" data-action="logout">${icon('back')}Use a different account</button>`:`<a class="quiet-link" href="#name">${icon('back')}Back to your name</a>`}</div></section>`;
}
function ratingBadge(p) {
  if(p.rating_enabled===0)return '';
  if(!p.rating)return `<div class="profile-rating-panel profile-rating-placeholder" aria-label="AI rating for ${esc(p.name)}: not rated"><span class="rating-label">AI rating</span><span class="rating-value"><strong>Not rated</strong></span><span class="rating-caption">No score available</span></div>`;
  return `<button type="button" class="profile-rating-panel profile-rating" data-action="rating-info" data-id="${p.id}" aria-label="AI rating for ${esc(p.name)}: ${p.rating.score.toFixed(1)} out of 5"><span class="rating-label">AI rating ${icon('arrow')}</span><span class="rating-value"><span class="rating-star" aria-hidden="true">★</span><strong>${p.rating.score.toFixed(1)}</strong><span class="rating-scale">/ 5</span></span><span class="rating-caption">${p.rating.pending?'Update pending':'View breakdown'}</span></button>`;
}
function ratingInfo(id) {
  const p=state.profiles.find(p=>p.id===id);if(p?.rating_enabled===0 || !p?.rating)return;
  const r=p.rating;
  openModal(`<button class="icon-btn modal-close" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button><div class="modal-form"><span class="eyebrow">A subjective AI estimate</span><h2 id="modal-title">${esc(p.name)}’s profile rating</h2><div class="rating-total">${r.score.toFixed(1)}<span> / 5</span></div><dl class="rating-breakdown"><div><dt>Profile quality</dt><dd>${r.quality.toFixed(1)} / 5</dd></div><div><dt>Visual attractiveness</dt><dd>${r.attractiveness.toFixed(1)} / 5</dd></div></dl><p>Each contributes equally. Profile quality considers the details and photo quality; attractiveness is a subjective impression from the photos. Your own preferences matter.</p><p class="small muted">Last assessed ${dateText(r.assessed_at)}. ${r.pending?'This is the previous score while an update is pending.':'Changed profiles are checked daily.'} This rating does not verify identity or predict compatibility.</p><button class="btn btn-secondary btn-wide" data-action="close-modal">Done</button></div>`);
}
function profileCard(p) {
  const own=p.id===state.user.profile_id;
  return `<article class="profile-card"><button class="profile-image-button" data-action="profile" data-id="${p.id}" aria-label="View ${esc(p.name)}’s profile"><div class="portrait-wrap protected-photo"><img src="${p.image}" alt="${esc(p.name)}" draggable="false" loading="lazy" width="400" height="540"><span class="image-watermark">FANTASYTALES · PRIVATE</span><div class="portrait-caption"><h2>${esc(p.name)}</h2>${icon('spark')}</div></div></button>${own?'':`<button class="icon-btn save-button ${p.saved?'saved':''}" data-action="save" data-id="${p.id}" aria-label="${p.saved?'Unsave':'Save'} ${esc(p.name)}" aria-pressed="${!!p.saved}">${icon('heart')}</button>`}<div class="profile-card-body">${own?'<span class="pill">Your profile</span>':''}${ratingBadge(p)}<p>${esc(p.prompt)}</p><button class="btn btn-secondary btn-wide" data-action="profile" data-id="${p.id}">Explore profile ${icon('arrow')}</button></div></article>`;
}
function cards() {
  const profiles=state.profiles.filter(p=>(state.filter!=='saved'||p.saved)&&p.name.toLowerCase().includes(state.search.toLowerCase()));
  return profiles.length ? profiles.map(profileCard).join('') : `<div class="empty-state">${icon('heart')}<h2>${state.search?'No names found.':'Keep a little possibility.'}</h2><p>${state.search?'Try another name, or clear your search.':'Tap the heart on a profile to save it here. Take your time getting to know someone.'}</p><button class="btn btn-secondary" data-action="reset-filter">Explore all profiles ${icon('arrow')}</button></div>`;
}
const featuredHello = "Hello Admin, I'd like to have a featured profile on Fantasy Tales. Could you please send me the email address where I can submit my description, photos, and other profile details?";
function featuredInvite() {
  const request=state.featuredRequest;
  if(!request?.eligible)return '';
  return `<aside class="featured-invite" aria-labelledby="featured-invite-title"><div><span class="eyebrow">Let the community discover you</span><h2 id="featured-invite-title">Want to be featured?</h2><p>Your profile isn't shown in Discover. Send Admin a hello and ask for the email address where you can send your description, photos, and other profile details.</p><p class="small muted">Admin reviews submissions before featuring a profile.</p></div><button class="btn btn-secondary" data-action="feature-request">Request a featured profile ${icon('arrow')}</button></aside>`;
}
function featuredRequestModal(request) {
  if(!request.admin) {
    openModal(`<button class="icon-btn modal-close" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button><div class="modal-form"><h2 id="modal-title">Admin is unavailable.</h2><p>Admin isn't accepting new hellos right now. Please check back later to request the email address for your profile details and photos.</p><button class="btn btn-secondary btn-wide" data-action="close-modal">Got it</button></div>`);return;
  }
  const connection=request.connection;
  const link=connection?`#connections/${connection.id}`:'#connections';
  if(connection?.status==='pending') {
    openModal(`<button class="icon-btn modal-close" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button><div class="modal-form"><span class="eyebrow">A hello is on its way</span><h2 id="modal-title">Waiting for Admin.</h2><p>You already have a pending hello with Admin. Once they accept, ask for the email address where you can send your description, photos, and other profile details.</p><p class="small muted">Your profile stays hidden until Admin approves it.</p><a class="btn btn-primary btn-wide" href="${link}">View your hello ${icon('arrow')}</a></div>`);return;
  }
  openModal(`<button class="icon-btn modal-close" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button><div class="modal-form"><span class="eyebrow">Your next chapter</span><h2 id="modal-title">Become a featured profile.</h2><p>${connection?'Ask Admin in your existing conversation for the email address to send your profile materials.':'Send Admin a hello asking for the email address to send your profile materials. When Admin accepts, they can reply in Connections.'}</p><form data-form="featured-request" data-profile="${esc(request.admin.id)}" ${connection?`data-connection="${connection.id}"`:''}><div class="form-error" role="alert"></div><div class="field"><label for="featured-message">Your message to Admin</label><textarea id="featured-message" name="message" required minlength="10" maxlength="1000">${esc(featuredHello)}</textarea></div><p class="field-help">Review or edit your message before sending. Admin will review your description, photos, and details before deciding whether to feature your profile.</p><button type="submit" class="btn btn-primary btn-wide">${connection?'Send message to Admin':'Send hello to Admin'} ${icon('send')}</button></form><a class="quiet-link" href="${link}">View Connections</a></div>`);
}
function discoverPage() {
  return `<section class="page-container fade-in"><div class="discovery-top"><div><span class="eyebrow">A hello could change everything</span><h1>Find your <em>kind of magic.</em></h1><p>Take a look. Feel a spark. Start something with a thoughtful hello.</p></div><div class="community-note">${icon('shield')}<p>Real conversations begin with mutual interest. Always at your pace.</p></div></div>${featuredInvite()}<div class="discovery-toolbar"><div class="filters" role="group" aria-label="Filter profiles"><button class="filter ${state.filter==='all'?'active':''}" data-action="filter" data-filter="all" aria-pressed="${state.filter==='all'}">Discover all</button><button class="filter ${state.filter==='saved'?'active':''}" data-action="filter" data-filter="saved" aria-pressed="${state.filter==='saved'}">${icon('heart')} Saved</button></div><div class="search-field">${icon('search')}<input type="search" id="profile-search" placeholder="Find a name" aria-label="Search profiles by name" value="${esc(state.search)}"></div></div><p class="ratings-discovery-note"><span aria-hidden="true">★</span>AI ratings are subjective scores out of 5. Tap a score to see its breakdown.</p><div id="profile-grid" class="profile-grid">${cards()}</div><div class="discovery-bottom"><span>${icon('lock')}Profiles are visible to members only.</span><span>${icon('heart')}A connection is never a commitment.</span></div><div class="editorial-note"><p>“The best stories start with a little curiosity.”</p><span>Less scrolling. More feeling.</span></div></section>`;
}
function profileModal(id) {
  const p=state.profiles.find(p=>p.id===id);if(!p)return;
  const own=p.id===state.user.profile_id;
  const photos=p.photos?.length?p.photos:[p.image];
  state.gallery={profile:p,photos,index:0};
  event('profile_open',{profile:p.id});
  openModal(`<div class="gallery-close-bar"><button class="icon-btn modal-close" data-action="close-modal" aria-label="Close profile">${icon('close')}</button></div><div class="modal-profile"><section class="profile-gallery" aria-label="${esc(p.name)}’s photo gallery" aria-roledescription="carousel"><div class="portrait-wrap gallery-stage protected-photo"><img id="gallery-photo" src="${photos[0]}" alt="${esc(p.name)} — photo 1 of ${photos.length}" draggable="false"><span class="image-watermark">FANTASYTALES · PRIVATE</span>${photos.length>1?`<button class="icon-btn gallery-arrow gallery-prev" data-action="gallery-prev" aria-label="Previous photo">${icon('back')}</button><button class="icon-btn gallery-arrow gallery-next" data-action="gallery-next" aria-label="Next photo">${icon('arrow')}</button>`:''}<span class="gallery-counter" aria-live="polite" aria-atomic="true">1 / ${photos.length}</span></div><div class="gallery-thumbnails protected-photo" role="group" aria-label="Choose a photo">${photos.map((src,i)=>`<button class="gallery-thumb ${i===0?'selected':''}" data-action="gallery-select" data-index="${i}" aria-label="Show photo ${i+1} of ${esc(p.name)}" aria-pressed="${i===0}"><img src="${src}" alt="" draggable="false" loading="lazy" width="55" height="68"></button>`).join('')}</div><p class="gallery-hint">${photos.length} ${photos.length===1?'photo':'photos <span>·</span> Swipe or use the arrows to explore'}</p></section><div class="modal-profile-copy"><span class="pill">${own?'Your profile':'A new connection awaits'}</span><h2 id="modal-title">${esc(p.name)}</h2>${ratingBadge(p)}<p class="profile-quote">${esc(p.prompt)}</p><p class="muted profile-biography">${profileBiography(p.bio)}</p>${objktProfileLink(p)}${own?`<a class="btn btn-primary" href="#account">Edit your profile ${icon('arrow')}</a>`:`<a class="btn btn-primary" href="#introduce/${p.id}">Say hello ${icon('arrow')}</a><button class="quiet-link" data-action="report" data-id="${p.id}">${icon('flag')}Report a concern</button>`}</div></div>`);
}
function selectGalleryPhoto(index) {
  const gallery=state.gallery,element=$('.profile-gallery');
  if(!gallery || !element)return;
  gallery.index=(index+gallery.photos.length)%gallery.photos.length;
  const photo=$('#gallery-photo',element);
  photo.src=gallery.photos[gallery.index];
  photo.alt=`${gallery.profile.name} — photo ${gallery.index+1} of ${gallery.photos.length}`;
  $('.gallery-counter',element).textContent=`${gallery.index+1} / ${gallery.photos.length}`;
  element.querySelectorAll('.gallery-thumb').forEach((button,i)=>{
    button.classList.toggle('selected',i===gallery.index);
    button.setAttribute('aria-pressed',String(i===gallery.index));
  });
  const rail=$('.gallery-thumbnails',element),selected=$('.gallery-thumb.selected',rail);
  rail.scrollTo({left:selected.offsetLeft-(rail.clientWidth-selected.clientWidth)/2,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
}
function introPage(p) {
  return `<section class="page-container fade-in"><a href="#discover" class="quiet-link">${icon('back')}Back to discover</a><div class="intro-layout"><aside class="intro-profile"><div class="portrait-wrap protected-photo"><img src="${p.image}" alt="${esc(p.name)}" draggable="false"><span class="image-watermark">FANTASYTALES · PRIVATE</span><div class="portrait-caption"><h2>${esc(p.name)}</h2></div></div><p>${esc(p.prompt)}</p></aside><div class="intro-main"><span class="eyebrow">Make the first little move</span><h1>Something starts<br>with <em>hello.</em></h1><p class="muted">Introduce yourself to ${esc(p.name)}. A thoughtful question or a little about you is a lovely place to start.</p><form data-form="introduce" data-profile="${p.id}"><div class="form-error" role="alert"></div><label for="introduction">Your first hello</label><textarea id="introduction" name="message" placeholder="Hi ${esc(p.name)}, it’s lovely to meet you. What’s something that made you smile this week?" minlength="10" maxlength="1000" required aria-describedby="intro-help"></textarea><div class="char-count" id="intro-count">0 / 1,000</div>${state.user.contact_done?`<label class="check-row"><input type="checkbox" name="shareContact"><span>Share my contact details (WhatsApp, Telegram, and LINE, where provided) with ${esc(p.name)} only if they accept this introduction.</span></label>`:''}<p id="intro-help" class="field-help">Your introduction stays pending until ${esc(p.name)} responds. Once accepted, you can chat privately here.</p><button class="btn btn-primary btn-wide" type="submit">Send a little hello ${icon('send')}</button><p class="auth-note">${icon('heart')}No expectations. Just an invitation to connect.</p></form></div></div></section>`;
}
function successPage() {
  return `<section class="success-page fade-in"><div class="success-symbol">${icon('send')}</div><span class="eyebrow">The first move is yours</span><h1>A hello.<br><em>A possibility.</em></h1><p>Your introduction ${state.lastSent?`to <strong>${esc(state.lastSent.profile)}</strong> `:''}has been sent. Give them a little time to respond. Good things deserve room to unfold.</p><div class="receipt">Your introduction is <strong>awaiting a response</strong></div><div class="button-row"><a class="btn btn-primary" href="#connections">View your connections ${icon('arrow')}</a><a class="btn btn-ghost" href="#discover">Keep exploring</a></div></section>`;
}
const dateText = date => new Date(date).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
function sharedContacts(c) {
  const contacts=c.contacts || {whatsapp:c.contact};
  const provided=contactMethods.filter(([key])=>contacts[key]);
  if(!provided.length)return '';
  return `<div class="contact-reveal"><p>${esc(c.name)} chose to share:</p><dl>${provided.map(([key,label])=>`<div><dt>${label}</dt><dd>${key==='whatsapp'?`<a href="https://wa.me/${esc(contacts[key].replace(/[^0-9]/g,''))}" rel="noreferrer" target="_blank">${esc(contacts[key])}</a>`:esc(contacts[key])}</dd></div>`).join('')}</dl></div>`;
}
function connectionCard(c) {
  const labels={pending:'Awaiting a response',accepted:'Connected',declined:'Closed',withdrawn:'Withdrawn'};
  return `<article class="connection-card" data-connection="${c.id}"><div class="connection-heading">${c.incoming || !state.user.contact_done?`<span class="avatar connection-avatar">${esc(c.name[0] || '?')}</span>`:`<img class="connection-avatar" src="${esc(c.image)}" alt="" draggable="false">`}<div><h2>${esc(c.name)}</h2><span class="small muted">${c.incoming?'A hello for you':'Your introduction'}</span></div><span class="pill status-${c.status}">${labels[c.status]}</span></div><p class="intro-message">${esc(c.message)}</p><p class="connection-time">${dateText(c.created_at)}</p>${c.status==='pending'?(c.incoming?`<div class="button-row"><button class="btn btn-primary btn-small" data-action="respond" data-id="${c.id}" data-response="accepted">Accept hello ${icon('check')}</button><button class="btn btn-ghost btn-small" data-action="respond" data-id="${c.id}" data-response="declined">No, thank you</button></div>`:`<p class="pending-note">They’ll see your hello in their inbox. Check back here for their response.</p><button class="quiet-link" data-action="respond" data-id="${c.id}" data-response="withdrawn">Withdraw introduction</button>`):''}${c.status==='accepted'?`${sharedContacts(c)}<div class="chat-log" aria-label="Conversation with ${esc(c.name)}">${c.messages.length?c.messages.map(m=>`<div class="message-bubble ${m.mine?'mine':''}"><small>${m.mine?'You':esc(m.sender)} · ${new Date(m.created_at).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}</small>${esc(m.text)}</div>`).join(''):'<p class="small muted">Your hello was accepted. Keep the conversation going.</p>'}</div><form class="chat-form" data-form="chat" data-id="${c.id}"><input name="message" placeholder="Say something thoughtful…" aria-label="Message ${esc(c.name)}" required maxlength="1000" autocomplete="off"><button type="submit" class="btn btn-primary" aria-label="Send message">${icon('send')}</button></form>`:''}<button class="quiet-link" data-action="block-confirm" data-id="${c.id}">${icon('shield')}Block this connection</button></article>`;
}
function connectionsPage() {
  return `<section class="page-container fade-in"><div class="section-heading"><div><span class="eyebrow">A little closer</span><h1>Your <em>connections.</em></h1><p>Thoughtful hellos and conversations worth keeping.</p></div><button class="btn btn-ghost btn-small" data-action="refresh">${icon('refresh')}Refresh</button></div><div id="connections-list" class="connections-list">${state.connections.length?state.connections.map(connectionCard).join(''):`<div class="empty-state">${icon('chat')}<h2>Your next story starts here.</h2><p>When you send or receive an introduction, you’ll find it here. A little curiosity goes a long way.</p><a class="btn btn-primary" href="#discover">Find a little magic ${icon('arrow')}</a></div>`}</div><p class="small muted">${state.connections.length?'Conversations refresh automatically while this page is open.':''}</p></section>`;
}
function objktSettings() {
  return `<div class="settings-card"><h2>Your NFT profile</h2><p>Add your objkt profile so people can explore your art and collection.</p><form data-form="objkt-profile"><div class="form-error" role="alert"></div><div class="field"><label for="account-objkt-url">objkt profile URL <span class="muted">(optional)</span></label><input id="account-objkt-url" name="objkt_url" type="url" inputmode="url" maxlength="500" value="${esc(state.user.objkt_url)}" placeholder="https://objkt.com/@yourname" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="objkt-help"><p id="objkt-help" class="field-help">Visible to signed-in members when your profile is featured. Paste your HTTPS objkt profile link, or clear this field to remove it.</p></div><button class="btn btn-primary" type="submit">Save NFT profile ${icon('check')}</button></form></div>`;
}
function objktProfileLink(p) {
  if(!p.objkt_url)return '';
  try {
    const url=new URL(p.objkt_url);
    if(url.protocol!=='https:' || url.hostname!=='objkt.com' || url.username || url.password || url.port)return '';
    return `<a class="objkt-profile-link" href="${esc(url.href)}" target="_blank" rel="noopener noreferrer nofollow" aria-label="View ${esc(p.name)}’s objkt NFT profile (opens in a new tab)"><span><strong>objkt NFT profile</strong><span class="objkt-profile-address">${esc(url.href.replace(/^https:\/\//,''))}</span></span>${icon('external')}</a>`;
  } catch {return '';}
}
function accountPage(owner) {
  return `<section class="page-container fade-in"><div class="section-heading"><div><span class="eyebrow">Entirely you</span><h1>Your little <em>corner.</em></h1><p>Make yourself at home. You’re in control of what you share.</p></div><button class="btn btn-ghost btn-small" data-action="logout">${icon('logout')}Sign out</button></div>${featuredInvite()}<div class="account-layout"><div class="settings-stack"><div class="settings-card"><h2>Your details</h2><p>Username: <strong>${esc(state.user.username)}</strong></p><form data-form="account"><div class="form-error" role="alert"></div><div class="field"><label for="account-name">Your name</label><input id="account-name" name="name" required minlength="2" maxlength="60" value="${esc(state.user.name)}" autocomplete="given-name"></div><fieldset class="contact-fields"><legend>How to reach you</legend><p class="field-help contact-privacy">Add at least one: WhatsApp, Telegram, or LINE. No verification required. Admin can see these details; other members only see them after an accepted hello if you choose to share.</p>${contactFields('account-')}</fieldset><button class="btn btn-primary" type="submit">Save your details ${icon('check')}</button></form></div>${objktSettings()}${owner?`<div class="settings-card"><h2>Your public profile</h2><p>A few words that sound like you.</p><form data-form="owner-profile"><div class="form-error" role="alert"></div><div class="field"><label for="profile-prompt">Your headline</label><input id="profile-prompt" name="prompt" value="${esc(owner.prompt)}" required minlength="5" maxlength="100"></div><div class="field"><label for="profile-bio">About you</label><textarea id="profile-bio" name="bio" required minlength="10" maxlength="500">${esc(owner.bio)}</textarea></div><button class="btn btn-primary" type="submit">Update profile ${icon('check')}</button></form></div>`:''}</div><div class="settings-stack"><div class="settings-card"><h2>Keep it private.</h2><p>Keep your six-digit PIN to yourself. You can change it here.</p>${pinForm()}</div>${state.user.role==='member'?`<div class="settings-card danger-section"><h2>Time for a pause?</h2><p>Deleting your account removes your details, introductions, favorites, and chat messages. Security visit logs expire within 30 days; protected backups expire within 7 days.</p><button class="btn btn-danger btn-small" data-action="delete-confirm">Delete my account</button></div>`:`<div class="settings-card"><h2>Your community role</h2><p>${state.user.role==='owner'?(owner?.published?'Your profile is featured in Discover. Incoming hellos appear in Connections. Only you can accept them.':'Your profile is hidden from Discover. You can still manage your details and existing conversations.'):'You manage this community. Introductions to your Admin profile appear in Connections. Open Admin for activity totals, profile visibility, reports, and the connections CSV.'}</p><a class="btn btn-secondary" href="#${state.user.role==='owner'?'connections':'admin'}">${state.user.role==='owner'?'Open your inbox':'Open administration'} ${icon('arrow')}</a></div>`}</div></div></section>`;
}
function memberTools(data) {
  const statusOptions=[['all','All members'],['active','Active'],['suspended','Suspended']];
  const rows=data.members.map(member=>`<article class="admin-member" data-member="${member.id}"><div class="member-info"><div class="member-heading"><div><h3>${esc(member.name || 'Name not added')}</h3><p class="small muted">@${esc(member.username)}</p></div><span class="pill ${member.suspended?'status-declined':'status-accepted'}">${member.suspended?'Suspended':'Active'}</span></div><dl class="member-details"><div><dt>WhatsApp</dt><dd>${esc(member.whatsapp || 'Not added')}</dd></div><div><dt>Telegram</dt><dd>${esc(member.telegram || 'Not added')}</dd></div><div><dt>LINE</dt><dd>${esc(member.line || 'Not added')}</dd></div><div><dt>Joined</dt><dd>${dateText(member.created_at)}</dd></div><div><dt>Introductions</dt><dd>${member.introductions}</dd></div></dl>${member.suspended?`<p class="member-reason"><strong>Suspension reason:</strong> ${esc(member.suspension_reason)}</p>`:''}</div><div class="member-actions"><button class="btn ${member.suspended?'btn-secondary':'btn-ghost'} btn-small" data-action="admin-member-status" data-id="${member.id}">${member.suspended?'Reactivate':'Suspend'}</button><button class="btn btn-ghost btn-small" data-action="admin-member-pin" data-id="${member.id}">Reset PIN</button></div></article>`).join('');
  const actions={MEMBER_SUSPENDED:'Suspended member',MEMBER_REACTIVATED:'Reactivated member',MEMBER_PIN_RESET:'Reset member PIN'};
  return `<section class="settings-card member-directory" aria-label="Member management"><div class="member-directory-heading"><div><h2>Member directory</h2><p class="small muted">${data.summary.total-data.summary.suspended} active · ${data.summary.suspended} suspended · ${data.summary.total} registered</p></div>${icon('user')}</div><form class="member-search" data-form="admin-search"><div class="field"><label for="member-search">Find a member</label><input type="search" id="member-search" name="search" maxlength="80" placeholder="Name, username, or contact" value="${esc(state.adminSearch)}"></div><div class="field"><label for="member-status">Account status</label><select id="member-status" name="status">${statusOptions.map(([value,label])=>`<option value="${value}" ${state.adminStatus===value?'selected':''}>${label}</option>`).join('')}</select></div><button class="btn btn-secondary" type="submit">Search ${icon('search')}</button></form><div class="form-error" role="alert"></div><p class="small muted member-result-count">${data.total} ${data.total===1?'member':'members'} found</p><div class="admin-member-list">${rows || '<div class="empty-state"><h3>No members found.</h3><p>Try another name or change the status filter.</p></div>'}</div><div class="member-pagination"><button class="btn btn-ghost btn-small" data-action="admin-member-page" data-page="${data.page-1}" ${data.page<=1?'disabled':''}>Previous</button><span class="small muted">Page ${data.page} of ${data.pages}</span><button class="btn btn-ghost btn-small" data-action="admin-member-page" data-page="${data.page+1}" ${data.page>=data.pages?'disabled':''}>Next</button></div></section><details class="settings-card member-audit"><summary>Recent member actions</summary><p class="small muted">The latest 20 changes, retained for 30 days.</p>${data.audit.length?data.audit.map(entry=>`<div class="audit-entry"><strong>${esc(actions[entry.action] || entry.action)} · @${esc(entry.target_username)}</strong><p>${esc(entry.reason)}</p><span class="small muted">${esc(entry.actor_username)} · ${dateText(entry.created_at)} ${new Date(entry.created_at).toLocaleTimeString()}</span></div>`).join(''):'<p class="muted small">No member-management actions yet.</p>'}</details>`;
}
function memberActionModal(kind,id) {
  const member=state.adminMembers?.members.find(member=>member.id===Number(id));
  if(!member){toast('Refresh the member list and try again.');return;}
  const reset=kind==='pin',suspend=!member.suspended;
  const title=reset?'Reset member PIN':suspend?'Suspend member':'Reactivate member';
  openModal(`<button class="icon-btn modal-close" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button><div class="modal-form"><h2 id="modal-title">${title}</h2><p><strong>${esc(member.name || member.username)}</strong> · @${esc(member.username)}<br>${reset?'Generate a new six-digit PIN and sign this member out on every device.':suspend?'This member will be signed out and unable to sign in until you reactivate the account. Their details and connections are kept.':'This member will be able to sign in again with their current PIN.'}</p><form data-form="${reset?'admin-reset-pin':'admin-member-status'}" data-id="${member.id}" data-suspended="${suspend}"><div class="form-error" role="alert"></div><div class="field"><label for="member-action-reason">Reason for this change</label><textarea id="member-action-reason" name="reason" minlength="5" maxlength="300" required placeholder="A brief note for the account history"></textarea></div>${reset?secretField('admin-confirm-pin','adminPin','Your administrator PIN'):''}<button type="submit" class="btn ${suspend&&!reset?'btn-danger':'btn-primary'} btn-wide">${reset?'Generate new PIN':suspend?'Suspend member':'Reactivate member'}</button></form></div>`);
}
function ratingRows(profiles) {
  return profiles.map(p=>`<article class="rating-admin-row"><div><h3>${esc(p.name)}</h3><span class="small muted">${p.published?'Published':'Hidden'} · ${esc(p.status)}</span>${p.assessed_at?`<p class="small muted">Assessed ${dateText(p.assessed_at)}</p>`:''}${p.error?`<p class="rating-error" role="status">${esc(p.error)}</p>`:''}</div><div class="rating-admin-value">${p.score===null?'—':Number(p.score).toFixed(1)+' / 5'}${p.quality!==null?`<small>Quality ${Number(p.quality).toFixed(1)} · Attractiveness ${Number(p.attractiveness).toFixed(1)}</small>`:''}</div></article>`).join('');
}
function ratingSettings(data) {
  const status=data.running?'Checking profiles':data.queued?'Check queued':({completed:'Check complete',partial:'Some profiles need attention',error:'Check needs attention',daily_limit:'Daily limit reached',paused:'Scoring paused',not_configured:'Add your API key'})[data.lastStatus] || 'Ready';
  return `<div class="ratings-layout"><section class="settings-card"><span class="eyebrow">Daily profile assessments</span><h2>AI profile ratings</h2><p>A score out of five, shown to signed-in members. Profile quality and subjective visual attractiveness each contribute 50%.</p><div class="rating-status"><span class="pill">${esc(status)}</span><p class="small muted">${esc(data.schedule)} · ${data.requestsToday} / ${data.dailyLimit} requests used today.<br>${data.lastFinished?'Last check '+dateText(data.lastFinished)+' '+new Date(data.lastFinished).toLocaleTimeString():'No completed checks yet.'}</p>${data.lastError?`<p class="rating-error" role="status">${esc(data.lastError)}</p>`:''}</div><form data-form="rating-settings"><div class="form-error" role="alert"></div><div class="field"><label for="openai-key">OpenAI API key</label><input id="openai-key" type="password" name="apiKey" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="515" placeholder="${data.configured?'Key saved — leave blank to keep it':'sk-…'}"><p class="field-help">Stored privately on the server and never returned to the browser. ${data.configured?'A key is saved; the next assessment checks whether it works.':'Add a key from your OpenAI API project with Responses API access and available billing.'}</p></div>${secretField('ratings-admin-pin','adminPin','Your administrator PIN')}<label class="check-row"><input type="checkbox" name="enabled" ${data.enabled?'checked':''}><span>Enable daily AI ratings. Profile headlines, biographies, and photos will be sent to OpenAI, with usage billed to this API project.</span></label><p class="field-help">Account phone numbers, PINs, messages, and visit logs are excluded. Changed profiles are reassessed; unchanged profiles keep their scores. Pausing keeps existing scores visible.</p><br><button class="btn btn-primary btn-wide" type="submit">Save AI settings ${icon('lock')}</button></form></section><section class="settings-card"><div class="member-directory-heading"><div><h2>Profile scores</h2><p class="small muted">Refresh this page to see the latest results.</p></div></div><button class="btn btn-secondary btn-wide" data-action="run-ratings" ${!data.enabled||!data.configured||data.running||data.queued?'disabled':''}>Check changed profiles now ${icon('refresh')}</button><div class="rating-admin-list">${ratingRows(data.profiles)}</div><p class="small muted">A failed assessment keeps the previous score. New profiles stay unrated until an assessment succeeds.</p></section></div>`;
}
function adminPage(data) {
  const overview=`<div class="account-layout"><div class="settings-card"><h2>Featured profiles</h2><p>Hidden profiles no longer appear in discovery.</p>${data.profiles.map(p=>`<div class="admin-profile"><div><h3>${esc(p.name)}</h3><span class="small muted">${p.published?'Visible to members':'Hidden'}</span></div><button class="btn btn-ghost btn-small" data-action="publish" data-id="${p.id}" data-published="${p.published?'0':'1'}">${p.published?'Hide profile':'Publish profile'}</button></div>`).join('')}</div><div class="settings-card"><h2>Member reports</h2><p>Reports are visible only to the administrator.</p>${data.reports.length?data.reports.map(r=>`<div class="report-card"><strong>${esc(r.name)}</strong><span class="small muted"> · ${dateText(r.created_at)}</span><p>${esc(r.reason)}</p></div>`).join(''):'<p>No reports have been submitted.</p>'}</div></div>`;
  return `<section class="page-container fade-in"><div class="section-heading admin-heading"><div><span class="eyebrow">Behind the stories</span><h1>Community <em>overview.</em></h1><p>Private tools for looking after your community.</p></div><div class="button-row"><button class="btn btn-ghost btn-small" data-action="refresh">${icon('refresh')}Refresh</button><a class="btn btn-secondary btn-small" href="/api/admin/export" download>${icon('download')}Export CSV</a></div></div><div class="stats-grid"><div class="stat-card"><strong>${data.stats.members}</strong><span>Member accounts</span></div><div class="stat-card"><strong>${data.stats.introductions}</strong><span>Introductions sent</span></div><div class="stat-card"><strong>${data.stats.connections}</strong><span>Mutual connections</span></div></div><div class="filters admin-sections" role="group" aria-label="Administration sections"><button class="filter ${state.adminTab==='members'?'active':''}" data-action="admin-tab" data-tab="members" aria-pressed="${state.adminTab==='members'}">Members</button><button class="filter ${state.adminTab==='overview'?'active':''}" data-action="admin-tab" data-tab="overview" aria-pressed="${state.adminTab==='overview'}">Profiles & reports</button><button class="filter ${state.adminTab==='ratings'?'active':''}" data-action="admin-tab" data-tab="ratings" aria-pressed="${state.adminTab==='ratings'}">AI ratings</button></div>${state.adminTab==='members'?memberTools(state.adminMembers):state.adminTab==='ratings'?ratingSettings(data.ratings):overview}</section>`;
}
function documentPage(page) {
  const privacy=page==='privacy';
  return `<section class="page-container document fade-in"><a class="quiet-link" href="#${nextPage()}">${icon('back')}Back to Fantasy Tales</a><br><br><span class="eyebrow">A space built on respect</span><h1>${privacy?'Your privacy <em>matters.</em>':'A little kindness.<br><em>A better connection.</em>'}</h1>${privacy?`<p>Fantasy Tales is an adults-only dating community. This notice explains how the community operator handles information on this website. Last updated ${dateText(new Date().toISOString())}.</p><h2>What we collect</h2><p>We store your username, a securely hashed PIN (or your existing password hash until you switch to a PIN), display name, contact details (at least one WhatsApp number, Telegram username, or LINE ID), saved profiles, introductions, messages, and reports. Essential cookies keep you signed in and protect your session. Browser session storage helps group your visits. We do not use advertising cookies or third-party analytics.</p><h2>Visit and activity records</h2><p>The administrator can suspend or reactivate member accounts and reset access PINs. Reasons for these account changes and the administrator who made them are recorded for 30 days. For security and operating the site, we record your IP address, time of visit, pages opened, name changes, profile views, saved profiles, and introduction status changes. PINs, passwords, and message contents are not copied into these activity logs. Each visit is recorded in a private server text file. The operator can also export a private CSV containing user names, WhatsApp numbers, Telegram usernames, LINE IDs, profiles, introduction times, and statuses.</p><h2>Who can see what</h2><p>Profiles and photos are visible to signed-in members. An introduction is visible to its sender and the receiving profile owner. Chat opens only after the owner accepts. Your contact details are shared with that owner only if you explicitly selected sharing for that introduction and it was accepted. Earlier WhatsApp-only sharing permissions do not include Telegram or LINE. The site operator administers the service and can access server records, including conversations, for operation and responding to reports. Messages are not end-to-end encrypted.</p><h2>How long information stays</h2><p>Activity logs are automatically removed after 30 days. Account details, introductions, and messages remain while your account exists. You can delete a member account in Account; this removes its personal details, introductions, favorites, and messages from the active database and CSV. Security visit logs expire within 30 days and access-restricted server backups expire within 7 days. The backups are not encrypted at rest.</p><h2>Your choices</h2><p>A nickname is welcome. At least one contact detail is required before viewing profiles: a WhatsApp number with country code, Telegram username, or LINE ID. We do not verify these details or send verification messages. Providing them to the administrator does not automatically share them with other members. Update your details or PIN in Account, withdraw a pending introduction, block a connection, or report a profile. For account access issues or a photo-removal request, contact the community organizer who invited you. Profile owners can ask the administrator to hide or remove their profile. An optional objkt NFT profile link can be added or removed in Account. It is visible to signed-in members on your featured profile. We do not verify ownership or fetch its contents.</p><h2>AI profile ratings</h2><p>When enabled by the administrator, profile headlines, biographies, and photos are sent to OpenAI to produce a score visible to signed-in members. The score gives equal weight to profile quality and subjective visual attractiveness. It does not verify identity or predict compatibility. Account contact fields, PINs, messages, and visit logs are not sent for scoring. Changed profiles are checked daily. The site retains each current score and up to 30 previous successful assessments per profile. Requests use the API’s non-storage setting; OpenAI may still retain data for abuse monitoring under its <a href="https://developers.openai.com/api/docs/guides/your-data" target="_blank" rel="noopener noreferrer">API data controls</a>. Contact the organizer about photo removal or concerns about an assessment.</p><h2>Photos and confidentiality</h2><p>Please respect other members’ privacy. Photos require sign-in and casual saving and printing are discouraged. Browser screenshot and download prevention cannot be guaranteed. Do not copy, repost, or share anyone’s photos or conversations without permission.</p>`:`<p>Fantasy Tales is for adults aged 18 and over, seeking consensual, non-commercial dating connections. A thoughtful hello can go a long way.</p><h2>Be yourself. Be respectful.</h2><p>Use only your own identity and photos you have permission to share. Do not impersonate anyone, misrepresent your age, or publish someone else’s information.</p><h2>Interest must be mutual.</h2><p>An introduction is an invitation to talk, not a promise of a date. The recipient can accept, decline, or choose not to respond. Respect their choice and do not pressure or repeatedly contact them. Blocking ends access to the connection.</p><h2>Keep the community welcoming.</h2><p>Harassment, threats, scams, explicit sexual messages, unsolicited intimate images, and requests for money are not welcome. Commercial sexual services, paid encounters, and sexual-service bookings are not permitted.</p><h2>Take your time.</h2><p>You choose what to share and when. Keep early conversations on the site. If you decide to meet, choose a public place, tell someone you trust, and arrange your own transport. Never send money or sensitive financial information to someone you have just met.</p><h2>Speak up.</h2><p>Use “Report a concern” on a profile to notify the administrator, or block a connection from your inbox. If there is an immediate threat, contact your local emergency service.</p>`}<hr><a href="#${nextPage()}" class="btn btn-secondary">Back to your story ${icon('arrow')}</a></section>`;
}
async function render() {
  const seq=++renderSequence;clearInterval(connectionTimer);
  const [requested,id]=(location.hash.slice(1) || nextPage()).split('/');
  let page=requested;
  if(!['privacy','guidelines'].includes(page)) {
    if(!state.user) page='welcome';
    else if(state.user.needs_pin) page='pin-setup';
    else if(!state.user.name && page!=='account') page='name';
    else if(!state.user.contact_done && !['name','contact','account'].includes(page) && !(page==='admin' && state.user.role==='admin') && !(page==='connections' && state.user.profile_id)) page='contact';
    else if(page==='welcome') page=nextPage();
  }
  state.page=page;shell();closeModal();
  try {
    let html;
    if(page==='welcome') html=authPage();
    else if(page==='pin-setup') html=pinSetupPage();
    else if(['name','contact'].includes(page)) html=onboarding(page);
    else if(page==='discover'||page==='introduce') {
      const [profiles,featured]=await Promise.all([api('/api/profiles'),page==='discover'?api('/api/featured-request'):Promise.resolve(null)]);
      state.profiles=profiles.profiles;if(featured)state.featuredRequest=featured;
      if(page==='introduce'){const p=state.profiles.find(p=>p.id===id);if(!p){goto('discover');return;}if(p.id===state.user.profile_id){goto('account');return;}html=introPage(p);}
      else html=discoverPage();
    } else if(page==='sent') html=successPage();
    else if(page==='connections'){state.connections=(await api('/api/connections')).connections;html=connectionsPage();}
    else if(page==='account'){const [owner,featured]=await Promise.all([state.user.profile_id?api('/api/owner/profile'):Promise.resolve(null),api('/api/featured-request')]);state.featuredRequest=featured;html=accountPage(owner?.profile);}
    else if(page==='admin'){
      if(state.user.role!=='admin'){goto('discover');return;}
      const query=new URLSearchParams({search:state.adminSearch,status:state.adminStatus,page:String(state.adminMemberPage)});
      const [data,members]=await Promise.all([api('/api/admin'),state.adminTab==='members'?api('/api/admin/members?'+query):Promise.resolve(null)]);
      if(seq!==renderSequence)return;
      if(members){state.adminMembers=members;state.adminMemberPage=members.page;}
      html=adminPage(data);
    }
    else if(['privacy','guidelines'].includes(page)) html=documentPage(page);
    else {goto(nextPage());return;}
    if(seq!==renderSequence)return;
    $('#main').innerHTML=html;
    document.title=`${({welcome:'Let a little magic in','pin-setup':'Set your PIN',name:'Your name',contact:'Keep in touch',discover:'Discover',introduce:'Say hello',sent:'Hello sent',connections:'Connections',account:'Your account',admin:'Community',privacy:'Privacy',guidelines:'Community guidelines'})[page]} — Fantasy Tales`;
    event('page_open',{page});
    window.scrollTo({top:0,behavior:'instant'});
    $('#main').focus({preventScroll:true});
    if(page==='connections') {
      connectionTimer=setInterval(refreshConnections,15000);
      if(/^[a-f0-9-]{36}$/.test(id || '')){const card=$(`[data-connection="${id}"]`);if(card){card.tabIndex=-1;card.scrollIntoView({block:'start'});card.focus({preventScroll:true});}}
    }
  } catch(e) {
    if(e.status===401){state.user=null;clearAdminState();goto('welcome');return;}
    if(e.code==='PIN_REQUIRED'){state.user.needs_pin=1;goto('pin-setup');return;}
    if(['CONTACT_REQUIRED','WHATSAPP_REQUIRED'].includes(e.code)){state.user.contact_done=0;goto('contact');return;}
    $('#main').innerHTML=`<section class="page-container"><div class="empty-state">${icon('moon')}<h2>A little pause.</h2><p>${esc(e.message)}</p><button class="btn btn-primary" data-action="refresh">Try again ${icon('refresh')}</button></div></section>`;
  }
}
async function refreshConnections() {
  if(document.hidden || state.page!=='connections' || $('#modal').open)return;
  try {
    const rows=(await api('/api/connections')).connections;
    if(JSON.stringify(rows)===JSON.stringify(state.connections))return;
    if(document.activeElement?.closest('.chat-form'))return;
    state.connections=rows;$('#connections-list').innerHTML=rows.length?rows.map(connectionCard).join(''):connectionsPage().match(/<div id="connections-list" class="connections-list">([\s\S]*)<\/div><p class="small/)[1];
  } catch { /* Keep drafts and offer manual refresh after temporary network failures. */ }
}
function openModal(html){const modal=$('#modal');modal.innerHTML=html;if(!modal.open)modal.showModal();modal.scrollTop=0;}
function closeModal(){const modal=$('#modal');if(modal.open)modal.close();}
function formError(form,message){const error=$('.form-error',form);if(error){error.className='form-error error';error.textContent=message;error.scrollIntoView({block:'nearest'});}else toast(message);}
async function submitForm(form) {
  const data=Object.fromEntries(new FormData(form)),kind=form.dataset.form,button=$('button[type=submit]',form);
  if(button?.disabled)return;
  if(button)button.disabled=true;form.setAttribute('aria-busy','true');
  const error=$('.form-error',form);if(error){error.textContent='';error.className='form-error';}
  try {
    if(('confirmPin' in data) && data.pin!==data.confirmPin) throw new Error('Your PINs do not match. Enter the same six digits in both fields.');
    if(kind==='auth') {
      const result=await api(`/api/auth/${state.authMode}`,'POST',{username:data.username,pin:data.pin,currentPassword:data.currentPassword,adultConsent:data.adultConsent==='on',privacyConsent:data.privacyConsent==='on'});
      state.user=result.user;state.csrf=result.csrf;goto(nextPage());
    } else if(kind==='name'||kind==='contact'||kind==='account') {
      if(kind!=='name' && !contactMethods.some(([key])=>data[key]?.trim()))throw new Error('Add at least one: WhatsApp number, Telegram username, or LINE ID.');
      state.user=(await api('/api/me','PATCH',kind==='name'?{name:data.name}:data)).user;
      if(kind==='account'){toast('Your details have been saved.');shell();}else goto(nextPage());
    } else if(kind==='objkt-profile') {
      state.user=(await api('/api/me','PATCH',{objkt_url:data.objkt_url})).user;
      $('#account-objkt-url',form).value=state.user.objkt_url;
      toast(state.user.objkt_url?'Your NFT profile has been saved.':'Your NFT profile link has been removed.');
    } else if(kind==='introduce') {
      state.lastSent=await api('/api/connections','POST',{profile:form.dataset.profile,message:data.message,shareContact:data.shareContact==='on',shareMessengerContacts:data.shareContact==='on'});goto('sent');
    } else if(kind==='featured-request') {
      const connection=form.dataset.connection;
      const result=connection?await api(`/api/connections/${connection}/messages`,'POST',{message:data.message}):await api('/api/connections','POST',{profile:form.dataset.profile,message:data.message,shareContact:false});
      goto(`connections/${connection || result.id}`);toast(connection?'Your message was sent to Admin.':'Your hello was sent to Admin. Check Connections for their reply.');
    } else if(kind==='chat') {
      await api(`/api/connections/${form.dataset.id}/messages`,'POST',{message:data.message});form.reset();
      state.connections=(await api('/api/connections')).connections;
      const c=state.connections.find(c=>c.id===form.dataset.id),card=form.closest('.connection-card');
      if(c&&card){card.outerHTML=connectionCard(c);const fresh=$(`[data-connection="${c.id}"]`);$('.chat-log',fresh).scrollTop=$('.chat-log',fresh).scrollHeight;$('input',fresh).focus({preventScroll:true});}
    } else if(kind==='pin') {const legacy=state.user.needs_pin;const result=await api('/api/me/pin','POST',data);state.csrf=result.csrf;state.user=result.user;form.reset();toast('Your PIN has been saved. Other sessions are signed out.');if(legacy)goto(nextPage());}
    else if(kind==='admin-search') {state.adminSearch=data.search.trim();state.adminStatus=data.status;state.adminMemberPage=1;await render();}
    else if(kind==='admin-member-status') {const suspended=form.dataset.suspended==='true';await api(`/api/admin/members/${form.dataset.id}`,'PATCH',{suspended,reason:data.reason});await render();toast(suspended?'Member suspended and signed out.':'Member reactivated. They can sign in again.');}
    else if(kind==='admin-reset-pin') {
      const result=await api(`/api/admin/members/${form.dataset.id}/reset-pin`,'POST',{adminPin:data.adminPin,reason:data.reason});
      await render();
      openModal(`<button class="icon-btn modal-close" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button><div class="modal-form" data-sensitive><h2 id="modal-title">New PIN created.</h2><p>New PIN for <strong>@${esc(result.username)}</strong>. It is shown only here; share it privately with the member. Their previous PIN and active sessions have been invalidated.</p><output class="reset-pin" aria-label="New member PIN">${esc(result.pin)}</output><p>The member can change this PIN in Account after signing in.</p><button class="btn btn-primary btn-wide" data-action="close-modal">Done</button></div>`);
    }
    else if(kind==='rating-settings'){await api('/api/admin/ratings','PATCH',{apiKey:data.apiKey,adminPin:data.adminPin,enabled:data.enabled==='on'});form.reset();await render();toast(data.enabled==='on'?'AI settings saved. A check is queued.':'AI rating checks paused.');}
    else if(kind==='owner-profile'){await api('/api/owner/profile','PATCH',data);toast('Your profile has been updated.');}
    else if(kind==='report'){await api('/api/reports','POST',{profile:form.dataset.profile,reason:data.reason});closeModal();toast('Your report has been sent to the administrator.');}
    else if(kind==='delete'){await api('/api/me','DELETE',{pin:data.pin});state.user=null;closeModal();await initSession();goto('welcome');toast('Your account has been deleted.');}
  } catch(e){formError(form,e.message);}finally{if(button)button.disabled=false;form.removeAttribute('aria-busy');}
}
document.addEventListener('submit',e=>{const form=e.target.closest('form[data-form]');if(form){e.preventDefault();submitForm(form);}});
document.addEventListener('click',async e=>{
  const link=e.target.closest('a[href^="#"]');if(link)closeModal();
  const b=e.target.closest('[data-action]');if(!b || b.disabled)return;
  const action=b.dataset.action,id=b.dataset.id;
  try {
    if(action==='auth-mode'){state.authMode=b.dataset.mode;$('#main').innerHTML=authPage();}
    else if(action==='toggle-secret'){const input=document.getElementById(b.dataset.target);input.type=input.type==='password'?'text':'password';b.innerHTML=icon(input.type==='password'?'eye':'eyeoff');b.setAttribute('aria-label',`${input.type==='password'?'Show':'Hide'} ${b.dataset.label}`);}
    else if(action==='rating-info'){ratingInfo(b.dataset.id);}
    else if(action==='contact-method'){
      const form=b.closest('form'),method=b.dataset.method;
      for(const option of $$('[data-action="contact-method"]',form)){const selected=option.dataset.method===method;option.classList.toggle('active',selected);option.setAttribute('aria-pressed',String(selected));}
      for(const field of $$('[data-contact-field]',form)){const selected=field.dataset.contactField===method;field.hidden=!selected;const input=$('input',field);input.disabled=!selected;input.required=selected;}
      $(`[name="${method}"]`,form).focus();
    }
    else if(action==='feature-request'){
      b.disabled=true;const request=await api('/api/featured-request');state.featuredRequest=request;
      if(!request.eligible){await render();toast('Your profile is already featured.');}
      else if(request.requiresContact){goto('contact');toast('Add WhatsApp, Telegram, or LINE before contacting Admin.');}
      else featuredRequestModal(request);
      b.disabled=false;
    }
    else if(action==='run-ratings'){b.disabled=true;await api('/api/admin/ratings/run','POST',{});await render();toast('Changed profiles are queued for assessment.');}
    else if(action==='logout'){await api('/api/auth/logout','POST',{});state.user=null;clearAdminState();state.profiles=[];state.connections=[];sessionStorage.removeItem('ft_visit');state.visit='';await initSession();goto('welcome');}
    else if(action==='profile')profileModal(id);
    else if(action==='gallery-prev')selectGalleryPhoto(state.gallery.index-1);
    else if(action==='gallery-next')selectGalleryPhoto(state.gallery.index+1);
    else if(action==='gallery-select')selectGalleryPhoto(Number(b.dataset.index));
    else if(action==='close-modal')closeModal();
    else if(action==='save'){const p=state.profiles.find(p=>p.id===id);b.disabled=true;const result=await api(`/api/favorites/${id}`,'POST',{saved:!p.saved});p.saved=result.saved;$('#profile-grid').innerHTML=cards();toast(p.saved?`${p.name} is in your saved profiles.`:'Profile removed from saved.');}
    else if(action==='filter'||action==='reset-filter'){
      const next=action==='reset-filter'?'all':b.dataset.filter;
      state.filter=next;if(next==='all')state.search='';
      $('#main').innerHTML=discoverPage();
      if(next==='all'){
        const sequence=renderSequence,request=++discoveryRefresh;
        const [response,featured]=await Promise.all([api('/api/profiles'),api('/api/featured-request')]);
        const profiles=response.profiles;
        if(state.page!=='discover'||sequence!==renderSequence||request!==discoveryRefresh)return;
        state.profiles=profiles;state.featuredRequest=featured;$('#main').innerHTML=discoverPage();
      }
    }
    else if(action==='refresh')await render();
    else if(action==='respond'){b.disabled=true;await api(`/api/connections/${id}/respond`,'POST',{action:b.dataset.response});await render();toast(b.dataset.response==='accepted'?'A new connection. Say hello.':'Your introduction has been updated.');}
    else if(action==='admin-tab'){state.adminTab=b.dataset.tab;await render();}
    else if(action==='admin-member-page'){state.adminMemberPage=Number(b.dataset.page);await render();}
    else if(action==='admin-member-status')memberActionModal('status',id);
    else if(action==='admin-member-pin')memberActionModal('pin',id);
    else if(action==='publish'){b.disabled=true;await api(`/api/admin/profiles/${id}`,'PATCH',{published:b.dataset.published==='1'});await render();toast('Profile visibility updated.');}
    else if(action==='report'){const p=state.profiles.find(p=>p.id===id);openModal(`<button class="icon-btn modal-close" data-action="close-modal" aria-label="Close report">${icon('close')}</button><div class="modal-form"><h2 id="modal-title">Report a concern.</h2><p>Tell us what concerns you about ${esc(p.name)}’s profile. Your report goes privately to the administrator.</p><form data-form="report" data-profile="${id}"><div class="form-error" role="alert"></div><div class="field"><label for="report-reason">What happened?</label><textarea id="report-reason" name="reason" required minlength="10" maxlength="500" placeholder="Please include enough detail for us to look into it."></textarea></div><button type="submit" class="btn btn-primary btn-wide">Submit report ${icon('flag')}</button></form></div>`);}
    else if(action==='block-confirm'){openModal(`<button class="icon-btn modal-close" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button><div class="modal-form"><h2 id="modal-title">Your peace comes first.</h2><p>Blocking removes this connection from both inboxes and prevents further introductions or messages between you. Contact the community organizer if you need this reversed.</p><button class="btn btn-danger btn-wide" data-action="block" data-id="${id}">Block this connection</button></div>`);}
    else if(action==='block'){b.disabled=true;await api(`/api/connections/${id}/block`,'POST',{});closeModal();await render();toast('This connection has been blocked.');}
    else if(action==='delete-confirm'){openModal(`<button class="icon-btn modal-close" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button><div class="modal-form"><h2 id="modal-title">Close this chapter?</h2><p>This permanently deletes your account, introductions, and messages. Enter your six-digit PIN to confirm.</p><form data-form="delete"><div class="form-error" role="alert"></div>${secretField('delete-pin','pin','Your PIN')}<button class="btn btn-danger btn-wide" type="submit">Permanently delete my account</button></form></div>`);}
  }catch(error){toast(error.message);b.disabled=false;}
});
document.addEventListener('input',e=>{
  if(e.target.id==='profile-search'){state.search=e.target.value;$('#profile-grid').innerHTML=cards();}
  if(e.target.id==='introduction')$('#intro-count').textContent=`${e.target.value.length} / 1,000`;
});
document.addEventListener('contextmenu',e=>{if(e.target.closest('.protected-photo')){e.preventDefault();toast('Please respect members’ privacy and keep their photos here.');}});
document.addEventListener('dragstart',e=>{if(e.target.closest('.protected-photo'))e.preventDefault();});
$('#modal').addEventListener('close',()=>{const modal=$('#modal');if(!modal.open&&modal.querySelector('[data-sensitive]'))modal.innerHTML='';});
$('#modal').addEventListener('click',e=>{if(e.target===$('#modal'))closeModal();});
$('#modal').addEventListener('keydown',e=>{
  if(!$('.profile-gallery') || !['ArrowLeft','ArrowRight'].includes(e.key))return;
  e.preventDefault();selectGalleryPhoto(state.gallery.index+(e.key==='ArrowRight'?1:-1));
});
let galleryGesture=null;
document.addEventListener('pointerdown',e=>{
  if(e.pointerType==='mouse' || !e.target.closest('.gallery-stage') || e.target.closest('button'))return;
  galleryGesture={x:e.clientX,y:e.clientY,id:e.pointerId};
});
document.addEventListener('pointerup',e=>{
  if(!galleryGesture || galleryGesture.id!==e.pointerId)return;
  const dx=e.clientX-galleryGesture.x,dy=e.clientY-galleryGesture.y;
  galleryGesture=null;
  if(Math.abs(dx)>45 && Math.abs(dx)>Math.abs(dy)*1.5 && $('.profile-gallery'))selectGalleryPhoto(state.gallery.index+(dx<0?1:-1));
});
document.addEventListener('pointercancel',()=>{galleryGesture=null;});
window.addEventListener('hashchange',render);
async function start(){try{await initSession();await render();}catch(e){shell();$('#main').innerHTML=`<section class="page-container"><div class="empty-state"><h2>We’ll be right with you.</h2><p>${esc(e.message)}</p><button class="btn btn-primary" id="retry-start">Try again</button></div></section>`;$('#retry-start').addEventListener('click',start);}}
start();
