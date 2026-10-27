import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import QRCode from 'qrcode';
import { ActivationServiceImpl } from '../domain/activation';
import { openSqliteDatabase } from '../db/migrate';
import { DomainError, errors, toErrorBody, type AuditLogWriter, type GroupId, type SessionPrincipal } from '../shared/contracts';
import { DbActivationRepository } from './db-activation-repository';
import { createAuthContext, getServices } from './auth-context';
export interface ActivationMail { send(message: { to: string; url: string }): Promise<void> }
export interface ActivationOptions { sqlite: Database.Database; audit: AuditLogWriter; hmacSecret: string; baseUrl: string; now?: () => number; mail?: ActivationMail }
export function publicActivationBase(raw: string): string {
 let url: URL; try { url = new URL(raw); } catch { throw unavailable('Public HTTPS APP_BASE_URL is required'); }
 const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
 // IP literals, local domains and non-HTTPS destinations are not phone-demo URLs.
 if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || isIP(host) || !host.includes('.') || /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)) throw unavailable('Public HTTPS APP_BASE_URL is required');
 return url.origin;
}
function unavailable(message: string) { return new DomainError('UNAVAILABLE',message,503); }
export function createActivationServices(o: ActivationOptions) {
 const repo = new DbActivationRepository(o.sqlite); const now = o.now ?? Date.now;
 const domain = new ActivationServiceImpl({ repository: repo, audit: o.audit, now, hmacSecret:o.hmacSecret });
 const base = () => publicActivationBase(o.baseUrl);
 function rate(key: string, limit: number) {
  const hash = createHmac('sha256',o.hmacSecret).update('activation:rate\0'+key).digest('hex');
  if (!repo.takeRateLimit(hash,now(),limit,60*60*1000)) throw new DomainError('RATE_LIMITED','Too many activation attempts',429);
 }
 return { domain, repo,
  async issue(actor: SessionPrincipal, groupId: string) {
   if (!repo.canIssue(actor,groupId)) throw errors.forbidden();
   rate('issue:'+actor.userId,20); const origin=base();
   const token=await domain.issueQr({groupId:groupId as GroupId,ttlMs:24*60*60*1000});
   const url=origin+'/activate#qr='+token;
   return {url,svg:await QRCode.toString(url,{type:'svg',errorCorrectionLevel:'M',margin:4}),expiresAt:now()+24*60*60*1000};
  },
  async email(qrToken: string,email: string) {
   // A global budget cannot be bypassed by spoofing proxy headers or random identities.
   rate('email:global',200); rate('email:'+email.trim().toLowerCase(),5); rate('email:qr:'+qrToken,100);
   if (!o.mail) throw unavailable('Activation email delivery is not configured');
   const origin=base(); const token=await domain.issueEmailToken({qrToken,email,ttlMs:15*60*1000});
   try { await o.mail.send({to:email.trim().toLowerCase(),url:origin+'/activate#email='+token}); }
   catch { await domain.revoke(token); throw unavailable('Activation email delivery failed'); }
  },
  async redeem(token: string,studentId: string) {
   rate('redeem:global',300);rate('redeem:student:'+studentId,10);rate('redeem:token:'+token,10);
   await domain.activate({token,studentId});
   return { activated:true, loginRequired:true }; // Never mint a session from an activation bearer token.
  },
  async revoke(actor: SessionPrincipal,groupId:string,token:string) {
   if (!repo.canIssue(actor,groupId)) throw errors.forbidden();
   const hash=createHmac('sha256',o.hmacSecret).update('local-github:activation:v1\0').update(token).digest('hex');
   const record=await repo.findToken(hash); if (!record || record.groupId!==groupId || record.kind!=='qr') throw errors.notFound();
   await domain.revoke(token);
  },
 };
}
export type ActivationServices = ReturnType<typeof createActivationServices>;
const headers = { 'cache-control':'no-store', 'referrer-policy':'no-referrer', 'x-content-type-options':'nosniff' };
export function createActivationHandlers(s:ActivationServices, principal:(req:Request)=>Promise<SessionPrincipal|null>) {
 async function run(fn:()=>Promise<unknown>,status=200) { try { return Response.json(await fn(),{status,headers}); } catch(e) {const mapped=toErrorBody(e);return Response.json(mapped.body,{status:mapped.status,headers});} }
 async function body(req:Request) {
  if (req.headers.get('origin') && req.headers.get('origin')!==new URL(req.url).origin) throw errors.forbidden();
  if (!req.headers.get('content-type')?.startsWith('application/json')) throw errors.invalidInput('JSON required');
  const reader=req.body?.getReader();const chunks:Uint8Array[]=[];let length=0;
  if(reader) {while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>4096){await reader.cancel();throw errors.invalidInput('Request too large');}chunks.push(part.value);}}
  const raw=Buffer.concat(chunks).toString('utf8');
  try { const value=JSON.parse(raw);if(!value || typeof value!=='object' || Array.isArray(value)) throw 0; return value as Record<string,unknown>; } catch { throw errors.invalidInput('Invalid JSON'); }
 }
 function field(b:Record<string,unknown>,key:string) { const v=b[key];if(typeof v!=='string'||!v.trim()||v.length>256)throw errors.invalidInput('Invalid '+key);return v.trim(); }
 async function actor(req:Request) {const a=await principal(req);if(!a)throw errors.unauthenticated();return a;}
 return {
  issue:(req:Request,groupId:string)=>run(async()=>{await body(req);return s.issue(await actor(req),groupId);},201),
  email:(req:Request)=>run(async()=>{const b=await body(req);await s.email(field(b,'qrToken'),field(b,'email'));return {sent:true};},202),
  redeem:(req:Request)=>run(async()=>{const b=await body(req);return s.redeem(field(b,'token'),field(b,'studentId'));}),
  revoke:(req:Request,groupId:string)=>run(async()=>{const b=await body(req);await s.revoke(await actor(req),groupId,field(b,'token'));return {revoked:true};}),
 };
}
let production: ActivationServices | undefined;
export function getActivationHandlers() {
 if(!production) {
  const secret=process.env.ACTIVATION_HMAC_SECRET??'';
  if(Buffer.byteLength(secret)<32) throw unavailable('Activation signing key is not configured');
  const services=getServices();const sqlite=openSqliteDatabase();
  migrate(drizzle(sqlite),{migrationsFolder:process.env.MIGRATIONS_FOLDER??resolve(process.cwd(),'drizzle')});
  // No SMTP transport exists in this repository yet. Fail closed rather than fake delivery.
  production=createActivationServices({sqlite,audit:services.audit,hmacSecret:secret,baseUrl:process.env.APP_BASE_URL??''});
 }
 return createActivationHandlers(production,req=>createAuthContext(getServices()).principal(req));
}
export async function activationRoute(run:(handlers:ReturnType<typeof createActivationHandlers>)=>Promise<Response>) {
 try{return await run(getActivationHandlers());}catch(e){const m=toErrorBody(e);return Response.json(m.body,{status:m.status,headers});}
}
