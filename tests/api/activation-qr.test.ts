import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createActivationServices, createActivationHandlers } from '../../src/server/activation-services';
import type { AuditEventId, SessionPrincipal, UserId } from '../../src/shared/contracts';
const handles: Database.Database[] = [];
afterEach(() => { handles.splice(0).forEach(db => db.close()); });
function fixture(options: { mail?: boolean; base?: string } = {}) {
 const db = new Database(':memory:'); handles.push(db); db.pragma('foreign_keys=ON'); migrate(drizzle(db), { migrationsFolder: 'drizzle' });
 db.exec(`INSERT INTO users(id,gitea_id,login,email,display_name) VALUES ('t',1,'teacher','t@jdu.uz','Teacher'),('s',2,'student','s@jdu.uz','Student'),('s2',3,'student2','s2@jdu.uz','Student2');
 INSERT INTO groups(id,code,name) VALUES ('g','G','Group'),('other','O','Other');
 INSERT INTO group_members(id,group_id,user_id) VALUES ('mt','g','t'),('ms','g','s'),('ms2','g','s2');
 INSERT INTO student_profiles(id,user_id,student_id,expected_email) VALUES ('p','s','S1','s@jdu.uz'),('p2','s2','S2','s2@jdu.uz');`);
 let time = 1000; const outbox: { to: string; url: string }[] = [];
 const services = createActivationServices({ sqlite: db, hmacSecret: 'a'.repeat(32), baseUrl: options.base ?? 'https://study.example.org', now: () => time,
 audit: { append: async () => 'audit' as AuditEventId }, mail: options.mail === false ? undefined : { send: async message => { outbox.push(message); } } });
 const teacher = { userId: 't' as UserId, login: 'teacher', displayName: 'Teacher', roles: ['teacher'] } satisfies SessionPrincipal;
 const handlers = createActivationHandlers(services, async req => req.headers.get('authorization') === 'teacher' ? teacher : null);
 return { db, services, handlers, outbox, advance: (ms: number) => { time += ms; } };
}
function request(body: unknown, teacher = false) { return new Request('https://study.example.org/api', { method: 'POST', headers: { 'content-type': 'application/json', ...(teacher ? { authorization: 'teacher' } : {}) }, body: JSON.stringify(body) }); }
describe('activation QR HTTP seam', () => {
 it('requires authenticated group-scoped teacher before issuing a local QR', async () => {
  const f = fixture();
  expect((await f.handlers.issue(request({}), 'g')).status).toBe(401);
  expect((await f.handlers.issue(request({}, true), 'other')).status).toBe(403);
  const issued = await f.handlers.issue(request({}, true), 'g'); expect(issued.status).toBe(201);
  const data = await issued.json(); expect(data.svg).toContain('<svg'); expect(data.url.startsWith('https://study.example.org/activate#qr=qr_')).toBe(true);
 });
});
async function invitation(f: ReturnType<typeof fixture>) {
 const data=await (await f.handlers.issue(request({},true),'g')).json();
 return { ...data, token:new URLSearchParams(new URL(data.url).hash.slice(1)).get('qr')! };
}
async function emailToken(f: ReturnType<typeof fixture>, qrToken:string,email='s@jdu.uz') {
 const response=await f.handlers.email(request({qrToken,email}));expect(response.status).toBe(202);
 expect(await response.json()).toEqual({sent:true});
 return new URLSearchParams(new URL(f.outbox.at(-1)!.url).hash.slice(1)).get('email')!;
}
describe('persistent activation HTTP flow',()=>{
 it('reuses group QR for multiple students but consumes each email only once and never creates session',async()=>{
  const f=fixture();const qr=await invitation(f);
  const token=await emailToken(f,qr.token);
  const results=await Promise.all([f.handlers.redeem(request({token,studentId:'S1'})),f.handlers.redeem(request({token,studentId:'S1'}))]);
  expect(results.map(r=>r.status).sort()).toEqual([200,409]);
  expect(await results.find(r=>r.status===200)!.json()).toEqual({activated:true,loginRequired:true});
  expect(results.every(r=>!r.headers.has('set-cookie'))).toBe(true);
  const second=await emailToken(f,qr.token,'s2@jdu.uz');
  expect((await f.handlers.redeem(request({token:second,studentId:'S2'}))).status).toBe(200);
  expect(JSON.stringify(f.db.prepare('SELECT * FROM activation_tokens').all())).not.toContain(qr.token);
  expect(f.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({n:0});
 });
 it('rejects wrong identity, unknown identity, revoked QR and expired email without activation',async()=>{
  const f=fixture();const qr=await invitation(f);const token=await emailToken(f,qr.token);
  for(const studentId of ['S2','unknown']) { const r=await f.handlers.redeem(request({token,studentId}));expect(r.status).toBe(409);expect(await r.json()).toEqual({error:{code:'CONFLICT',message:'Activation could not be completed'}}); }
  f.advance(15*60*1000);
  expect((await f.handlers.redeem(request({token,studentId:'S1'}))).status).toBe(409);
  const other=await emailToken(f,qr.token);
  expect((await f.handlers.revoke(request({token:qr.token},true),'g')).status).toBe(200);
  expect((await f.handlers.redeem(request({token:other,studentId:'S1'}))).status).toBe(409);
  expect((await f.handlers.email(request({qrToken:qr.token,email:'s2@jdu.uz'}))).status).toBe(409);
 });
 it('fails closed without SMTP, without any email token or outbox endpoint',async()=>{
  const f=fixture({mail:false});const qr=await invitation(f);const r=await f.handlers.email(request({qrToken:qr.token,email:'s@jdu.uz'}));
  expect(r.status).toBe(503);expect(await r.json()).toEqual({error:{code:'UNAVAILABLE',message:'Activation email delivery is not configured'}});
  expect(f.db.prepare("SELECT count(*) AS n FROM activation_tokens WHERE kind='email'").get()).toEqual({n:0});
 });
 it.each(['http://study.example.org','https://localhost','https://127.0.0.1','https://192.168.1.2','https://[::1]','https://user:pass@study.example.org','https://school.local'])('rejects nonpublic destination %s',async base=>{
  const f=fixture({base});expect((await f.handlers.issue(request({},true),'g')).status).toBe(503);
 });
 it('enforces durable issuance, email and redemption rate limits',async()=>{
  const f=fixture();const qr=await invitation(f);
  for(let i=0;i<5;i++)expect((await f.handlers.email(request({qrToken:qr.token,email:'s@jdu.uz'}))).status).toBe(202);
  expect((await f.handlers.email(request({qrToken:qr.token,email:'s@jdu.uz'}))).status).toBe(429);
  for(let i=0;i<10;i++)expect((await f.handlers.redeem(request({token:'bad',studentId:'S1'}))).status).toBe(409);
  expect((await f.handlers.redeem(request({token:'bad',studentId:'S1'}))).status).toBe(429);
  for(let i=1;i<20;i++)expect((await f.handlers.issue(request({},true),'g')).status).toBe(201);
  expect((await f.handlers.issue(request({},true),'g')).status).toBe(429);
  f.advance(60*60*1000+1);expect((await f.handlers.issue(request({},true),'g')).status).toBe(201);
 });
});
it('decodes the locally rendered QR matrix to its activation URL',async()=>{
 const { BinaryBitmap, HybridBinarizer, RGBLuminanceSource, QRCodeReader }=await import('@zxing/library');
 const f=fixture();const qr=await invitation(f);
 // Read qrcode's SVG path into an independent decoder (no encoder call in this test).
 const size=Number(qr.svg.match(/viewBox="0 0 ([0-9]+) /)![1]);
 const scale=8,width=size*scale;const pixels=new Uint8ClampedArray(width*width);pixels.fill(255);
 const path=qr.svg.match(/<path stroke="#000000" d="([^"]+)"/)![1];
 let x=0,y=0;
 for(const part of path.matchAll(/([MmHh])([^MmHh]*)/g)){
  const numbers=part[2].trim().split(/[ ,]+/).map(Number);
  if(part[1]==='M'){x=numbers[0];y=numbers[1];}
  else if(part[1]==='m'){x+=numbers[0];y+=numbers[1];}
  else {const end=part[1]==='h'?x+numbers[0]:numbers[0];for(let py=Math.floor(y)*scale;py<(Math.floor(y)+1)*scale;py++)for(let px=x*scale;px<end*scale;px++)pixels[py*width+px]=0;x=end;}
 }
 const bitmap=new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels,width,width)));
 expect(new QRCodeReader().decode(bitmap).getText()).toBe(qr.url);
});
it('rejects an expired shared QR before creating email tokens',async()=>{
 const f=fixture();const qr=await invitation(f);f.advance(24*60*60*1000);
 expect((await f.handlers.email(request({qrToken:qr.token,email:'s@jdu.uz'}))).status).toBe(409);
});
it('renders an actual activation form and never uses an external token image',async()=>{
 const React=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
 const {default:Page}=await import('../../src/app/activate/page');
 const html=renderToStaticMarkup(React.createElement(Page));
 expect(html).toContain('Activate student account');expect(html).toContain('Open the QR invitation');expect(html).not.toContain('<img');
});
