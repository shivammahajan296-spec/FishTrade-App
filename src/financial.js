import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const j = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}
});
const fail = (message, status = 400) => j({error:message}, status);
const isoDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const paise = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const id = prefix => `${prefix}-${crypto.randomUUID()}`;
const parseJson = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const invoiceStatuses = new Set(['draft','finalized','partially_paid','paid','corrected','void']);

function invoiceAmount(items, transportationPaise, taxPaise) {
  let subtotal = 0;
  const normalized = items.map((row, position) => {
    const quantityGrams = Number(row.quantity_grams);
    const ratePaise = Number(row.rate_paise_per_kg);
    if (!Number.isSafeInteger(quantityGrams) || quantityGrams <= 0 || !Number.isSafeInteger(ratePaise) || ratePaise < 0) {
      throw new Error(`Invalid quantity or rate on item ${position + 1}`);
    }
    const amountPaise = Math.round(quantityGrams * ratePaise / 1000);
    subtotal += amountPaise;
    return {
      id: text(row.id, 100) || id('item'),
      position,
      item_code:text(row.item_code, 30),
      description:text(row.description, 240),
      quantity_grams:quantityGrams,
      rate_paise_per_kg:ratePaise,
      amount_paise:amountPaise
    };
  });
  if (!normalized.length || normalized.some(row => !row.description)) throw new Error('Add at least one described invoice item');
  return {items:normalized, subtotal_paise:subtotal, total_paise:subtotal + transportationPaise + taxPaise};
}

async function config(env) {
  const rows = await env.DB.prepare('SELECT key, value FROM app_config').all();
  return Object.fromEntries((rows.results || []).map(row => [row.key, parseJson(row.value,{})]));
}

async function nextInvoiceNumber(env) {
  const cfg = await config(env);
  const prefix = text(cfg.invoice?.prefix || new Date().getUTCFullYear(), 20);
  const floor = Number(cfg.invoice?.nextSequence || 1);
  const rows = await env.DB.prepare('SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY invoice_number DESC LIMIT 100').bind(prefix + '%').all();
  let highest = floor - 1;
  for (const row of rows.results || []) {
    const suffix = Number(String(row.invoice_number).slice(prefix.length));
    if (Number.isInteger(suffix)) highest = Math.max(highest, suffix);
  }
  return prefix + String(highest + 1).padStart(4,'0');
}

async function readLegacyPurchases(env) {
  const row = await env.DB.prepare('SELECT data FROM ledger WHERE id=1').first();
  const purchases = parseJson(row?.data,{}).purchases || [];
  return purchases.map(p => ({
    id:String(p.id), date:String(p.date || ''), supplier:String(p.supplier || ''), bill:String(p.bill || ''),
    amount_paise:Math.round(Number(p.amount || 0) * 100), status:String(p.status || ''), notes:String(p.notes || '')
  }));
}

async function bootstrap(env) {
  const [cfg, partiesResult, codesResult, invoicesResult, itemsResult, paymentsResult, allocationsResult, adjustmentsResult, eventRow, legacyPurchases] = await Promise.all([
    config(env),
    env.DB.prepare('SELECT * FROM parties WHERE active=1 ORDER BY type, name').all(),
    env.DB.prepare('SELECT * FROM item_codes WHERE active=1 ORDER BY code').all(),
    env.DB.prepare(`SELECT i.*, p.name party_name, p.address party_address, p.tax_id party_tax_id, p.state_code party_state_code,
      COALESCE((SELECT SUM(a.amount_paise) FROM payment_allocations a WHERE a.target_type='invoice' AND a.target_id=i.id),0) allocated_paise
      FROM invoices i JOIN parties p ON p.id=i.party_id ORDER BY i.invoice_date DESC, i.created_at DESC`).all(),
    env.DB.prepare('SELECT * FROM invoice_items ORDER BY invoice_id, position').all(),
    env.DB.prepare('SELECT py.*, p.name party_name FROM payments py JOIN parties p ON p.id=py.party_id ORDER BY py.payment_date DESC, py.created_at DESC').all(),
    env.DB.prepare('SELECT * FROM payment_allocations ORDER BY created_at').all(),
    env.DB.prepare('SELECT a.*, p.name party_name FROM ledger_adjustments a JOIN parties p ON p.id=a.party_id ORDER BY adjustment_date DESC').all(),
    env.DB.prepare('SELECT COALESCE(MAX(sequence),0) sequence FROM financial_events').first(),
    readLegacyPurchases(env)
  ]);
  const invoices = invoicesResult.results || [];
  const byInvoice = new Map();
  for (const row of itemsResult.results || []) {
    if (!byInvoice.has(row.invoice_id)) byInvoice.set(row.invoice_id, []);
    byInvoice.get(row.invoice_id).push(row);
  }
  for (const inv of invoices) inv.items = byInvoice.get(inv.id) || [];
  const payments = paymentsResult.results || [];
  const allocations = allocationsResult.results || [];
  const allocatedByPayment = new Map();
  for (const a of allocations) allocatedByPayment.set(a.payment_id,(allocatedByPayment.get(a.payment_id)||0)+a.amount_paise);
  for (const p of payments) p.unapplied_paise = p.amount_paise - (allocatedByPayment.get(p.id)||0);
  const parties = partiesResult.results || [];
  const adjustments = adjustmentsResult.results || [];
  const finalized = invoices.filter(x => !['draft','void','corrected'].includes(x.status));
  const received = payments.filter(x=>x.direction==='received').reduce((n,x)=>n+x.amount_paise,0);
  const made = payments.filter(x=>x.direction==='made').reduce((n,x)=>n+x.amount_paise,0);
  const customerOpening = parties.filter(x=>x.type==='customer').reduce((n,x)=>n+x.opening_balance_paise,0);
  const supplierOpening = parties.filter(x=>x.type==='supplier').reduce((n,x)=>n+x.opening_balance_paise,0);
  const receivableCredits = adjustments.filter(x=>x.direction==='receivable_credit').reduce((n,x)=>n+x.amount_paise,0);
  const payableCredits = adjustments.filter(x=>x.direction==='payable_credit').reduce((n,x)=>n+x.amount_paise,0);
  const invoiceSales = finalized.reduce((n,x)=>n+x.total_paise,0);
  const creditPurchases = legacyPurchases.filter(x=>!['cancelled','on_hold'].includes(x.status)).reduce((n,x)=>n+x.amount_paise,0);
  const today = new Date().toISOString().slice(0,10);
  const overdue = finalized.filter(x=>x.due_date && x.due_date < today && x.total_paise > x.allocated_paise);
  return {
    config:cfg, parties, item_codes:codesResult.results || [], invoices, payments, allocations, adjustments, legacy_purchases:legacyPurchases,
    next_invoice_number:await nextInvoiceNumber(env), event_sequence:eventRow?.sequence || 0,
    summary:{
      total_receivables_paise:customerOpening + invoiceSales - received - receivableCredits,
      total_payables_paise:supplierOpening + creditPurchases - made - payableCredits,
      net_outstanding_paise:(customerOpening + invoiceSales - received - receivableCredits) - (supplierOpening + creditPurchases - made - payableCredits),
      payments_received_paise:received, payments_made_paise:made, overdue_invoices:overdue.length
    }
  };
}

async function saveInvoice(request, env, invoiceId = null) {
  const body = await request.json().catch(()=>null);
  if (!body) return fail('Invalid invoice data');
  const invoiceNumber = text(body.invoice_number, 60);
  const partyId = text(body.party_id, 100);
  const invoiceDate = text(body.invoice_date, 10);
  const dueDate = text(body.due_date, 10);
  const transportation = paise(body.transportation_paise);
  const tax = paise(body.tax_paise ?? 0);
  if (!invoiceNumber || !partyId || !isoDate(invoiceDate) || (dueDate && !isoDate(dueDate)) || transportation === null || tax === null) return fail('Invoice number, party, date and valid totals are required');
  const party = await env.DB.prepare("SELECT id FROM parties WHERE id=? AND type='customer' AND active=1").bind(partyId).first();
  if (!party) return fail('Choose a valid customer');
  let calculated;
  try { calculated = invoiceAmount(Array.isArray(body.items)?body.items:[], transportation, tax); }
  catch (e) { return fail(e.message); }
  const nowId = invoiceId || id('invoice');
  if (invoiceId) {
    const current = await env.DB.prepare('SELECT status, version FROM invoices WHERE id=?').bind(invoiceId).first();
    if (!current) return fail('Invoice not found',404);
    if (current.status !== 'draft') return fail('Finalized financial values are locked. Create a controlled correction instead.',409);
    if (!Number.isInteger(body.version) || body.version !== current.version) return fail('Invoice changed on another device. Refresh and try again.',409);
  }
  const legacy = parseJson((await env.DB.prepare('SELECT data FROM ledger WHERE id=1').first())?.data,{});
  const matchingLegacySale = (legacy.sales || []).find(s => String(s.number).toLowerCase() === invoiceNumber.toLowerCase());
  const invoiceStmt = invoiceId
    ? env.DB.prepare(`UPDATE invoices SET invoice_number=?,party_id=?,invoice_date=?,due_date=?,place_of_supply=?,tax_mode=?,transportation_paise=?,subtotal_paise=?,tax_paise=?,total_paise=?,description=?,terms=?,legacy_sale_id=?,version=version+1,updated_at=datetime('now') WHERE id=?`).bind(invoiceNumber,partyId,invoiceDate,dueDate||null,text(body.place_of_supply,120),body.tax_mode==='manual'?'manual':'none',transportation,calculated.subtotal_paise,tax,calculated.total_paise,text(body.description,3000),text(body.terms,3000),matchingLegacySale?.id||null,invoiceId)
    : env.DB.prepare(`INSERT INTO invoices (id,invoice_number,party_id,invoice_date,due_date,place_of_supply,tax_mode,transportation_paise,subtotal_paise,tax_paise,total_paise,description,terms,legacy_sale_id,correction_of_invoice_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(nowId,invoiceNumber,partyId,invoiceDate,dueDate||null,text(body.place_of_supply,120),body.tax_mode==='manual'?'manual':'none',transportation,calculated.subtotal_paise,tax,calculated.total_paise,text(body.description,3000),text(body.terms,3000),matchingLegacySale?.id||null,text(body.correction_of_invoice_id,100)||null);
  const statements = [invoiceStmt];
  if (invoiceId) statements.push(env.DB.prepare('DELETE FROM invoice_items WHERE invoice_id=?').bind(invoiceId));
  for (const row of calculated.items) statements.push(env.DB.prepare('INSERT INTO invoice_items (id,invoice_id,position,item_code,description,quantity_grams,rate_paise_per_kg,amount_paise) VALUES (?,?,?,?,?,?,?,?)').bind(row.id,nowId,row.position,row.item_code,row.description,row.quantity_grams,row.rate_paise_per_kg,row.amount_paise));
  statements.push(env.DB.prepare("INSERT INTO financial_events (entity_type,entity_id,action) VALUES ('invoice',?,?)").bind(nowId,invoiceId?'updated':'created'));
  try { await env.DB.batch(statements); }
  catch (e) { if (/UNIQUE/i.test(String(e))) return fail('Invoice number already exists',409); throw e; }
  return j({ok:true,id:nowId,total_paise:calculated.total_paise},invoiceId?200:201);
}

async function finalizeInvoice(invoiceId, env) {
  const inv = await env.DB.prepare('SELECT * FROM invoices WHERE id=?').bind(invoiceId).first();
  if (!inv) return fail('Invoice not found',404);
  if (inv.status !== 'draft') return fail('Only a draft invoice can be finalized',409);
  if (inv.total_paise <= 0) return fail('Invoice total must be greater than zero');
  const statements=[
    env.DB.prepare("UPDATE invoices SET status='finalized',finalized_at=datetime('now'),version=version+1,updated_at=datetime('now') WHERE id=? AND status='draft'").bind(invoiceId),
    env.DB.prepare("INSERT INTO financial_events (entity_type,entity_id,action) VALUES ('invoice',?,'finalized')").bind(invoiceId)
  ];
  if(inv.correction_of_invoice_id)statements.push(env.DB.prepare("UPDATE invoices SET status='corrected',updated_at=datetime('now') WHERE id=? AND status IN ('finalized','partially_paid')").bind(inv.correction_of_invoice_id));
  await env.DB.batch(statements);
  return j({ok:true});
}

async function correctionInvoice(invoiceId, env) {
  const inv = await env.DB.prepare("SELECT * FROM invoices WHERE id=? AND status<>'draft'").bind(invoiceId).first();
  if (!inv) return fail('Finalized invoice not found',404);
  const allocated=await env.DB.prepare("SELECT COALESCE(SUM(amount_paise),0) paid FROM payment_allocations WHERE target_type='invoice' AND target_id=?").bind(invoiceId).first();
  if(allocated?.paid>0)return fail('This invoice has allocated payments. Reverse or reallocate those payments before creating a correction.',409);
  const items = await env.DB.prepare('SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY position').bind(invoiceId).all();
  const newId = id('invoice');
  const number = await nextInvoiceNumber(env);
  const statements = [env.DB.prepare(`INSERT INTO invoices (id,invoice_number,party_id,invoice_date,due_date,place_of_supply,status,tax_mode,transportation_paise,subtotal_paise,tax_paise,total_paise,description,terms,correction_of_invoice_id) VALUES (?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?)`).bind(newId,number,inv.party_id,new Date().toISOString().slice(0,10),inv.due_date,inv.place_of_supply,inv.tax_mode,inv.transportation_paise,inv.subtotal_paise,inv.tax_paise,inv.total_paise,inv.description,inv.terms,invoiceId)];
  for (const row of items.results || []) statements.push(env.DB.prepare('INSERT INTO invoice_items (id,invoice_id,position,item_code,description,quantity_grams,rate_paise_per_kg,amount_paise) VALUES (?,?,?,?,?,?,?,?)').bind(id('item'),newId,row.position,row.item_code,row.description,row.quantity_grams,row.rate_paise_per_kg,row.amount_paise));
  statements.push(env.DB.prepare("INSERT INTO financial_events (entity_type,entity_id,action) VALUES ('invoice',?,'correction_created')").bind(newId));
  await env.DB.batch(statements);
  return j({ok:true,id:newId,invoice_number:number},201);
}

async function deleteInvoice(invoiceId, env) {
  const inv=await env.DB.prepare('SELECT status, correction_of_invoice_id FROM invoices WHERE id=?').bind(invoiceId).first();
  if(!inv)return fail('Invoice not found',404);
  if(!['draft','finalized','void'].includes(inv.status))return fail('Only drafts, correction drafts, void invoices, and unpaid finalized invoices can be deleted.',409);
  const allocated=await env.DB.prepare("SELECT COALESCE(SUM(amount_paise),0) paid FROM payment_allocations WHERE target_type='invoice' AND target_id=?").bind(invoiceId).first();
  if(allocated?.paid>0)return fail('This invoice has an allocated payment. Reallocate or reverse the payment before deleting the invoice.',409);
  const correction=await env.DB.prepare('SELECT id FROM invoices WHERE correction_of_invoice_id=? LIMIT 1').bind(invoiceId).first();
  if(correction)return fail('Delete the linked correction draft before deleting this invoice.',409);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM payment_allocations WHERE target_type='invoice' AND target_id=?").bind(invoiceId),
    env.DB.prepare('DELETE FROM invoice_items WHERE invoice_id=?').bind(invoiceId),
    env.DB.prepare("DELETE FROM financial_events WHERE entity_type='invoice' AND entity_id=?").bind(invoiceId),
    env.DB.prepare('DELETE FROM invoices WHERE id=?').bind(invoiceId),
    // Generic event wakes other devices without retaining an invoice deletion record.
    env.DB.prepare("INSERT INTO financial_events (entity_type,entity_id,action) VALUES ('system','invoices','changed')")
  ]);
  return j({ok:true,deleted:true});
}

async function saveParty(request, env) {
  const b = await request.json().catch(()=>null);
  if (!b || !['customer','supplier'].includes(b.type) || !text(b.name,200)) return fail('Party type and name are required');
  const partyId=id('party');
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO parties (id,type,name,address,tax_id,state_code,place_of_supply,opening_balance_paise) VALUES (?,?,?,?,?,?,?,?)').bind(partyId,b.type,text(b.name,200),text(b.address,1000),text(b.tax_id,100),text(b.state_code,100),text(b.place_of_supply,100),paise(b.opening_balance_paise)??0),
      env.DB.prepare("INSERT INTO financial_events (entity_type,entity_id,action) VALUES ('party',?,'created')").bind(partyId)
    ]);
  } catch(e) { if (/UNIQUE/i.test(String(e))) return fail('That party already exists',409); throw e; }
  return j({ok:true,id:partyId},201);
}

async function saveItemCode(request, env) {
  const b=await request.json().catch(()=>null), code=text(b?.code,30).toUpperCase(), description=text(b?.description,200), rate=b?.default_rate_paise_per_kg==null?null:paise(b.default_rate_paise_per_kg);
  if(!code||!description||(b?.default_rate_paise_per_kg!=null&&rate===null))return fail('Valid item code and description required');
  await env.DB.prepare('INSERT INTO item_codes (code,description,default_rate_paise_per_kg) VALUES (?,?,?) ON CONFLICT(code) DO UPDATE SET description=excluded.description,default_rate_paise_per_kg=excluded.default_rate_paise_per_kg,active=1').bind(code,description,rate).run();
  return j({ok:true});
}

async function savePayment(request, env) {
  const b=await request.json().catch(()=>null);
  const direction=b?.direction, partyId=text(b?.party_id,100), amount=paise(b?.amount_paise), paymentDate=text(b?.payment_date,10), key=text(b?.idempotency_key,200);
  if(!['received','made'].includes(direction)||!partyId||!amount||!isoDate(paymentDate)||!key)return fail('Direction, party, date, amount and idempotency key are required');
  const party=await env.DB.prepare('SELECT * FROM parties WHERE id=?').bind(partyId).first();
  if(!party||(direction==='received'&&party.type!=='customer')||(direction==='made'&&party.type!=='supplier'))return fail('Payment direction does not match party type');
  const existing=await env.DB.prepare('SELECT id FROM payments WHERE idempotency_key=?').bind(key).first();
  if(existing)return j({ok:true,id:existing.id,replayed:true});
  const paymentId=id('payment');
  let requested=Array.isArray(b.allocations)?b.allocations:[];
  const allocations=[];
  if(b.allocation_mode==='oldest'){
    if(direction==='received'){
      const rows=await env.DB.prepare(`SELECT i.id,i.total_paise-COALESCE((SELECT SUM(a.amount_paise) FROM payment_allocations a WHERE a.target_type='invoice' AND a.target_id=i.id),0) outstanding FROM invoices i WHERE i.party_id=? AND i.status IN ('finalized','partially_paid') ORDER BY i.invoice_date,i.invoice_number,i.created_at`).bind(partyId).all();
      requested=(rows.results||[]).map(x=>({target_type:'invoice',target_id:x.id,available_paise:x.outstanding}));
    }else{
      const legacy=await readLegacyPurchases(env);const supplierName=party.name.toLowerCase();
      const used=await env.DB.prepare("SELECT target_id,SUM(amount_paise) used FROM payment_allocations WHERE target_type='purchase' GROUP BY target_id").all();
      const usedMap=new Map((used.results||[]).map(x=>[x.target_id,x.used]));
      requested=legacy.filter(x=>x.supplier.toLowerCase()===supplierName&&!['cancelled','on_hold'].includes(x.status)).sort((a,b)=>a.date.localeCompare(b.date)).map(x=>({target_type:'purchase',target_id:x.id,available_paise:Math.max(0,x.amount_paise-(usedMap.get(x.id)||0))}));
    }
  }
  let remaining=amount;
  for(const row of requested){
    if(remaining<=0)break;
    const targetType=text(row.target_type,30),targetId=text(row.target_id,100);
    if(!['invoice','purchase','opening_balance'].includes(targetType)||!targetId)continue;
    let available=Number(row.available_paise);
    if(b.allocation_mode!=='oldest'){
      const requestedAmount=paise(row.amount_paise);if(!requestedAmount)continue;
      if(targetType==='invoice'){
        if(direction!=='received')return fail('Invoices can only receive customer payments');
        const target=await env.DB.prepare(`SELECT i.party_id,i.total_paise-COALESCE((SELECT SUM(a.amount_paise) FROM payment_allocations a WHERE a.target_type='invoice' AND a.target_id=i.id),0) outstanding FROM invoices i WHERE i.id=? AND i.status IN ('finalized','partially_paid')`).bind(targetId).first();
        if(!target||target.party_id!==partyId)return fail('Invalid invoice allocation target');available=target.outstanding;
      }else if(targetType==='purchase'){
        if(direction!=='made')return fail('Purchases can only receive supplier payments');
        const purchase=(await readLegacyPurchases(env)).find(x=>x.id===targetId&&x.supplier.toLowerCase()===party.name.toLowerCase());
        if(!purchase)return fail('Invalid purchase allocation target');const used=await env.DB.prepare("SELECT COALESCE(SUM(amount_paise),0) used FROM payment_allocations WHERE target_type='purchase' AND target_id=?").bind(targetId).first();available=Math.max(0,purchase.amount_paise-(used?.used||0));
      }else{if(targetId!==partyId)return fail('Invalid opening balance allocation target');available=requestedAmount}
      if(requestedAmount>available)return fail('Allocation exceeds the document outstanding balance');available=requestedAmount;
    }
    if(!Number.isSafeInteger(available)||available<=0)continue;
    const applied=Math.min(remaining,available);allocations.push({id:id('allocation'),target_type:targetType,target_id:targetId,amount_paise:applied});remaining-=applied;
  }
  const statements=[env.DB.prepare('INSERT INTO payments (id,direction,party_id,payment_date,amount_paise,reference,notes,idempotency_key) VALUES (?,?,?,?,?,?,?,?)').bind(paymentId,direction,partyId,paymentDate,amount,text(b.reference,200),text(b.notes,1000),key)];
  for(const a of allocations)statements.push(env.DB.prepare('INSERT INTO payment_allocations (id,payment_id,target_type,target_id,amount_paise) VALUES (?,?,?,?,?)').bind(a.id,paymentId,a.target_type,a.target_id,a.amount_paise));
  statements.push(env.DB.prepare("INSERT INTO financial_events (entity_type,entity_id,action) VALUES ('payment',?,'created')").bind(paymentId));
  await env.DB.batch(statements);
  if(direction==='received')await refreshInvoiceStatuses(env,allocations.filter(a=>a.target_type==='invoice').map(a=>a.target_id));
  return j({ok:true,id:paymentId,allocated_paise:amount-remaining,unapplied_paise:remaining},201);
}

async function refreshInvoiceStatuses(env, ids) {
  for(const invoiceId of [...new Set(ids)]){
    const row=await env.DB.prepare(`SELECT i.total_paise,COALESCE(SUM(a.amount_paise),0) paid FROM invoices i LEFT JOIN payment_allocations a ON a.target_type='invoice' AND a.target_id=i.id WHERE i.id=? GROUP BY i.id`).bind(invoiceId).first();
    if(!row)continue;const status=row.paid>=row.total_paise?'paid':row.paid>0?'partially_paid':'finalized';
    await env.DB.prepare("UPDATE invoices SET status=?,updated_at=datetime('now') WHERE id=? AND status IN ('finalized','partially_paid','paid')").bind(status,invoiceId).run();
  }
}

async function changes(url, env) {
  const since=Math.max(0,Number(url.searchParams.get('since')||0));
  const rows=await env.DB.prepare('SELECT * FROM financial_events WHERE sequence>? ORDER BY sequence LIMIT 100').bind(since).all();
  const latest=await env.DB.prepare('SELECT COALESCE(MAX(sequence),0) sequence FROM financial_events').first();
  return j({changed:(rows.results||[]).length>0,events:rows.results||[],sequence:latest?.sequence||0});
}

const money = p => `Rs ${(p/100).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const numberWordsBelow1000 = n => {
  const one=['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const ten=['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  let out=[];if(n>=100){out.push(one[Math.floor(n/100)],'Hundred');n%=100}if(n>=20){out.push(ten[Math.floor(n/10)]);n%=10}if(n>0)out.push(one[n]);return out.join(' ');
};
export function amountInWords(paiseValue){
  let n=Math.round(paiseValue/100);if(n===0)return 'Rupees Zero Only';
  const parts=[];const crore=Math.floor(n/10000000);n%=10000000;const lakh=Math.floor(n/100000);n%=100000;const thousand=Math.floor(n/1000);n%=1000;
  if(crore)parts.push(numberWordsBelow1000(crore),'Crore');if(lakh)parts.push(numberWordsBelow1000(lakh),'Lakh');if(thousand)parts.push(numberWordsBelow1000(thousand),'Thousand');if(n)parts.push(numberWordsBelow1000(n));return `Rupees ${parts.join(' ')} Only`;
}

function wrap(font, value, size, width){const words=String(value||'').split(/\s+/),lines=[];let line='';for(const word of words){const test=line?line+' '+word:word;if(font.widthOfTextAtSize(test,size)<=width)line=test;else{if(line)lines.push(line);line=word}}if(line)lines.push(line);return lines}
function box(page,x,y,w,h,{fill=null,border=rgb(.68,.68,.68),width=.6}={}){page.drawRectangle({x,y,width:w,height:h,borderColor:border,borderWidth:width,...(fill?{color:fill}:{})})}
function label(page,font,bold,x,y,labelText,value,size=9){page.drawText(labelText,{x,y,size,font:bold});page.drawText(value,{x:x+bold.widthOfTextAtSize(labelText,size)+3,y,size,font})}

async function invoicePdf(invoiceId, env){
  const inv=await env.DB.prepare(`SELECT i.*,p.name party_name,p.address party_address,p.tax_id party_tax_id,p.state_code party_state_code FROM invoices i JOIN parties p ON p.id=i.party_id WHERE i.id=?`).bind(invoiceId).first();
  if(!inv)return fail('Invoice not found',404);
  const items=(await env.DB.prepare('SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY position').bind(invoiceId).all()).results||[];
  const cfg=await config(env),seller=cfg.seller||{},invoiceCfg=cfg.invoice||{};
  const allocated=await env.DB.prepare("SELECT COALESCE(SUM(amount_paise),0) paid FROM payment_allocations WHERE target_type='invoice' AND target_id=?").bind(invoiceId).first();
  const received=allocated?.paid||0,balance=Math.max(0,inv.total_paise-received);
  const pdf=await PDFDocument.create(),page=pdf.addPage([595.28,841.89]),font=await pdf.embedFont(StandardFonts.TimesRoman),bold=await pdf.embedFont(StandardFonts.TimesRomanBold),navy=rgb(.13,.23,.36),grey=rgb(.94,.94,.94),x=38,w=519;
  page.drawText(invoiceCfg.heading||'Tax Invoice',{x:235,y:792,size:18,font:bold});
  box(page,x,690,w,86);page.drawText(seller.name||'',{x:x+7,y:752,size:15,font:bold});let sy=735;for(const line of wrap(font,seller.address,9,500)){page.drawText(line,{x:x+7,y:sy,size:9,font});sy-=12}label(page,font,bold,x+7,sy,'PAN:',seller.pan||'');label(page,font,bold,x+150,sy,'TAN:',seller.tan||'');label(page,font,bold,x+300,sy,'LLPIN:',seller.llpin||'');sy-=14;label(page,font,bold,x+7,sy,'State:',seller.state||'');
  box(page,x,572,w,100);box(page,x,647,w/2,25,{fill:grey});box(page,x+w/2,647,w/2,25,{fill:grey});page.drawText('Bill To:',{x:x+7,y:655,size:10,font:bold});page.drawText('Invoice Details:',{x:x+w/2+7,y:655,size:10,font:bold});page.drawLine({start:{x:x+w/2,y:572},end:{x:x+w/2,y:672},thickness:.6,color:rgb(.68,.68,.68)});page.drawText(inv.party_name,{x:x+7,y:626,size:11,font:bold});let by=612;for(const line of wrap(font,inv.party_address,9,240)){page.drawText(line,{x:x+7,y:by,size:9,font});by-=12}label(page,font,bold,x+7,by,'GSTIN:',inv.party_tax_id||'');by-=13;label(page,font,bold,x+7,by,'State:',inv.party_state_code||'');label(page,font,bold,x+w/2+7,620,'No:',inv.invoice_number);label(page,font,bold,x+w/2+7,604,'Date:',inv.invoice_date.split('-').reverse().join('/'));label(page,font,bold,x+w/2+7,588,'Place of Supply:',inv.place_of_supply||inv.party_state_code||'');
  const cols=[26,166,58,62,57,68,82],tableTop=554,rowH=29,headH=37,totalH=30;let cx=x;for(let i=0;i<cols.length;i++){box(page,cx,tableTop-headH,cols[i],headH,{fill:navy,border:rgb(.8,.8,.8)});cx+=cols[i]}const heads=['#','Item name','Code','Quantity','Unit','Price/Unit','Amount'];cx=x;heads.forEach((h,i)=>{page.drawText(h,{x:cx+5,y:tableTop-22,size:8.5,font:bold,color:rgb(1,1,1)});cx+=cols[i]});let y=tableTop-headH;const printable=[...items,{transport:true}];for(let i=0;i<printable.length;i++){const row=printable[i],rh=row.transport?rowH:rowH;y-=rh;cx=x;for(const cw of cols){box(page,cx,y,cw,rh);cx+=cw}page.drawText(String(i+1),{x:x+11,y:y+10,size:9,font});if(row.transport){page.drawText('Transportation',{x:x+31,y:y+10,size:9,font});page.drawText(money(inv.transportation_paise),{x:x+w-cols[6]+6,y:y+10,size:9,font})}else{page.drawText(row.description,{x:x+31,y:y+10,size:9,font});page.drawText(row.item_code||'',{x:x+31+cols[1],y:y+10,size:9,font});page.drawText((row.quantity_grams/1000).toLocaleString('en-IN'),{x:x+31+cols[1]+cols[2]+12,y:y+10,size:9,font});page.drawText('Kg',{x:x+31+cols[1]+cols[2]+cols[3]+12,y:y+10,size:9,font});page.drawText(money(row.rate_paise_per_kg),{x:x+w-cols[6]-cols[5]+5,y:y+10,size:8.5,font});page.drawText(money(row.amount_paise),{x:x+w-cols[6]+5,y:y+10,size:8.5,font})}}
  y-=totalH;box(page,x,y,w,totalH);page.drawText('Total',{x:x+31,y:y+10,size:10,font:bold});page.drawText(money(inv.total_paise),{x:x+w-cols[6]+5,y:y+10,size:9,font:bold});
  y-=17;const totals=[['Sub Total',inv.subtotal_paise+inv.transportation_paise],...(inv.tax_paise>0?[['Manual tax',inv.tax_paise]]:[]),['Total',inv.total_paise],['Received',received],['Balance',balance]];for(const [name,value] of totals){y-=26;box(page,x,y,w,26);page.drawLine({start:{x:x+365,y},end:{x:x+365,y:y+26},thickness:.6,color:rgb(.68,.68,.68)});page.drawText(name,{x:x+7,y:y+8,size:10,font:name==='Total'||name==='Balance'?bold:font});page.drawText(money(value),{x:x+450,y:y+8,size:9,font:name==='Total'||name==='Balance'?bold:font})}
  y-=17;box(page,x,y-50,w,50);box(page,x,y-20,w,20,{fill:grey});page.drawText('Invoice Amount in Words:',{x:x+7,y:y-14,size:9,font:bold});page.drawText(amountInWords(inv.total_paise),{x:x+7,y:y-41,size:9,font});y-=68;
  box(page,x,y-100,w,100);page.drawLine({start:{x:x+w/2,y:y-100},end:{x:x+w/2,y},thickness:.6,color:rgb(.68,.68,.68)});box(page,x,y-25,w/2,25,{fill:grey});box(page,x+w/2,y-25,w/2,25,{fill:grey});page.drawText('Description:',{x:x+7,y:y-16,size:9,font:bold});page.drawText('Terms & Conditions:',{x:x+w/2+7,y:y-16,size:9,font:bold});let dy=y-40;for(const line of wrap(font,inv.description,8.5,w/2-14).slice(0,4)){page.drawText(line,{x:x+7,y:dy,size:8.5,font});dy-=11}let ty=y-40;for(const line of wrap(font,inv.terms,8.5,w/2-14).slice(0,3)){page.drawText(line,{x:x+w/2+7,y:ty,size:8.5,font});ty-=11}page.drawLine({start:{x:x+w/2,y:y-65},end:{x:x+w,y:y-65},thickness:.6,color:rgb(.68,.68,.68)});page.drawText(`For ${seller.name||''}:`,{x:x+w/2+7,y:y-59,size:9,font:bold});page.drawText(invoiceCfg.authorisedSignatory||'Authorised Signatory',{x:x+w-96,y:y-92,size:8.5,font});
  const bytes=await pdf.save();return new Response(bytes,{headers:{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="invoice-${inv.invoice_number}.pdf"`,'Cache-Control':'no-store'}});
}

export async function handleFinancialApi(request, env, url) {
  const method=request.method, path=url.pathname;
  if(path==='/api/financial/bootstrap'&&method==='GET')return j(await bootstrap(env));
  if(path==='/api/financial/changes'&&method==='GET')return changes(url,env);
  if(path==='/api/invoices'&&method==='POST')return saveInvoice(request,env);
  if(path==='/api/parties'&&method==='POST')return saveParty(request,env);
  if(path==='/api/item-codes'&&method==='POST')return saveItemCode(request,env);
  if(path==='/api/payments'&&method==='POST')return savePayment(request,env);
  const invoiceMatch=path.match(/^\/api\/invoices\/([^/]+)(?:\/(finalize|correct|pdf))?$/);
  if(invoiceMatch){const invoiceId=decodeURIComponent(invoiceMatch[1]),action=invoiceMatch[2];if(!action&&method==='PUT')return saveInvoice(request,env,invoiceId);if(!action&&method==='DELETE')return deleteInvoice(invoiceId,env);if(action==='finalize'&&method==='POST')return finalizeInvoice(invoiceId,env);if(action==='correct'&&method==='POST')return correctionInvoice(invoiceId,env);if(action==='pdf'&&method==='GET')return invoicePdf(invoiceId,env)}
  return null;
}
