// api/scan.js
// ORXESTRA Career Scanner v1
// Eigenstaendiger Career Intelligence Scanner fuer oesterreichische Grossunternehmen

const SUPABASE_URL         = 'https://ftdxhswcnghlmcagrsox.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_KEY;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const BROWSERLESS_KEY      = process.env.BROWSERLESS_KEY;
const SERPER_API_KEY       = process.env.SERPER_KEY;
const CLAUDE_MODEL         = 'claude-haiku-4-5-20251001';

// ── Supabase Helpers ──────────────────────────────────────────────────────────
async function sbSelect(table, params = '') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' }
  });
  if (!r.ok) throw new Error(`Supabase SELECT ${table}: ${await r.text()}`);
  return r.json();
}

async function sbInsert(table, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Supabase INSERT ${table}: ${await r.text()}`);
  return r.json();
}

async function sbUpsert(table, body, onConflict) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Supabase UPSERT ${table}: ${await r.text()}`);
  return r.json();
}

async function sbUpdate(table, filter, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Supabase UPDATE ${table}: ${await r.text()}`);
  return r.json();
}

// ── Leadership Filter Prompt ──────────────────────────────────────────────────
const LEADERSHIP_SYSTEM_PROMPT = `Du bist ein Executive Search Spezialist. Analysiere den Text einer Karriereseite und extrahiere NUR Leitungspositionen mit einem geschaetzten Jahresgehalt ueber EUR 125.000.

EINSCHLIESSEN:
- C-Level: CEO, CFO, COO, CTO, CHRO, CMO, CDO, CRO, CPO, CIO, CSO
- Geschaeftsfuehrer/in, Managing Director, Generaldirektor, Vorstand
- Bereichsleiter/in, Division Head, Head of [Bereich]
- Abteilungsleiter/in (nur bei grossen Unternehmen / strategischen Abteilungen)
- Country Manager, Regional Director, Market Lead
- Vice President, Senior Vice President
- General Counsel, Head of Strategy, Head of M&A

AUSSCHLIESSEN:
- Team Lead / Gruppenleiter (operative Ebene)
- Sachbearbeiter, Specialist, Analyst, Coordinator
- Junior, Trainee, Werkstudent, Praktikant
- Techniker, Meister, Fachkraft (ohne Leitungsfunktion)

Antworte AUSSCHLIESSLICH mit einem JSON-Array. Kein Text davor oder danach. Keine Erklaerung. Keine Markdown.
Format: [{"title":"Positionstitel","department":"Bereich oder null","level":"C-Level|Geschaeftsfuehrung|Bereichsleitung|Abteilungsleitung|Sonstige Leitungsfunktion","job_url":"URL oder null"}]
Wenn keine passenden Positionen: antworte mit []`;

// ── Main Handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    if (action === 'find-urls')      return await findCareerUrls(req, res);
    if (action === 'scan-one')       return await scanOneCompany(req, res);
    if (action === 'scan-all')       return await scanAllCompanies(req, res);
    if (action === 'get-vacancies')  return await getVacancies(req, res);
    if (action === 'get-targets')    return await getTargets(req, res);
    if (action === 'get-stats')      return await getStats(req, res);
    if (action === 'test')           return await testBrowserless(req, res);
    return res.status(400).json({ error: 'Unbekannte action. Verfuegbar: find-urls, scan-one, scan-all, get-vacancies, get-targets, get-stats, test' });
  } catch (err) {
    console.error('[orxestra]', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── 1. Find Career URLs ───────────────────────────────────────────────────────
// Findet automatisch die direkten Stellenlisten-URLs fuer alle Firmen
async function findCareerUrls(req, res) {
  const limit  = parseInt(req.query.limit  || '20');
  const offset = parseInt(req.query.offset || '0');

  // Nur Firmen ohne verifizierte career_url oder mit generischer URL
  const targets = await sbSelect('career_targets',
    `active=eq.true&order=priority.asc,company_name.asc&limit=${limit}&offset=${offset}`
  );

  const results = [];

  for (const target of targets) {
    try {
      // Web-Search nach direkter Stellenlisten-URL
      const searchQuery = `${target.company_name} Stellenangebote Karriere offene Stellen site:${extractDomain(target.career_url) || target.company_name.toLowerCase().replace(/\s/g, '') + '.at'}`;

      const url = await findJobsUrl(target.company_name, target.career_url);

      if (url && url !== target.career_url) {
        await sbUpdate('career_targets', `id=eq.${target.id}`, {
          career_url: url,
          updated_at: new Date().toISOString()
        });
        results.push({ id: target.id, company: target.company_name, old_url: target.career_url, new_url: url, status: 'updated' });
      } else {
        results.push({ id: target.id, company: target.company_name, url: target.career_url, status: 'unchanged' });
      }

      await sleep(300);
    } catch(e) {
      results.push({ id: target.id, company: target.company_name, status: 'error', error: e.message });
    }
  }

  return res.json({ processed: results.length, results });
}

// Findet die direkte Jobs-URL einer Firma via Claude
async function findJobsUrl(companyName, currentUrl) {
  const prompt = `Ich suche die direkte URL zur Stellenliste (Jobs/Karriere-Seite) von "${companyName}".

Aktuelle URL: ${currentUrl || 'unbekannt'}

Antworte NUR mit der direkten URL zur Stellenliste - also der Seite wo die aktuellen offenen Stellen aufgelistet sind, nicht die allgemeine Karriere-Hauptseite.
Wenn du keine bessere URL kennst als die aktuelle, antworte mit: UNCHANGED
Antworte nur mit der URL oder UNCHANGED - kein anderer Text.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  const text = (data.content?.[0]?.text || '').trim();

  if (text === 'UNCHANGED' || !text.startsWith('http')) return null;
  return text;
}

// ── 2. Browserless Page Fetch mit Cookie-Accept ───────────────────────────────
async function fetchWithBrowserless(url) {
  if (!BROWSERLESS_KEY) throw new Error('BROWSERLESS_KEY fehlt');

  // Browserless /function endpoint - fuehrt JavaScript aus und gibt Text zurueck
  const fn = `
    export default async function ({ page }) {
      await page.goto('${url}', { waitUntil: 'networkidle2', timeout: 25000 });

      // Cookie-Banner akzeptieren - funktioniert auf den meisten AT/EU Seiten
      const cookieSelectors = [
        'button[id*="accept"]', 'button[class*="accept"]',
        'button[id*="agree"]', 'button[class*="agree"]',
        'button[id*="consent"]', 'button[class*="consent"]',
        'button[id*="cookie"]', 'button[class*="cookie"]',
        'button[data-testid*="accept"]',
        '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
        '.cookie-accept', '.accept-cookies', '.btn-accept',
        '[aria-label*="Accept"]', '[aria-label*="Akzeptieren"]',
        '[aria-label*="Zustimmen"]', '[aria-label*="Alle akzeptieren"]'
      ];

      for (const selector of cookieSelectors) {
        try {
          const btn = await page.$(selector);
          if (btn) {
            await btn.click();
            await page.waitForTimeout(1500);
            break;
          }
        } catch(e) {}
      }

      // Warte auf Inhalt
      await page.waitForTimeout(3000);

      const html = await page.content();
      return { html };
    }
  `;

  const r = await fetch(
    `https://production-sfo.browserless.io/function?token=${BROWSERLESS_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: fn, context: {} })
    }
  );

  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Browserless error ${r.status}: ${err.substring(0, 200)}`);
  }

  const data = await r.json();
  const html = data?.html || data?.data?.html || '';

  if (!html) throw new Error('Browserless: leere Antwort');

  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 6000);

  return text;
}

// ── 3. Claude Analyse ─────────────────────────────────────────────────────────
async function analyzeWithClaude(content, companyName, baseUrl) {
  const userPrompt = `Unternehmen: ${companyName}\nBasis-URL: ${baseUrl}\n\nKarriereseiteninhalt:\n${content}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: LEADERSHIP_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!response.ok) throw new Error(`Claude API ${response.status}: ${await response.text()}`);

  const data = await response.json();
  const rawText = (data.content?.[0]?.text || '').trim();

  if (!rawText) throw new Error('Claude: leere Antwort');

  try {
    return JSON.parse(rawText);
  } catch {
    const match = rawText.match(/\[[\s\S]*\]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { }
    }
    throw new Error(`Claude JSON parse failed: "${rawText.substring(0, 200)}"`);
  }
}

// ── 4. Core Scan ──────────────────────────────────────────────────────────────
async function scanTarget(target) {
  const startTime = Date.now();

  if (!target.career_url) {
    return { target_id: target.id, company_name: target.company_name, status: 'skipped', error: 'Keine career_url' };
  }

  try {
    // Seite mit Browserless laden (inkl. Cookie-Accept)
    const pageText = await fetchWithBrowserless(target.career_url);

    if (!pageText || pageText.length < 100) {
      return { target_id: target.id, company_name: target.company_name, status: 'skipped', error: 'Seite leer' };
    }

    // Claude analysiert den Text
    const jobs = await analyzeWithClaude(pageText, target.company_name, target.career_url);

    // Last scanned aktualisieren
    await sbUpdate('career_targets', `id=eq.${target.id}`, { last_scanned_at: new Date().toISOString() });

    if (!jobs.length) {
      return { target_id: target.id, company_name: target.company_name, status: 'no_jobs', vacancies_found: 0, text_length: pageText.length };
    }

    // Bestehende Vakanzen laden
    const existing = await sbSelect('career_vacancies', `target_id=eq.${target.id}&is_active=eq.true`);
    const existingTitles = new Set(existing.map(e => e.job_title.toLowerCase().trim()));
    const foundTitles    = new Set(jobs.map(j => j.title.toLowerCase().trim()));

    // Neue einfuegen
    let newCount = 0;
    for (const job of jobs) {
      if (!existingTitles.has(job.title.toLowerCase().trim())) {
        try {
          await sbInsert('career_vacancies', {
            target_id:     target.id,
            company_name:  target.company_name,
            job_title:     job.title,
            department:    job.department || null,
            job_level:     job.level      || null,
            job_url:       job.job_url    || target.career_url,
            is_active:     true,
            first_seen_at: new Date().toISOString(),
            last_seen_at:  new Date().toISOString()
          });
          newCount++;
        } catch(e) { /* Duplikat ignorieren */ }
      } else {
        await sbUpdate('career_vacancies',
          `target_id=eq.${target.id}&job_title=eq.${encodeURIComponent(job.title)}`,
          { last_seen_at: new Date().toISOString() }
        );
      }
    }

    // Verschwundene als besetzt markieren
    let filledCount = 0;
    for (const ex of existing) {
      if (!foundTitles.has(ex.job_title.toLowerCase().trim())) {
        await sbUpdate('career_vacancies', `id=eq.${ex.id}`, { is_active: false, filled_at: new Date().toISOString() });
        filledCount++;
      }
    }

    return {
      target_id:        target.id,
      company_name:     target.company_name,
      status:           'success',
      vacancies_found:  jobs.length,
      new_vacancies:    newCount,
      filled_vacancies: filledCount,
      text_length:      pageText.length,
      jobs,
      duration_ms:      Date.now() - startTime
    };

  } catch (err) {
    return { target_id: target.id, company_name: target.company_name, status: 'error', error: err.message, duration_ms: Date.now() - startTime };
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function scanOneCompany(req, res) {
  const { target_id } = req.method === 'POST' ? req.body : req.query;
  if (!target_id) return res.status(400).json({ error: 'target_id fehlt' });
  const rows = await sbSelect('career_targets', `id=eq.${target_id}`);
  if (!rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
  return res.json(await scanTarget(rows[0]));
}

async function scanAllCompanies(req, res) {
  const limit    = parseInt(req.query.limit    || '5');
  const offset   = parseInt(req.query.offset   || '0');
  const priority = req.query.priority;

  let params = `active=eq.true&career_url=neq.&order=priority.asc,last_scanned_at.asc.nullsfirst&limit=${limit}&offset=${offset}`;
  if (priority) params += `&priority=eq.${priority}`;

  const targets = await sbSelect('career_targets', params);
  const results = [];

  for (const target of targets) {
    results.push(await scanTarget(target));
    await sleep(1000); // 1 Sekunde zwischen Requests
  }

  return res.json({
    total_scanned:       results.length,
    success:             results.filter(r => r.status === 'success').length,
    no_jobs:             results.filter(r => r.status === 'no_jobs').length,
    errors:              results.filter(r => r.status === 'error').length,
    total_new_vacancies: results.reduce((s, r) => s + (r.new_vacancies || 0), 0),
    results
  });
}

async function getVacancies(req, res) {
  const { min_days = 0, level, limit = 200 } = req.query;
  let params = `is_active=eq.true&order=first_seen_at.desc&limit=${limit}`;
  if (level) params += `&job_level=eq.${encodeURIComponent(level)}`;
  if (parseInt(min_days) > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - parseInt(min_days));
    params += `&first_seen_at=lte.${cutoff.toISOString()}`;
  }
  const vacancies = await sbSelect('career_vacancies', params);
  return res.json({ vacancies, count: vacancies.length });
}

async function getTargets(req, res) {
  const { priority, country } = req.query;
  let params = `active=eq.true&order=priority.asc,company_name.asc&limit=200`;
  if (priority) params += `&priority=eq.${priority}`;
  if (country)  params += `&country=eq.${country}`;
  const targets = await sbSelect('career_targets', params);
  return res.json({ targets, count: targets.length });
}

async function getStats(req, res) {
  const [targets, vacancies] = await Promise.all([
    sbSelect('career_targets',  'active=eq.true&select=id,priority'),
    sbSelect('career_vacancies','is_active=eq.true&select=id,job_level,first_seen_at,outreach_sent')
  ]);
  const vacs = vacancies || [];
  return res.json({
    total_targets:    targets.length,
    total_vacancies:  vacs.length,
    c_level:          vacs.filter(v => v.job_level === 'C-Level').length,
    geschaeftsfuehrung: vacs.filter(v => v.job_level === 'Geschaeftsfuehrung').length,
    vacancies_new_7d: vacs.filter(v => daysSince(v.first_seen_at) <= 7).length,
    outreach_pending: vacs.filter(v => !v.outreach_sent).length
  });
}

async function testBrowserless(req, res) {
  const url = req.query.url || 'https://karriere.viennaairport.com';
  try {
    const text = await fetchWithBrowserless(url);
    return res.json({ status: 'ok', text_length: text.length, preview: text.substring(0, 1000) });
  } catch(e) {
    return res.json({ status: 'error', error: e.message });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function daysSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch { return null; }
}
