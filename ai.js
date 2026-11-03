export async function askAI({tier='4.1',messages=[]}) {
  const apiKey = process.env.AI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL || 'https://api.openai.com/v1/chat/completions';
  const model = process.env[`NEXA_MODEL_${tier.replace('.','')}`];
  if (!apiKey) throw Object.assign(new Error('خدمة الذكاء الاصطناعي غير مربوطة بعد. أضف AI_API_KEY في ملف .env على السيرفر.'),{status:503});
  if (!model) throw Object.assign(new Error(`لم يتم تحديد موديل المستوى NEXA ${tier}. أضف NEXA_MODEL_${tier.replace('.','')} في .env.`),{status:503});
  const response = await fetch(baseUrl, {
    method:'POST',
    headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
    body:JSON.stringify({model,messages,temperature:0.7})
  });
  const data = await response.json().catch(()=>({}));
  if (!response.ok) throw Object.assign(new Error(data.error?.message || `AI provider error ${response.status}`),{status:502});
  const reply = data.choices?.[0]?.message?.content;
  if (typeof reply !== 'string' || !reply.trim()) throw Object.assign(new Error('مزود الذكاء الاصطناعي لم يرجع إجابة نصية.'),{status:502});
  return reply;
}
