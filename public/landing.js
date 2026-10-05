'use strict';
// Preserve links shared before the public homepage and member app were separated.
const legacyPages = new Set(['welcome','pin-setup','name','contact','discover','profile','introduce','sent','connections','account','admin','privacy','guidelines']);
const legacyPage = location.hash.slice(1).split('/')[0];
if (location.pathname === '/' && legacyPages.has(legacyPage)) location.replace('/app' + location.hash);
