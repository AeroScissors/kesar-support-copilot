// Builds the importable n8n workflow from rules.js and prompts/, so the logic lives in one place.
// Run: node code/build_workflow.js v2            -> workflow/kesar-support-copilot.v2.json
// The v1 file is kept as it was when tested; rebuilding it would mix in the v2 rules.
//      node code/build_workflow.js v1 --mock E01 -> scratch workflow with no Gemini/Sheets, for testing in n8n
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const version = process.argv[2] || 'v1';
const mock = process.argv[3] === '--mock';
const scratchTabs = version === 'v1' || process.argv.includes('--test-tabs'); // keeps trial runs out of the final tabs
const RULES = fs.readFileSync(path.join(__dirname, 'rules.js'), 'utf8').split("if (typeof module !== 'undefined')")[0];
const prompt = n => fs.readFileSync(path.join(root, `prompts/${n}.${version}.md`), 'utf8').trim();
const RAW = 'https://raw.githubusercontent.com/abhishek-patel-cadient/kesar-ai-copilot-assignment/refs/heads/main/data';
const MIRROR = 'https://cdn.jsdelivr.net/gh/abhishek-patel-cadient/kesar-ai-copilot-assignment@main/data'; // same files, used when GitHub cannot be reached

const TICKET_COLS = 'ticket_id,created_at,updated_at,order_id,customer_email,email_ids,intent,priority,status,summary,notes'.split(',');
const AUDIT_COLS = 'email_id,received_at,from_email,intent,secondary_intent,order_id,language,sentiment,confidence,order_found,action_taken,needs_human,ticket_id,reply_draft,prompt_version,processed_at,error,notes'.split(',');

const nodes = [];
const connections = {};
function node(name, type, typeVersion, position, parameters, extra = {}) {
  nodes.push({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, type, typeVersion, position, parameters, ...extra });
}
function link(from, to, output = 0, kind = 'main') {
  const outs = ((connections[from] ??= {})[kind] ??= []);
  while (outs.length <= output) outs.push([]);
  outs[output].push({ node: to, type: kind, index: 0 });
}
const code = (name, pos, body, withRules = true) =>
  node(name, 'n8n-nodes-base.code', 2, pos, { jsCode: `${withRules ? `${RULES}\n// ---------- node ----------\n` : ''}${body}` });
const retry = { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 };
const gemini = (name, pos, model, temperature) => node(name, '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', 1, pos,
  { modelName: `models/${model}`, options: { temperature } });
const cond = (leftValue, operator, rightValue = '') => ({
  conditions: [{ id: 'c1', leftValue, rightValue, operator }], combinator: 'and',
  options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
});
const isTrue = { type: 'boolean', operation: 'true', singleValue: true };
const equals = { type: 'string', operation: 'equals' };
const cfg = f => `={{ $('Config').first().json.${f} }}`;
// Appends are never retried (a repeat could duplicate the row). n8n also retries any output that has an "error" field,
// which the audit row always has. Reads and the audit write stop the run on failure; ticket writes carry on so the audit row records it.
function sheet(name, pos, tab, operation, cols, source, extra) {
  const parameters = {
    authentication: 'serviceAccount', operation,
    documentId: { __rl: true, mode: 'url', value: cfg('sheet_url') },
    sheetName: { __rl: true, mode: 'name', value: cfg(tab) },
    options: cols ? { cellFormat: 'RAW' } : {}, // RAW: text like "=..." from a customer is never run as a formula
  };
  if (cols) {
    parameters.columns = {
      mappingMode: 'defineBelow', matchingColumns: operation === 'update' ? ['ticket_id'] : [],
      value: Object.fromEntries(cols.map(c => [c, `={{ ${source}.${c} }}`])),
      schema: cols.map(c => ({ id: c, displayName: c, required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true })),
    };
  }
  node(name, 'n8n-nodes-base.googleSheets', 4.5, pos, parameters, extra);
}

// ---------- input ----------
node('Webhook', 'n8n-nodes-base.webhook', 2, [0, 300], { httpMethod: 'POST', path: 'support-email', responseMode: 'lastNode', options: {} },
  { webhookId: 'kesar-support-email' });
node('Config', 'n8n-nodes-base.set', 3.4, [200, 300], {
  assignments: {
    assignments: [['sheet_url', 'https://docs.google.com/spreadsheets/d/1g1en2_Pjmt4jjtV_yRW6PCQKstr42VVEfqqz_yhuxDk/edit'], ['prompt_version', version],
      ['audit_tab', scratchTabs ? 'Audit Log v1' : 'Audit Log'], ['tickets_tab', scratchTabs ? 'Tickets v1' : 'Tickets']]
      .map(([name, value]) => ({ id: name, name, value, type: 'string' })),
  }, options: {},
});
code('Read Email', [400, 300], "return [{ json: normalizeEmail($('Webhook').first().json.body) }];");
const http = (name, pos, url, response, extra) => node(name, 'n8n-nodes-base.httpRequest', 4.2, pos,
  { url, options: { timeout: 8000, response: { response } } }, { executeOnce: true, ...extra });
const asJson = { responseFormat: 'json' };
const asText = { responseFormat: 'text', outputPropertyName: 'data' };
http('Get Orders', [560, 300], `${RAW}/orders.json`, asJson, { onError: 'continueErrorOutput' });
http('Get Orders Backup', [640, 480], `${MIRROR}/orders.json`, asJson, retry);
http('Get FAQ', [740, 300], `${RAW}/faq.md`, asText, { onError: 'continueErrorOutput' });
http('Get FAQ Backup', [820, 480], `${MIRROR}/faq.md`, asText, retry);
code('Load Data', [920, 300], `const from = (main, backup) => { try { return $(backup).first().json; } catch { return $(main).first().json; } };
const { orders } = from('Get Orders', 'Get Orders Backup');
const faq = from('Get FAQ', 'Get FAQ Backup').data;
if (!Array.isArray(orders) || !orders.length || !String(faq ?? '').includes('## ')) throw new Error('Order or FAQ data could not be loaded');
return [{ json: { orders, faq } }];`, false);
sheet('Read Tickets', [1080, 300], 'tickets_tab', 'read', null, null, { ...retry, alwaysOutputData: true });

// ---------- classify ----------
const classifier = (name, pos, text) => node(name, '@n8n/n8n-nodes-langchain.chainLlm', 1.5, pos, {
  promptType: 'define', text, messages: { messageValues: [{ message: prompt('classify') }] },
}, { ...retry, onError: 'continueRegularOutput', executeOnce: true });
classifier('Classify', [1200, 300], "={{ JSON.stringify($('Read Email').first().json) }}");
code('Check JSON', [1500, 300], "const raw = $input.first().json;\nreturn [{ json: { cls: parseClassification(raw.text ?? raw.output ?? ''), raw } }];");
node('Valid JSON?', 'n8n-nodes-base.if', 2.2, [1700, 300], { conditions: cond('={{ $json.cls.valid }}', isTrue), options: {} });
classifier('Classify Again', [1900, 480],
  "={{ 'Your last answer was rejected: ' + $('Check JSON').first().json.cls.errors.join(', ') + '. Return only the corrected JSON object for this email: ' + JSON.stringify($('Read Email').first().json) }}");
code('Check JSON Again', [2200, 480], "const raw = $input.first().json;\nreturn [{ json: { cls: parseClassification(raw.text ?? raw.output ?? ''), raw } }];");
gemini('Gemini Classifier', [1300, 560], 'gemini-3.5-flash-lite', 0);
gemini('Gemini Backup', [1900, 660], 'gemini-3.1-flash-lite', 0); // a different model, so one overloaded model cannot block both tries

// ---------- decide ----------
code('Decide', [2420, 300], `const email = $('Read Email').first().json;
const cls = $input.first().json.cls;
const orders = $('Load Data').first().json.orders;
const rows = $('Read Tickets').all().map(i => i.json);
const resolved = resolveOrder(email, cls, orders);
const assessment = assess(email, cls, resolved.order);
const decision = decide(email, cls, resolved, assessment);
const ticket = ticketChange(email, cls, resolved, decision, rows.filter(r => r.ticket_id));
return [{ json: {
  email, cls, resolved, assessment, decision, ticket, error: '',
  first_try_valid: $('Check JSON').first().json.cls.valid,
  case_facts: caseFacts(resolved, assessment, decision),
} }];`);
node('Route by Intent', 'n8n-nodes-base.switch', 3.2, [2640, 300], {
  rules: { values: ['order_status', 'product_query', 'return_refund', 'complaint', 'other'].map(i => ({
    conditions: cond('={{ $json.cls.intent }}', equals, i), renameOutput: true, outputKey: i })) },
  options: {},
});
node('Reply Needed?', 'n8n-nodes-base.if', 2.2, [2860, 520], { conditions: cond('={{ $json.decision.action }}', equals, 'draft_reply'), options: {} });

// ---------- agent ----------
node('Draft Reply', '@n8n/n8n-nodes-langchain.agent', 2, [3100, 260], {
  promptType: 'define',
  text: "={{ JSON.stringify({ email: $json.email, language: $json.cls.language, intent: $json.cls.intent, summary: $json.cls.summary, case_facts: $json.case_facts }) }}",
  options: { systemMessage: prompt('agent'), maxIterations: 6 },
}, { ...retry, onError: 'continueRegularOutput' });
gemini('Gemini Agent', [3020, 500], 'gemini-3.5-flash-lite', 0.2);
const tool = (name, pos, description, arg, argHelp, body) => node(name, '@n8n/n8n-nodes-langchain.toolCode', 1.2, pos, {
  description, language: 'javaScript', jsCode: `${RULES}\n// ---------- tool ----------\n${body}`, specifyInputSchema: true, schemaType: 'manual',
  inputSchema: JSON.stringify({ type: 'object', properties: { [arg]: { type: 'string', description: argHelp } }, required: [arg] }),
});
tool('get_order', [3180, 500], 'Look up the order belonging to the sender of this email. Returns status, items, amounts, dates and tracking link, or an error if nothing can be shared.',
  'order_id', 'Order ID such as KC-1041, or an empty string if the email has none',
  "const asked = query && typeof query === 'object' ? query.order_id : query;\nreturn JSON.stringify(getOrderTool(asked, $('Decide').first().json.resolved));");
tool('search_faq', [3340, 500], 'Search Kesar & Co. policies and product facts. Always search in English.',
  'question', 'What to look up, in English',
  "const q = query && typeof query === 'object' ? query.question : query;\nreturn searchFaq(q, $('Load Data').first().json.faq);");

// ---------- finish ----------
code('Check Draft', [3520, 300], `const c = $('Decide').first().json;
const out = $input.first().json;
const wanted = c.decision.action === 'draft_reply';
const draft = wanted ? String(out.output ?? '').trim() : '';
const agentError = wanted && out.error ? 'Draft Reply: ' + JSON.stringify(out.error) : '';
const draftProblems = !wanted ? [] : !draft ? ['no draft was written']
  : checkDraft(draft, { email: c.email, order: c.resolved.order, assessment: c.assessment, faq: $('Load Data').first().json.faq, needsHuman: c.decision.needs_human, access: c.resolved.access });
return [{ json: { ...c, draft, draftProblems, style: draft ? styleNotes(draft) : [], error: [c.error, agentError].filter(Boolean).join('; ') } }];`);
node('Ticket Action', 'n8n-nodes-base.switch', 3.2, [3740, 300], {
  rules: { values: ['create', 'update'].map(o => ({ conditions: cond("={{ $json.ticket ? $json.ticket.operation : '' }}", equals, o), renameOutput: true, outputKey: o })) },
  options: { fallbackOutput: 'extra' },
});
sheet('Create Ticket', [3960, 140], 'tickets_tab', 'append', TICKET_COLS, '$json.ticket.row', { onError: 'continueRegularOutput' });
sheet('Update Ticket', [3960, 300], 'tickets_tab', 'update', TICKET_COLS, '$json.ticket.row', { ...retry, onError: 'continueRegularOutput' });
code('Audit Row', [4180, 300], `const c = $('Check Draft').first().json;
const written = $input.first().json;
const wrote = ['create', 'update'].includes(c.ticket?.operation);
const ticketError = wrote && written.ticket_id !== c.ticket.row.ticket_id ? 'Ticket not written: ' + JSON.stringify(written.error || 'unknown reason') : '';
return [{ json: auditRow({ ...c, promptVersion: $('Config').first().json.prompt_version, processedAt: new Date().toISOString(),
  error: [c.error, ticketError].filter(Boolean).join('; ') }) }];`);
sheet('Log to Audit', [4400, 300], 'audit_tab', 'append', AUDIT_COLS, '$json', {});

['Webhook', 'Config', 'Read Email', 'Get Orders', 'Get FAQ', 'Load Data', 'Read Tickets', 'Classify', 'Check JSON', 'Valid JSON?', 'Decide', 'Route by Intent']
  .reduce((a, b) => (link(a, b), b));
link('Get Orders', 'Get Orders Backup', 1); link('Get Orders Backup', 'Get FAQ');
link('Get FAQ', 'Get FAQ Backup', 1); link('Get FAQ Backup', 'Load Data');
link('Valid JSON?', 'Classify Again', 1); link('Classify Again', 'Check JSON Again'); link('Check JSON Again', 'Decide');
[0, 1, 2, 3].forEach(i => link('Route by Intent', 'Draft Reply', i));
link('Route by Intent', 'Reply Needed?', 4);
link('Reply Needed?', 'Draft Reply', 0); link('Reply Needed?', 'Check Draft', 1);
link('Draft Reply', 'Check Draft'); link('Check Draft', 'Ticket Action');
link('Ticket Action', 'Create Ticket', 0); link('Ticket Action', 'Update Ticket', 1); link('Ticket Action', 'Audit Row', 2);
link('Create Ticket', 'Audit Row'); link('Update Ticket', 'Audit Row'); link('Audit Row', 'Log to Audit');
link('Gemini Classifier', 'Classify', 0, 'ai_languageModel');
link('Gemini Backup', 'Classify Again', 0, 'ai_languageModel');
link('Gemini Agent', 'Draft Reply', 0, 'ai_languageModel');
['get_order', 'search_faq'].forEach(n => link(n, 'Draft Reply', 0, 'ai_tool'));

const workflow = { id: `kesarCopilot${version}`, name: `Kesar Support Copilot ${version}`, nodes, connections, active: false, settings: { executionOrder: 'v1', timezone: 'Asia/Kolkata' } };

if (mock) {
  const id = process.argv[4];
  const data = path.join(root, '../kesar-ai-copilot-assignment-main/data/test_emails.json');
  const email = JSON.parse(fs.readFileSync(data, 'utf8')).emails.find(e => e.id === id);
  const cls = { intent: 'return_refund', secondary_intent: null, order_id: null, sentiment: 'neutral', language: 'en', confidence: 0.9, summary: 'mock', issue_type: 'changed_mind', item_condition: 'unopened', items_mentioned: ['Rose Water Toner'], needs_answer: true, health_concern: false };
  const fake = { Webhook: { body: email }, 'Read Tickets': {}, Classify: { text: JSON.stringify(cls) }, 'Classify Again': { text: 'bad' }, 'Draft Reply': { output: 'Hi,\n\nThanks, a free pickup will be arranged.\n\nWarm regards,\nTeam Kesar' }, 'Create Ticket': {}, 'Update Ticket': {} };
  workflow.nodes = nodes.filter(n => !/lmChat|toolCode/.test(n.type) && n.name !== 'Log to Audit')
    .map(n => (fake[n.name] ? { ...n, type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode: `return [{ json: ${JSON.stringify(fake[n.name])} }];` }, onError: undefined, webhookId: undefined } : n));
  workflow.nodes.unshift({ id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [-200, 300], parameters: {} });
  connections.Start = { main: [[{ node: 'Webhook', type: 'main', index: 0 }]] };
  ['Gemini Classifier', 'Gemini Agent', 'get_order', 'search_faq'].forEach(n => delete connections[n]);
  connections['Audit Row'] = {};
  Object.assign(workflow, { id: 'kesarMock', name: 'Kesar mock' });
  process.stdout.write(JSON.stringify(workflow));
} else {
  fs.mkdirSync(path.join(root, 'workflow'), { recursive: true });
  const out = path.join(root, `workflow/kesar-support-copilot.${version}.json`);
  fs.writeFileSync(out, JSON.stringify(workflow, null, 2));
  console.log(`${out}: ${nodes.length} nodes`);
}
