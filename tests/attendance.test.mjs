import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../server/worker.mjs';
import { hashPassword, tokenHash, randomToken, verifySchoolIdentity } from '../server/security.mjs';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  sqlite.exec(readFileSync(new URL('../migrations/0001_attendance.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_login_nonces.sql',import.meta.url),'utf8'));
  const wrap = (sql, args=[]) => ({
    bind: (...values) => wrap(sql,values),
    first: async () => sqlite.prepare(sql).get(...args) || null,
    all: async () => ({results:sqlite.prepare(sql).all(...args)}),
    run: async () => ({meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}}),
    sql,args,
  });
  return {sqlite,prepare:wrap,batch: async statements => {
    sqlite.exec('BEGIN');
    try { const results = statements.map(s => {
      const query=sqlite.prepare(s.sql);
      return /^\s*SELECT/i.test(s.sql) ? {results:query.all(...s.args)} : {meta:{changes:Number(query.run(...s.args).changes)}};
    }); sqlite.exec('COMMIT'); return results;
    } catch(error) {sqlite.exec('ROLLBACK');throw error;}
  }};
}
async function setup() {
  const DB=database();
  const env={DB,ADMIN_USERNAME:'tcsshcsc',ADMIN_PASSWORD_HASH:await hashPassword('test-password-only'), GOOGLE_CLIENT_ID:'test.apps.googleusercontent.com'};
  async function call(path,body,cookie='') {
    return worker.fetch(new Request('https://attendance.test'+path, {method:body===undefined?'GET':'POST',headers:{cookie,origin:'https://attendance.test','x-requested-with':'attendance','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),env,{});
  }
  async function auth(role,user='student-1',email='test@stu.tcssh.tc.edu.tw') {
    const token=randomToken(); await DB.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').bind(await tokenHash(token),role,user,email,Date.now()+60000).run();
    return `attendance_${role}=${token}`;
  }
  return {DB,env,call,auth};
}
test('public state has exactly two 6×8 rooms and never exposes student information',async()=>{
  const {call,auth}=await setup();const student=await auth('student');
  assert.equal((await call('/api/checkin',{roundId:1,room:'A',seat:1,className:'103',studentNumber:1},student)).status,200);
  const response=await call('/api/state');const body=await response.json();
  assert.equal(body.seats.length,96);assert.equal(body.seats.filter(s=>s.room==='A').length,48);assert.equal(body.seats[0].occupied,true);
  assert.ok(!JSON.stringify(body).includes('test@stu.tcssh.tc.edu.tw'));assert.ok(!('checkins' in body));
});
test('anonymous, forged Google tokens, wrong admin passwords and cross-origin writes are denied',async()=>{
  const {call,env}=await setup();
  assert.equal((await call('/api/checkin',{room:'A',seat:1})).status,401);
  assert.equal((await call('/api/admin/state')).status,401);
  assert.equal((await call('/api/admin/login',{username:'tcsshcsc',password:'wrong'})).status,401);
  assert.equal((await call('/api/auth/google',{credential:'forged'},'attendance_nonce='+randomToken())).status,401);
  const response=await worker.fetch(new Request('https://attendance.test/api/admin/login',{method:'POST',headers:{origin:'https://evil.test'},body:'{}'}),env,{});
  assert.equal(response.status,403);
});
test('one account across both rooms, one student identity and one occupant per seat',async()=>{
  const {call,auth}=await setup();const a=await auth('student','a'),b=await auth('student','b');
  const first={roundId:1,room:'A',seat:2,className:'103',studentNumber:2};
  const race=await Promise.all([call('/api/checkin',first,a),call('/api/checkin',{...first,className:'104'},b)]);
  assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
  assert.equal((await call('/api/checkin',{...first,room:'B',seat:3},a)).status,409);
  assert.equal((await call('/api/checkin',{...first,room:'B',seat:3},b)).status,409);
  assert.equal((await call('/api/checkin',{...first,seat:49},b)).status,400);
});
test('admin can disable/enable seats; occupied seats cannot be disabled',async()=>{
  const {call,auth}=await setup();const admin=await auth('admin'),student=await auth('student');
  assert.equal((await call('/api/admin/seat',{room:'B',seat:8,blocked:true},student)).status,401);
  assert.equal((await call('/api/admin/seat',{room:'B',seat:8,blocked:true},admin)).status,200);
  const checkin={roundId:1,room:'B',seat:8,className:'103',studentNumber:8};
  assert.equal((await call('/api/checkin',checkin,student)).status,409);
  assert.equal((await call('/api/admin/seat',{room:'B',seat:8,blocked:false},admin)).status,200);
  assert.equal((await call('/api/checkin',checkin,student)).status,200);
  assert.equal((await call('/api/admin/seat',{room:'B',seat:8,blocked:true},admin)).status,409);
});
test('reset deletes attendance and retains only current state and blocked seats',async()=>{
  const {call,auth,DB}=await setup();const admin=await auth('admin'),student=await auth('student');
  await call('/api/checkin',{roundId:1,room:'A',seat:1,className:'103',studentNumber:1},student);
  await call('/api/admin/seat',{room:'B',seat:48,blocked:true},admin);
  assert.equal((await call('/api/admin/round',{roundId:1},admin)).status,200);
  assert.equal((await call('/api/admin/round',{roundId:1},admin)).status,409);
  assert.equal((await call('/api/checkin',{roundId:1,room:'A',seat:2,className:'103',studentNumber:1},student)).status,409);
  const state=await (await call('/api/state')).json();assert.equal(state.round.id,2);assert.ok(state.seats.every(s=>!s.occupied));assert.equal(state.seats.at(-1).blocked,true);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM checkins').get().n,0);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM rounds').get().n,1);
  assert.equal((await call('/api/admin/history',undefined,admin)).status,404);
  assert.equal((await call('/api/admin/export?round=1',undefined,admin)).status,404);
  assert.equal((await call('/api/checkin',{roundId:2,room:'B',seat:1,className:'103',studentNumber:1},student)).status,200);
  assert.equal((await call('/api/admin/round',{roundId:2},admin)).status,200);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM checkins').get().n,0);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM rounds').get().n,1);
});
test('admin login sets HttpOnly session; logout revokes it',async()=>{
  const {call}=await setup();const response=await call('/api/admin/login',{username:'tcsshcsc',password:'test-password-only'});
  assert.equal(response.status,200);const cookie=response.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);
  const token=cookie.split(';')[0];assert.equal((await call('/api/admin/state',undefined,token)).status,200);
  assert.equal((await call('/api/admin/logout',{},token)).status,200);assert.equal((await call('/api/admin/state',undefined,token)).status,401);
});
test('expired sessions and rapid password guesses are rejected',async()=>{
  const {call,auth,DB}=await setup();const token=await auth('admin');await DB.prepare('UPDATE sessions SET expires_at=0').run();
  assert.equal((await call('/api/admin/state',undefined,token)).status,401);
  for(let i=0;i<20;i++) await call('/api/admin/login',{username:'no',password:'no'});
  assert.equal((await call('/api/admin/login',{username:'no',password:'no'})).status,429);
});
test('only verified Google Workspace student identities are accepted',async()=>{
  const valid={email:'student@stu.tcssh.tc.edu.tw',email_verified:true,hd:'stu.tcssh.tc.edu.tw'};
  assert.equal(verifySchoolIdentity(valid),true);
  for(const email of ['student@gmail.com','student@stu.tcssh.tc.edu.tw.evil.com','student@evil-stu.tcssh.tc.edu.tw','@stu.tcssh.tc.edu.tw']) assert.equal(verifySchoolIdentity({...valid,email}),false);
  assert.equal(verifySchoolIdentity({...valid,email_verified:false}),false);
  assert.equal(verifySchoolIdentity({...valid,hd:undefined}),false);
  const {call,auth}=await setup();const oldPersonalSession=await auth('student','personal','personal@gmail.com');
  assert.equal((await call('/api/me',undefined,oldPersonalSession)).status,403);
  assert.equal((await call('/api/checkin',{roundId:1,room:'A',seat:1,className:'103',studentNumber:1},oldPersonalSession)).status,403);
});


test('GitHub Pages CORS and bearer sessions enforce admin-only reset',async()=>{
  const {env,auth,DB}=await setup();
  const origin='https://tcsshcsc.github.io';
  const request=(path,body,token,source=origin)=>worker.fetch(new Request('https://attendance.test'+path,{method:body===undefined?'GET':'POST',headers:{origin:source,'Content-Type':'application/json','X-Requested-With':'attendance',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)}),env,{});
  const preflight=await worker.fetch(new Request('https://attendance.test/api/admin/state',{method:'OPTIONS',headers:{origin}}),env,{});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),origin);
  const login=await request('/api/admin/login',{username:'tcsshcsc',password:'test-password-only'});const {token}=await login.json();assert.ok(token);
  assert.equal((await request('/api/admin/state',undefined,token)).status,200);
  const student=(await auth('student')).split('=')[1];
  assert.equal((await request('/api/admin/round',{roundId:1},student)).status,401);
  assert.equal((await request('/api/admin/round',{roundId:1})).status,401);
  assert.equal((await request('/api/admin/round',{roundId:1},token,'https://evil.test')).status,403);
  assert.equal((await request('/api/admin/round',{roundId:1},token)).status,200);
  assert.equal((await request('/api/admin/logout',{},token)).status,200);
  assert.equal((await request('/api/admin/state',undefined,token)).status,401);
  const nonce=await request('/api/auth/nonce');assert.match((await nonce.json()).nonce,/^[a-f0-9]{64}$/);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM login_nonces').get().n,1);
});


test('class must be three digits and school seat number must be 1 to 99',async()=>{
 const {call,auth}=await setup();const student=await auth('student');
 const body={roundId:1,room:'A',seat:1,className:'212',studentNumber:2};
 for(const className of ['二年十二班','21','2121','2A2']) assert.equal((await call('/api/checkin',{...body,className},student)).status,400);
 for(const studentNumber of [0,100,1.5,'02']) assert.equal((await call('/api/checkin',{...body,studentNumber},student)).status,400);
 assert.equal((await call('/api/checkin',body,student)).status,200);
 const me=await (await call('/api/me',undefined,student)).json();assert.equal(me.checkin.class_name,'212');assert.equal(me.checkin.student_number,2);
});
