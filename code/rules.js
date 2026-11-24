// Hard business rules for the Kesar & Co. copilot. Pure functions, no I/O.
// The LLM classifies and writes; everything that must not be talked around is decided here.

const INTENTS = ['order_status', 'product_query', 'return_refund', 'complaint', 'other'];
const SENTIMENTS = ['positive', 'neutral', 'negative', 'angry'];
const LANGUAGES = ['en', 'hi', 'hinglish'];
const FAULTS = ['damaged', 'wrong_item', 'missing_item'];
const ISSUES = ['none', ...FAULTS, 'changed_mind', 'not_satisfied'];
const CONDITIONS = ['unopened', 'opened_or_used', 'unknown'];
const TICKET_INTENTS = ['return_refund', 'complaint'];
const ORDER_INTENTS = ['order_status', ...TICKET_INTENTS];
const ON_THE_WAY = ['processing', 'shipped', 'out_for_delivery'];
const CONFIDENCE_THRESHOLD = 0.75;
const NOT_ENGLISH = 'not in English, draft checks are weaker'; // a person reads the draft, but the customer is not promised a follow-up

const INJECTION = /(ignore|disregard|forget|skip|bypass|override)\b[\s\S]{0,40}\b(instructions?|guidance|polic(y|ies)|rules|checks?)|\bsystem\s*(note|prompt|message|:)|note to (the )?(ai|assistant)|reply exactly|mark [\s\S]{0,30}approved|do not create [\s\S]{0,15}ticket|set (the )?priority/i;
const ORDER_PROBLEM = /\bKC[-\s]?\d{4}\b|refund|return|damaged|cracked|leak|broken|wrong item|missing|not received|money back/i;
const SAYS_USED = /(?<!never |not |n't )\b(used|using|opened|tried|applied)\b/i;
const SIGN_OFF = /Warm regards,\s*\nTeam Kesar\s*$/;

const lower = s => String(s ?? '').trim().toLowerCase();

// ---------- 0. Incoming email ----------

function normalizeEmail(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  const email = {
    id: String(e.id ?? ''), received_at: String(e.received_at ?? ''),
    from: { name: String(e.from?.name ?? ''), email: String(e.from?.email ?? '') },
    subject: String(e.subject ?? ''), body: String(e.body ?? ''),
    attachments: Array.isArray(e.attachments) ? e.attachments.map(String) : [],
  };
  const missing = [!email.id && 'id', Number.isNaN(Date.parse(email.received_at)) && 'received_at', !email.from.email && 'from.email',
    !email.subject && !email.body && 'content'].filter(Boolean);
  return { ...email, input_errors: missing.map(f => `missing or bad ${f}`) };
}

// ---------- 1. Classification output ----------

function classificationErrors(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['not an object'];
  const errors = [];
  const check = (ok, field) => { if (!ok) errors.push(`bad ${field}`); };
  check(INTENTS.includes(c.intent), 'intent');
  check(c.secondary_intent === null || INTENTS.includes(c.secondary_intent), 'secondary_intent');
  check(c.order_id === null || /^KC-[0-9]{4}$/.test(c.order_id), 'order_id');
  check(SENTIMENTS.includes(c.sentiment), 'sentiment');
  check(LANGUAGES.includes(c.language), 'language');
  check(typeof c.confidence === 'number' && c.confidence >= 0 && c.confidence <= 1, 'confidence');
  check(typeof c.summary === 'string' && c.summary.length <= 200, 'summary');
  check(ISSUES.includes(c.issue_type), 'issue_type');
  check(CONDITIONS.includes(c.item_condition), 'item_condition');
  check(Array.isArray(c.items_mentioned) && c.items_mentioned.every(i => typeof i === 'string'), 'items_mentioned');
  check(typeof c.needs_answer === 'boolean', 'needs_answer');
  check(typeof c.health_concern === 'boolean', 'health_concern');
  return errors;
}

function parseClassification(raw) {
  let errors;
  try {
    const c = typeof raw === 'string' ? JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) : raw;
    errors = classificationErrors(c);
    if (!errors.length) return { ...c, valid: true, errors };
  } catch (e) {
    errors = [e.message];
  }
  return {
    intent: 'other', secondary_intent: null, order_id: null, sentiment: 'neutral', language: 'en', confidence: 0,
    summary: 'Automatic classification failed; please read the email.', issue_type: 'none',
    item_condition: 'unknown', items_mentioned: [], needs_answer: true, health_concern: false, valid: false, errors,
  };
}

// ---------- 2. Order lookup and privacy ----------

const idsIn = text => [...new Set([...text.matchAll(/\bKC[-\s]?(\d{4})\b/gi)].map(m => `KC-${m[1]}`))];

// The ID is taken from the email text, never from the LLM, so a hallucinated ID cannot reach the lookup.
function resolveOrder(email, cls, orders) {
  const text = `${email.subject}\n${email.body}`;
  const ids = idsIn(text);
  const sender = lower(email.from.email);
  const owns = o => sender !== '' && lower(o.customer_email) === sender;

  if (ids.length > 1) return { access: 'ambiguous', order_id: null, order: null };
  if (ids.length === 1) {
    const order = orders.find(o => o.order_id === ids[0]);
    if (!order) return { access: 'not_found', order_id: ids[0], order: null };
    return owns(order)
      ? { access: 'match', order_id: ids[0], order }
      : { access: 'mismatch', order_id: ids[0], order: null };
  }
  if (!ORDER_INTENTS.includes(cls.intent) && !ORDER_INTENTS.includes(cls.secondary_intent) && cls.issue_type === 'none') {
    return { access: 'not_needed', order_id: null, order: null };
  }
  const mine = orders.filter(owns);
  if (mine.length === 1) return { access: 'match', order_id: mine[0].order_id, order: mine[0] };
  return { access: mine.length ? 'ambiguous' : 'not_found', order_id: null, order: null };
}

// What the agent may see. Name, email and address are never needed in a reply.
function publicOrder(order) {
  if (!order) return null;
  const { customer_name, customer_email, shipping_address, ...safe } = order;
  if (!ON_THE_WAY.includes(order.status)) delete safe.estimated_delivery; // an old estimate misled a reply about a delivered order
  const weekday = safe.estimated_delivery
    ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(order.estimated_delivery).getUTCDay()] : null;
  return { ...safe, estimated_delivery_weekday: weekday };
}

// Body of the get_order tool. `resolved` comes from the workflow, not from the agent.
// Someone else's order and a non-existent order give the same answer, so the tool cannot confirm an order exists.
function getOrderTool(requestedId, resolved) {
  const asked = String(requestedId ?? '').trim().toUpperCase();
  if (resolved?.access === 'match' && (!asked || asked === resolved.order_id)) return publicOrder(resolved.order);
  return { error: 'No order can be shared for this sender. Do not state any order details.' };
}

// Body of the search_faq tool. The FAQ is small, so whole sections are ranked by shared words.
function searchFaq(question, faq) {
  const words = [...new Set(lower(question).match(/[a-z]{3,}/g) || [])].filter(w => !/^(the|and|for|are|can|you|our|your|how|what|does|this|that|with|from|will|have|need)$/.test(w));
  const ranked = String(faq).split(/^(?=## )/m).slice(1)
    .map(text => ({ text, score: words.reduce((n, w) => n + (lower(text).includes(w) ? 1 : 0) + (lower(text.split(/\r?\n/)[0]).includes(w) ? 2 : 0), 0) }))
    .filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  return ranked.length ? ranked.map(s => s.text.trim()).join('\n\n') : 'Not covered by the FAQ. Do not answer it; say a team member will follow up.';
}

// Same sentence for "not yours" and "does not exist", so the reply cannot confirm an order either way.
const noOrderLine = idGiven => `We could not match this request to an order for this email address. Please ${idGiven ? 'check' : 'share'} the order ID and write to us from the email address used when ordering.`;

function caseFacts(resolved, assessment, decision) {
  const { outcome, days_since_delivery, refund_amount, reasons } = assessment;
  return {
    order_id: resolved.access === 'match' ? resolved.order_id : null, outcome, days_since_delivery, refund_amount, reasons,
    team_member_will_follow_up: decision.human_reasons.some(r => r !== NOT_ENGLISH),
    ...(outcome === 'return_eligible' ? { fees_not_refunded: Object.fromEntries(['shipping_fee', 'cod_fee'].filter(f => resolved.order[f] > 0).map(f => [f, resolved.order[f]])) } : {}),
    ...(['mismatch', 'not_found'].includes(resolved.access) ? { say_this: noOrderLine(Boolean(resolved.order_id)) } : {}),
    ...(resolved.order?.payment_method === 'cod' && ON_THE_WAY.includes(resolved.order.status) ? { cash_due_on_delivery: resolved.order.total } : {}),
  };
}

// ---------- 3. Dates and eligibility ----------

const istDate = iso => (Number.isNaN(Date.parse(iso)) ? '' : new Date(Date.parse(iso) + 5.5 * 36e5).toISOString().slice(0, 10));
const daysSinceDelivery = (delivered, receivedAt) => Math.round((Date.parse(istDate(receivedAt)) - Date.parse(delivered)) / 864e5);

const wordsIn = (mention, name) => {
  const words = lower(mention).split(/[^a-z0-9]+/).filter(w => w.length > 2);
  return words.length > 0 && words.every(w => lower(name).includes(w));
};
function refundForReturn(order, mentioned) {
  const whole = order.items.every(i => (order.items.length === 1 && i.qty === 1)
    || (i.qty === 1 && mentioned.some(m => wordsIn(m, i.name))));
  return whole ? order.subtotal : null; // fees are non-refundable; partial returns go to a human
}

function assess(email, cls, order) {
  const result = (outcome, extra = {}) => ({ outcome, days_since_delivery: null, refund_amount: null, reasons: [], ...extra });
  if (!order || cls.issue_type === 'none') return result('not_applicable');
  if (order.status !== 'delivered') return result('not_delivered');
  const days = daysSinceDelivery(order.delivered_date, email.received_at);
  if (!(days >= 0)) return result('date_problem'); // also catches NaN from a missing date

  if (FAULTS.includes(cls.issue_type)) {
    // Orders carry a delivery date but no time, so the true age is a 24-hour range.
    const maxHours = (Date.parse(email.received_at) - Date.parse(`${order.delivered_date}T00:00:00+05:30`)) / 36e5;
    const outcome = maxHours - 24 > 48 ? 'fault_late' : maxHours > 48 ? 'fault_window_unclear'
      : (email.attachments || []).length ? 'fault_verify' : 'fault_need_photos';
    return result(outcome, { days_since_delivery: days });
  }

  const reasons = [];
  if (days > 7) reasons.push(`reported ${days} days after delivery (limit 7)`);
  if (cls.item_condition === 'opened_or_used') reasons.push('product opened or used');
  if (reasons.length) return result('return_not_eligible', { days_since_delivery: days, reasons });
  if (cls.item_condition === 'unknown') return result('return_need_condition', { days_since_delivery: days });
  return result('return_eligible', { days_since_delivery: days, refund_amount: refundForReturn(order, cls.items_mentioned) });
}

// ---------- 4. Decision ----------

function decide(email, cls, resolved, assessment) {
  const human = [];
  const flag = (on, why) => { if (on) human.push(why); };
  const text = `${email.subject}\n${email.body}`;
  const logOnly = cls.intent === 'other' && !cls.needs_answer;
  (email.input_errors || []).forEach(e => flag(true, e));
  flag(!cls.valid, 'classification failed');
  flag(logOnly && ORDER_PROBLEM.test(text), 'marked log-only but mentions an order problem');
  flag(cls.item_condition === 'unopened' && SAYS_USED.test(text), 'condition unclear: email also says used or opened');
  flag(cls.valid && cls.confidence < CONFIDENCE_THRESHOLD, 'low confidence');
  flag(INJECTION.test(text), 'possible prompt injection');
  flag(cls.sentiment === 'angry', 'angry customer');
  flag(cls.health_concern, 'health question');
  flag(resolved.access === 'mismatch', 'sender does not own this order');
  flag(resolved.access === 'not_found', 'order not found');
  flag(resolved.access === 'ambiguous', 'more than one possible order');
  flag(cls.intent === 'other' && cls.needs_answer && cls.valid, 'request not covered by the FAQ');
  flag(cls.issue_type === 'missing_item', 'missing item needs weight check');
  flag(['fault_verify', 'fault_late', 'fault_window_unclear', 'not_delivered', 'date_problem'].includes(assessment.outcome), assessment.outcome);
  flag(assessment.outcome === 'return_eligible' && assessment.refund_amount === null, 'partial return, refund amount not computed');

  const isTicket = cls.valid && (TICKET_INTENTS.includes(cls.intent) || TICKET_INTENTS.includes(cls.secondary_intent) || cls.issue_type !== 'none');
  flag(cls.language !== 'en' && !logOnly, NOT_ENGLISH);
  const ticketIntent = TICKET_INTENTS.includes(cls.intent) ? cls.intent : FAULTS.includes(cls.issue_type) ? 'complaint'
    : TICKET_INTENTS.includes(cls.secondary_intent) ? cls.secondary_intent : 'return_refund';
  return {
    action: logOnly ? 'log_only' : 'draft_reply',
    needs_human: human.length > 0,
    human_reasons: human,
    ticket: isTicket ? { intent: ticketIntent, priority: ticketIntent === 'complaint' ? 'High' : 'Medium' } : null,
  };
}

// ---------- 5. Tickets ----------

const orderKey = id => { const m = String(id ?? '').match(/(\d{4})\s*$/); return m ? `KC-${m[1]}` : ''; };
const idList = v => String(v ?? '').split(',').map(x => x.trim()).filter(Boolean);

function findOpenTicket(tickets, orderId) {
  return tickets.find(t => orderId && orderKey(t.order_id) === orderId && lower(t.status) !== 'closed') || null;
}

function ticketChange(email, cls, resolved, decision, tickets) {
  if (!decision.ticket) return null;
  const seen = tickets.find(t => idList(t.email_ids).includes(email.id));
  if (seen) return { operation: 'none', row: seen }; // same email sent twice
  // Only the verified owner's ticket carries the order ID, so a stranger quoting it cannot touch or block the owner's ticket.
  const ownedId = resolved.access === 'match' ? resolved.order_id : null;
  const existing = findOpenTicket(tickets, ownedId);
  const note = `[${email.received_at}] ${email.id}: ${cls.summary}`
    + (!ownedId && resolved.order_id ? ` (claims ${resolved.order_id}, not verified)` : '')
    + (email.attachments?.length ? ` (attachments: ${email.attachments.join(', ')})` : '')
    + (decision.human_reasons.length ? ` | needs human: ${decision.human_reasons.join('; ')}` : '');
  if (existing) {
    return {
      operation: 'update',
      row: {
        ...existing, updated_at: email.received_at, email_ids: [...idList(existing.email_ids), email.id].join(', '),
        priority: decision.ticket.priority === 'High' ? 'High' : existing.priority, notes: [existing.notes, note].filter(Boolean).join('\n'),
      },
    };
  }
  return {
    operation: 'create',
    row: {
      ticket_id: `TKT-${email.id}`, // unique per email, so overlapping runs cannot hand out the same number
      created_at: email.received_at, updated_at: email.received_at, order_id: ownedId ?? '',
      customer_email: email.from.email, email_ids: email.id, intent: decision.ticket.intent,
      priority: decision.ticket.priority, status: 'Open', summary: cls.summary, notes: note,
    },
  };
}

// ---------- 6. Draft check ----------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAME = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const numbers = (text, re) => [...String(text).matchAll(re)].map(m => Number((m[1] ?? m[2]).replace(/,/g, '')));
const MONEY = /(?:₹|\brs\.?|\binr|\brupees)\s*([\d,]*\d(?:\.\d+)?)|\b([\d,]*\d(?:\.\d+)?)\s*(?:\/-|rupees\b|rs\b)/gi;
const DURATION = /(\d+)(?:\s*(?:[–-]|to)\s*(\d+))?\s*(?:business\s+|working\s+)?(?:days?|hours?|hrs?)\b/gi;
const durations = text => [...String(text).matchAll(DURATION)].flatMap(m => [m[1], m[2]]).filter(Boolean).map(Number);
const NEGATED = /\b(not(?! only)|non|cannot|can't|don't|never|unable|isn't|won't)\b/i;

// Every ID, link, amount and date in a draft must trace back to the order, the rules or the FAQ.
// shortcut: dates are only recognised with English month names, extend when Hindi drafts use Devanagari months.
function checkDraft(draft, { email, order, assessment, faq, needsHuman = false, access = 'match' }) {
  const text = String(draft ?? '');
  const problems = [];
  const bad = (on, why) => { if (on) problems.push(why); };

  const ids = idsIn(text);
  const asked = idsIn(`${email.subject}\n${email.body}`);
  bad(ids.some(id => id !== order?.order_id && !asked.includes(id)), 'unknown order ID');

  const urls = [...text.matchAll(/(?:https?:\/\/|www\.|\btrack\.example)[^\s)>\]]+/gi)].map(m => m[0].replace(/[.,;:!?]+$/, ''));
  bad(urls.some(u => u !== order?.tracking_url), 'unknown link');

  const contacts = [...text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map(m => lower(m[0]));
  bad(contacts.some(c => !lower(faq).includes(c)), 'unknown email address');

  const allowed = new Set([...numbers(faq, MONEY), ...numbers(order?.refund_status ?? '', MONEY)]);
  if (order) [order.subtotal, order.shipping_fee, order.cod_fee, order.total, ...order.items.map(i => i.unit_price)].forEach(n => allowed.add(n));
  if (assessment.refund_amount != null) allowed.add(assessment.refund_amount);
  bad(numbers(text, MONEY).some(n => !allowed.has(n)), 'unknown amount');

  bad(durations(text).some(n => !durations(faq).includes(n) && n !== assessment.days_since_delivery), 'unknown time period');
  // Every range in the FAQ is in business days, so a bare "6-8 days" understates it.
  bad(/\d+\s*(?:[–-]|to|se|से)\s*\d+\s*(?:days|din|दिन)/i.test(text), 'time period missing "business days"');
  bad(/\b\d{1,4}[/-]\d{1,2}[/-]\d{2,4}\b/.test(text.replace(/https?:\S+/g, '')), 'date not written in words');
  bad(/\+?\d(?:[\s-]?\d){9,}/.test(text.replace(/https?:\S+/g, '')), 'phone-like number');

  const known = new Set([email.received_at, order?.order_date, order?.shipped_date, order?.estimated_delivery, order?.delivered_date, order?.cancelled_date]
    .filter(Boolean).map(d => (d.includes('T') ? istDate(d) : d).slice(5)));
  const month = MONTH_NAME;
  const said = [
    ...[...text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${month}\\b`, 'gi'))].map(m => [m[1], m[2]]),
    ...[...text.matchAll(new RegExp(`\\b${month}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'))].map(m => [m[2], m[1]]),
  ].map(([d, m]) => `${String(MONTHS.indexOf(lower(m).slice(0, 3)) + 1).padStart(2, '0')}-${d.padStart(2, '0')}`);
  bad(said.some(d => !known.has(d)), 'unknown date');

  const sentences = text.split(/(?<=[.!?।])\s+|\n+/);
  const anySentence = (re, unless) => sentences.some(s => re.test(s) && !unless.test(s));
  bad(anySentence(/\b(cures?|treats?|heals?)\b|\b(clear|fix|help)\w*\b.{0,25}\b(eczema|acne|psoriasis|condition)\b/i, NEGATED), 'medical claim');
  const done = '(approved|processed|credited|confirmed|issued|on its way)';
  bad(anySentence(new RegExp(`refund.{0,30}\\b${done}\\b|\\b${done}.{0,20}refund|\\bwe(?:'ll| will| have| are)\\b.{0,20}\\brefund`, 'i'),
    /\b(not|cannot|unable|once|after|if|when|following|subject to)\b/i), 'promises a refund');
  bad(!needsHuman && /\bteam member\b|\bfollow(ing)?[ -]?up\b|\bget back to you\b|\bwill check further\b|टीम/i.test(text), 'promises a follow-up nobody was told about');
  bad(['mismatch', 'not_found'].includes(access) && /\b(not sent from|different email|another (email|person|customer|account)|belongs? to|registered (to|email)|placed by|does(n't| not) exist)\b/i.test(text), 'hints whether the order exists');
  bad(order?.status === 'delivered' && /\b(estimated|expected) (to|delivery|date|arrival)\b|\bout for delivery\b/i.test(text), 'talks about delivery of a delivered order');
  bad(assessment.outcome === 'return_not_eligible' && anySentence(/\bwe(?:'ll| will| can)\b.{0,30}\b(refund|return|replace)/i, NEGATED), 'contradicts not eligible');
  const refundable = new Set([assessment.refund_amount, ...numbers(order?.refund_status ?? '', MONEY)]);
  bad(sentences.some(x => /refund/i.test(x) && numbers(x, MONEY).some(n => !refundable.has(n) && !NEGATED.test(x))), 'wrong refund amount');
  bad(anySentence(/\b(otp|cvv|card pin|password)\b/i, /\b(never|not|don't)\s+(ask|share|request|need)/i), 'asks for secrets');
  bad(anySentence(/\b(upi|ifsc|account number|bank details)\b/i, /\b(after|once)\b/i), 'asks for bank details early');
  bad(/(?![©®™])\p{Extended_Pictographic}/u.test(text), 'emoji');
  bad(!SIGN_OFF.test(text), 'missing sign-off');
  return problems;
}

// Brand voice, noted for the reviewer. Not a risk, so it does not send the email to a human by itself.
function styleNotes(draft) {
  const text = String(draft ?? '').trim();
  const greeting = /^(?:hi|hello|नमस्ते)\s+[^\n,.!]+[,.!]?\s*/i;
  const body = text.replace(SIGN_OFF, '').replace(greeting, '').replace(/https?:\S+/g, u => (u.endsWith('.') ? 'link.' : 'link'));
  const count = body.split(/(?<=[.!?।])\s+|\n+/).filter(s => s.trim()).length;
  return [!greeting.test(text) && 'no greeting by name', (count < 3 || count > 6) && `${count} sentences, brand voice asks for 3 to 6`].filter(Boolean);
}

// ---------- 7. Audit row ----------

function auditRow({ email, cls, resolved, decision, ticket, draft, draftProblems = [], style = [], promptVersion, processedAt, error = '' }) {
  const ticketText = ticket ? `${ticket.operation}_ticket` : null;
  const reasons = [...decision.human_reasons, ...draftProblems.map(p => `draft: ${p}`)];
  return {
    email_id: email.id, received_at: email.received_at, from_email: email.from.email, intent: cls.intent,
    secondary_intent: cls.secondary_intent ?? '', order_id: resolved.order_id ?? '', language: cls.language,
    sentiment: cls.sentiment, confidence: cls.confidence, order_found: resolved.access === 'match',
    action_taken: [decision.action, ticketText, reasons.length ? 'needs_human' : null].filter(Boolean).join(' + '),
    needs_human: reasons.length > 0 || Boolean(error), ticket_id: ticket?.row.ticket_id ?? '', reply_draft: draft ?? '',
    prompt_version: promptVersion, processed_at: processedAt, error: [...(cls.errors || []), error].filter(Boolean).join('; '),
    notes: [...reasons, ...style.map(s => `style: ${s}`)].join('; '),
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    normalizeEmail, parseClassification, resolveOrder, caseFacts, publicOrder, getOrderTool, searchFaq, daysSinceDelivery, assess, decide,
    findOpenTicket, ticketChange, checkDraft, styleNotes, auditRow,
  };
}
