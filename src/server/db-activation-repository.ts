import type Database from 'better-sqlite3';
import type { ActivationRepository, ActivationTokenRecord, CompleteActivationInput, StudentActivationRecord } from '../domain/activation';
import type { SessionPrincipal } from '../shared/contracts';
export class DbActivationRepository implements ActivationRepository {
 constructor(private readonly db: Database.Database) {}
 async insertToken(t: ActivationTokenRecord): Promise<void> {
  this.db.prepare('INSERT INTO activation_tokens(token_hmac,kind,group_id,email,qr_token_hmac,expires_at,used_at,revoked_at) VALUES (?,?,?,?,?,?,?,?)').run(t.tokenHmac,t.kind,t.groupId,t.email,t.qrTokenHmac,t.expiresAt,t.usedAt,t.revokedAt);
 }
 async findToken(hash: string): Promise<ActivationTokenRecord | null> {
  return this.db.prepare('SELECT token_hmac AS tokenHmac,kind,group_id AS groupId,email,qr_token_hmac AS qrTokenHmac,expires_at AS expiresAt,used_at AS usedAt,revoked_at AS revokedAt FROM activation_tokens WHERE token_hmac=?').get(hash) as ActivationTokenRecord ?? null;
 }
 async revokeToken(hash: string, now: number): Promise<void> { this.db.prepare('UPDATE activation_tokens SET revoked_at=? WHERE token_hmac=?').run(now,hash); }
 async findStudent(studentId: string): Promise<StudentActivationRecord | null> {
  const rows = this.db.prepare("SELECT p.student_id AS studentId,p.user_id AS userId,m.group_id AS groupId,p.expected_email AS expectedEmail,p.activation_state AS activationState FROM student_profiles p JOIN group_members m ON m.user_id=p.user_id AND m.state='active' WHERE p.student_id=?").all(studentId) as StudentActivationRecord[];
  return rows.length === 1 ? rows[0]! : null;
 }
 async activate(i: CompleteActivationInput): Promise<boolean> {
  return this.db.transaction(() => {
   const email = this.db.prepare("SELECT group_id FROM activation_tokens WHERE token_hmac=? AND kind='email' AND qr_token_hmac=? AND email=? AND expires_at>? AND revoked_at IS NULL AND used_at IS NULL").get(i.tokenHmac,i.qrTokenHmac,i.email,i.now) as { group_id: string } | undefined;
   if (!email) return false;
   if (!this.db.prepare("SELECT 1 FROM activation_tokens WHERE token_hmac=? AND kind='qr' AND group_id=? AND expires_at>? AND revoked_at IS NULL AND used_at IS NULL").get(i.qrTokenHmac,email.group_id,i.now)) return false;
   const student = this.db.prepare("SELECT p.id FROM student_profiles p JOIN users u ON u.id=p.user_id WHERE p.student_id=? AND lower(trim(p.expected_email))=? AND p.activation_state='pending' AND u.gitea_id>0 AND EXISTS(SELECT 1 FROM group_members m WHERE m.user_id=p.user_id AND m.group_id=? AND m.state='active')").get(i.studentId,i.email,email.group_id) as {id:string} | undefined;
   if (!student) return false;
   this.db.prepare("UPDATE student_profiles SET activation_state='active',updated_at=? WHERE id=?").run(i.now,student.id);
   this.db.prepare('UPDATE activation_tokens SET used_at=? WHERE token_hmac=?').run(i.now,i.tokenHmac);
   return true;
  }).immediate();
 }
 canIssue(actor: SessionPrincipal, groupId: string): boolean {
  if (!this.db.prepare('SELECT 1 FROM groups WHERE id=?').get(groupId)) return false;
  if (actor.roles.some(role => role === 'admin' || role === 'owner')) return true;
  return actor.roles.includes('teacher') && !!this.db.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=? AND state='active'").get(groupId,actor.userId);
 }
 takeRateLimit(hash: string, now: number, limit: number, windowMs: number): boolean {
  return this.db.transaction(() => {
   this.db.prepare('DELETE FROM activation_rate_limits WHERE window_start<?').run(now-windowMs);
   this.db.prepare('INSERT INTO activation_rate_limits(key_hash,window_start,attempts) VALUES (?,?,1) ON CONFLICT(key_hash) DO UPDATE SET attempts=attempts+1').run(hash,now);
   return (this.db.prepare('SELECT attempts FROM activation_rate_limits WHERE key_hash=?').get(hash) as {attempts:number}).attempts <= limit;
  }).immediate();
 }
}
