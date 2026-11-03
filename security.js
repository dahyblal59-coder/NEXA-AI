import crypto from 'node:crypto';

const b64 = (v) => Buffer.from(v).toString('base64url');
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
export function verifyPassword(password, stored) {
  const [salt, expected] = String(stored).split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const target = Buffer.from(expected, 'hex');
  return target.length === actual.length && crypto.timingSafeEqual(actual, target);
}
export function signToken(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  const head = b64(JSON.stringify({alg:'HS256',typ:'JWT'}));
  const payload = b64(JSON.stringify({sub:user.id,email:user.email,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+60*60*24*7}));
  const input = `${head}.${payload}`;
  const sig = crypto.createHmac('sha256',secret).update(input).digest('base64url');
  return `${input}.${sig}`;
}
export function verifyToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('Server authentication is not configured');
  const [head,payload,sig] = String(token||'').split('.');
  if (!head || !payload || !sig) throw new Error('Invalid token');
  const expected = crypto.createHmac('sha256',secret).update(`${head}.${payload}`).digest();
  const actual = Buffer.from(sig,'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual,expected)) throw new Error('Invalid token');
  const data = JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
  if (!data.exp || data.exp < Math.floor(Date.now()/1000)) throw new Error('Session expired');
  return data;
}
