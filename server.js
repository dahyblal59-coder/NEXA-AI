import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initDb } from './db.js';
import { hashPassword, verifyPassword, signToken, verifyToken } from './security.js';
import { askAI } from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy:false}));
app.use(cors({origin: process.env.APP_ORIGIN ? process.env.APP_ORIGIN.split(',').map(x=>x.trim()) : 'http://localhost:3000'}));
app.use(express.json({limit:'1mb'}));
app.use('/api', rateLimit({windowMs:60_000,limit:90,standardHeaders:true,legacyHeaders:false}));
app.use(express.static(path.join(__dirname,'../public')));

const today = () => new Date().toISOString().slice(0,10);
const publicUser = u => ({id:u.id,email:u.email,tier:u.tier,premiumUntil:u.premium_until||null});
async function auth(req,res,next) {
  try {
    const token = (req.headers.authorization||'').replace(/^Bearer\s+/i,'');
    const payload = verifyToken(token);
    const result = await db.query('SELECT * FROM users WHERE id=$1',[payload.sub]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({error:'الحساب غير موجود.'});
    req.user = user; next();
  } catch { return res.status(401).json({error:'سجّل الدخول أولاً أو أعد تسجيل الدخول.'}); }
}
function tierGate(req,res,next) {
  const tier = String(req.body.tier || '4.1');
  if (!['4.1','6.2','8.4'].includes(tier)) return res.status(400).json({error:'مستوى غير صالح.'});
  if (tier === '6.2' && process.env.NEXA_62_ENABLED !== 'true') return res.status(403).json({error:'NEXA 6.2 غير مفعّل حالياً. راجع إعداد NEXA_62_ENABLED.'});
  if (tier === '8.4' && (!req.user.premium_until || new Date(req.user.premium_until) <= new Date())) return res.status(403).json({error:'NEXA 8.4 متاح لمشتركي Premium فقط.'});
  req.tier = tier; next();
}
async function enforceDailyLimit(req,res,next) {
  if (req.tier !== '6.2') return next();
  try {
    const result = await db.query('SELECT COUNT(*)::int AS n FROM usage WHERE user_id=$1 AND tier=$2 AND used_on=$3',[req.user.id,'6.2',today()]);
    const used = result.rows[0].n;
    if (used >= 10) return res.status(429).json({error:'وصلت إلى الحد اليومي: 10 رسائل لمستوى NEXA 6.2.',used,limit:10});
    req.dailyUsed = used; next();
  } catch { return res.status(500).json({error:'تعذر التحقق من الحصة اليومية.'}); }
}
async function recordUsage(req) {
  if (req.tier === '6.2') await db.query('INSERT INTO usage(user_id,tier,used_on) VALUES($1,$2,$3)',[req.user.id,'6.2',today()]);
}
const registerLimiter = rateLimit({windowMs:60*60*1000,limit:8,standardHeaders:true,legacyHeaders:false});

app.get('/api/health',async(req,res)=>{
  try { await db.query('SELECT 1'); res.json({ok:true,database:'connected',service:'NEXA AI API',version:'1.0.1',time:new Date().toISOString()}); }
  catch { res.status(503).json({ok:false,database:'disconnected',service:'NEXA AI API'}); }
});
app.post('/api/auth/register',registerLimiter,async(req,res)=>{
  const email=String(req.body.email||'').trim().toLowerCase(), password=String(req.body.password||'');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error:'بريد إلكتروني غير صحيح.'});
  if (password.length<8 || password.length>128) return res.status(400).json({error:'كلمة المرور يجب أن تكون من 8 إلى 128 حرفاً.'});
  try {
    const result=await db.query('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING *',[email,hashPassword(password)]);
    const user=result.rows[0];
    return res.status(201).json({token:signToken(user),user:publicUser(user)});
  } catch(e) {
    if(e.code==='23505') return res.status(409).json({error:'هذا البريد مسجل بالفعل.'});
    return res.status(500).json({error:'تعذر إنشاء الحساب. تحقق من إعداد قاعدة البيانات.'});
  }
});
app.post('/api/auth/login',registerLimiter,async(req,res)=>{
  const email=String(req.body.email||'').trim().toLowerCase(), password=String(req.body.password||'');
  try {
    const result=await db.query('SELECT * FROM users WHERE email=$1',[email]);
    const user=result.rows[0];
    if (!user || !verifyPassword(password,user.password_hash)) return res.status(401).json({error:'البريد أو كلمة المرور غير صحيحة.'});
    res.json({token:signToken(user),user:publicUser(user)});
  } catch { res.status(500).json({error:'تعذر تسجيل الدخول.'}); }
});
app.get('/api/auth/me',auth,(req,res)=>res.json({user:publicUser(req.user)}));

app.post('/api/chat',auth,tierGate,enforceDailyLimit,async(req,res)=>{
  const message=String(req.body.message||'').trim();
  if (!message || message.length>12000) return res.status(400).json({error:'اكتب رسالة من 1 إلى 12000 حرف.'});
  const history=Array.isArray(req.body.history)?req.body.history.slice(-16):[];
  const messages=[{role:'system',content:'أنت NEXA AI، مساعد مفيد ودقيق. أجب بلغة المستخدم، ولا تدّع تنفيذ أفعال لم تنفذها.'},
    ...history.filter(x=>['user','assistant'].includes(x?.role)&&typeof x?.text==='string').map(x=>({role:x.role,content:x.text.slice(0,6000)})),
    {role:'user',content:message}];
  try {
    const reply=await askAI({tier:req.tier,messages});
    await recordUsage(req);
    const used=req.tier==='6.2' ? (req.dailyUsed||0)+1 : undefined;
    res.json({reply,connected:true,...(used!==undefined?{usage:{used,limit:10,remaining:10-used}}:{})});
  } catch(e) { res.status(e.status||500).json({error:e.message||'حدث خطأ في خدمة الذكاء الاصطناعي.'}); }
});
app.post('/api/agent',auth,async(req,res)=>{
  const prompt=String(req.body.prompt||'').trim();
  if (!prompt || prompt.length>8000) return res.status(400).json({error:'اكتب وصفاً للمهمة.'});
  try {
    const plan=await askAI({tier:'4.1',messages:[
      {role:'system',content:'أنت NEXA Super Agent. حلل الطلب وأخرج خطة تنفيذ عملية واضحة. لا تزعم أنك أنشأت ملفات أو نفذت إجراءات خارجية.'},
      {role:'user',content:prompt}
    ]});
    res.json({plan,status:'plan_ready'});
  } catch(e) { res.status(e.status||500).json({error:e.message}); }
});
app.post('/api/app',auth,async(req,res)=>{
  const prompt=String(req.body.prompt||'').trim();
  if (!prompt) return res.status(400).json({error:'اكتب وصف التطبيق.'});
  try { const plan=await askAI({tier:'4.1',messages:[{role:'system',content:'اكتب مواصفات وخطة بناء تطبيق مفصلة، لا تدّع توليد ملفات أو APK.'},{role:'user',content:prompt}]}); res.json({message:'تم إنشاء خطة أولية فقط؛ البناء والتصدير غير مفعّلين بعد.',plan}); }
  catch(e){res.status(e.status||500).json({error:e.message});}
});
app.post('/api/website',auth,async(req,res)=>{
  const prompt=String(req.body.prompt||'').trim();
  if (!prompt) return res.status(400).json({error:'اكتب وصف الموقع.'});
  try { const plan=await askAI({tier:'4.1',messages:[{role:'system',content:'اكتب مخطط موقع واضحاً مع الصفحات والوظائف والمكونات. لا تدّع إنشاء ملفات فعلية.'},{role:'user',content:prompt}]}); res.json({message:'تم إعداد مخطط أولي، وليس موقعاً منشوراً.',plan}); }
  catch(e){res.status(e.status||500).json({error:e.message});}
});
for (const route of ['/api/image','/api/video']) app.post(route,auth,(req,res)=>res.status(501).json({error:'هذه الميزة تحتاج ربط مزود متخصص. لم يتم تفعيلها بعد.'}));

app.post('/api/admin/grant-premium',async(req,res)=>{
  const key=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  if (!process.env.ADMIN_API_KEY || key!==process.env.ADMIN_API_KEY) return res.status(401).json({error:'غير مصرح.'});
  const email=String(req.body.email||'').trim().toLowerCase();
  const days=Math.min(3650,Math.max(1,Number(req.body.days)||30));
  try {
    const result=await db.query('SELECT * FROM users WHERE email=$1',[email]);
    const user=result.rows[0];
    if(!user) return res.status(404).json({error:'المستخدم غير موجود.'});
    const until=new Date(Date.now()+days*86400000).toISOString();
    await db.query("UPDATE users SET premium_until=$1,tier='8.4' WHERE id=$2",[until,user.id]);
    res.json({ok:true,email,premiumUntil:until});
  } catch { res.status(500).json({error:'تعذر تحديث الاشتراك.'}); }
});
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'خطأ داخلي غير متوقع.'});});

const port=Number(process.env.PORT||3000);
initDb().then(()=>{
  app.listen(port,'0.0.0.0',()=>console.log(`NEXA AI server listening on port ${port}`));
}).catch(err=>{
  console.error('Database initialization failed:',err.message);
  process.exit(1);
});
