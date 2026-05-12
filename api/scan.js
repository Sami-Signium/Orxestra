
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
  return true;
}

const LEADERSHIP_SYSTEM_PROMPT = `Du bist ein Executive Search Spezialist. Analysiere den Text einer Karriereseite und extrahiere NUR Leitungspositionen.

EINSCHLIESSEN:
- C-Level: CEO, CFO, COO, CTO, CHRO, CMO, CDO, CRO, CPO, CIO, CSO
- Geschaeftsfuehrung: Geschaeftsfuehrer/in, Managing Director, Generaldirektor, Vorstand
- Bereichsleitung: Head of [Bereich], Director, Vice President, Senior Vice President
- Abteilungsleitung: Leiter/in [Bereich] (bei Grossunternehmen)
- Country Manager, Regional Director, Market Lead
- General Counsel, Head of Strategy, Head of M&A
- Alle sonstigen Leitungsfunktionen mit Fuehrungsverantwortung

AUSSCHLIESSEN:
- Team Lead / Gruppenleiter (operative Ebene)
- Sachbearbeiter, Specialist, Analyst, Coordinator
- Junior, Trainee, Werkstudent, Praktikant
- Techniker, Meister, Fachkraft (ohne Leitungsfunktion)

Du bekommst den Seitentext UND eine Liste von Links (Text → URL) von der Karriereseite.
Versuche fuer jede gefundene Position den passenden direkten Link aus der Linkliste zuzuordnen.
Ein Link passt wenn der Linktext den Jobtitel enthaelt oder sehr aehnlich ist.

Antworte AUSSCHLIESSLICH mit einem JSON-Array. Kein Text davor oder danach. Keine Erklaerung. Keine Markdown.
Format: [{"title":"Positionstitel","department":"Bereich oder null","level":"C-Level|Geschaeftsfuehrung|Bereichsleitung|Abteilungsleitung|Sonstige Leitungsfunktion","job_url":"direkte URL zur Stelle oder null"}]
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
    if (action === 'get-job-description') return await getJobDescription(req, res);
    if (action === 'import-hr')           return await importHrContacts(req, res);
    return res.status(400).json({ error: 'Unbekannte action. Verfuegbar: find-urls, scan-one, scan-all, get-vacancies, get-targets, get-stats, test' });
  } catch (err) {
    console.error('[orxestra]', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── 1. Find Career URLs ───────────────────────────────────────────────────────
async function findCareerUrls(req, res) {
  const limit  = parseInt(req.query.limit  || '20');
  const offset = parseInt(req.query.offset || '0');

  const targets = await sbSelect('career_targets',
    `active=eq.true&order=priority.asc,company_name.asc&limit=${limit}&offset=${offset}`
  );

  const results = [];

  for (const target of targets) {
    try {
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

async function findJobsUrl(companyName, currentUrl) {
  const prompt = `Ich suche die direkte URL zur Stellenliste (Jobs/Karriere-Seite) von "${companyName}".
Aktuelle URL: ${currentUrl || 'unbekannt'}
Antworte NUR mit der direkten URL zur Stellenliste. Wenn keine bessere URL bekannt: UNCHANGED`;

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

// ── 2. Browserless Page Fetch — Text + Links ──────────────────────────────────
async function fetchWithBrowserless(pageUrl) {
  if (!BROWSERLESS_KEY) throw new Error('BROWSERLESS_KEY fehlt');

  const baseOrigin = (() => {
    try { return new URL(pageUrl).origin; } catch(e) { return ''; }
  })();

  const fn = `
    export default async function ({ page }) {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const u = req.url();
        if (u.includes('cookiebot.com') || u.includes('cookieconsent') || u.includes('consent.')) {
          req.abort();
        } else {
          req.continue();
        }
      });

      await page.goto('${pageUrl}', { waitUntil: 'networkidle2', timeout: 25000 });
      await new Promise(r => setTimeout(r, 3000));

      // Text extrahieren
      const bodyText = await page.evaluate(() => document.body?.innerText || '');

      // Links extrahieren: alle <a href> mit Text
      const links = await page.evaluate((baseOrigin) => {
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        const result = [];
        for (const a of anchors) {
          const text = (a.innerText || a.textContent || '').trim().replace(/\\s+/g, ' ');
          let href = a.getAttribute('href') || '';
          if (!href || href === '#' || href.startsWith('mailto:') || href.startsWith('javascript:')) continue;
          // Relative URLs zu absoluten machen
          if (href.startsWith('/')) href = baseOrigin + href;
          if (!href.startsWith('http')) continue;
          if (text && text.length > 2 && text.length < 200) {
            result.push({ text, href });
          }
        }
        // Duplikate entfernen
        const seen = new Set();
        return result.filter(l => {
          if (seen.has(l.href)) return false;
          seen.add(l.href);
          return true;
        }).slice(0, 300); // max 300 Links
      }, '${baseOrigin}');

      return { bodyText, links };
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
  const bodyText = data?.bodyText || data?.data?.bodyText || '';
  const links    = data?.links    || data?.data?.links    || [];

  if (!bodyText && !links.length) throw new Error('Browserless: leere Antwort');

  // Text kuerzen
  const trimmedText = bodyText
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 10000);

  // Links als lesbares Format fuer Claude aufbereiten
  const linksText = links.length > 0
    ? '\n\nVERFUEGBARE LINKS AUF DER SEITE:\n' +
      links.slice(0, 200).map(l => `- "${l.text}" → ${l.href}`).join('\n')
    : '';

  return trimmedText + linksText;
}

// ── 3. Claude Analyse ─────────────────────────────────────────────────────────
async function analyzeWithClaude(content, companyName, baseUrl) {
  const userPrompt = `Unternehmen: ${companyName}\nBasis-URL: ${baseUrl}\n\nKarriereseiteninhalt mit Links:\n${content}`;

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
    const pageContent = await fetchWithBrowserless(target.career_url);

    if (!pageContent || pageContent.length < 100) {
      return { target_id: target.id, company_name: target.company_name, status: 'skipped', error: 'Seite leer' };
    }

    const jobs = await analyzeWithClaude(pageContent, target.company_name, target.career_url);

    await sbUpdate('career_targets', `id=eq.${target.id}`, { last_scanned_at: new Date().toISOString() });

    if (!jobs.length) {
      return { target_id: target.id, company_name: target.company_name, status: 'no_jobs', vacancies_found: 0, content_length: pageContent.length };
    }

    const existing = await sbSelect('career_vacancies', `target_id=eq.${target.id}&is_active=eq.true`);
    const existingTitles = new Set(existing.map(e => e.job_title.toLowerCase().trim()));
    const foundTitles    = new Set(jobs.map(j => j.title.toLowerCase().trim()));

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
            job_url:       job.job_url    || null,  // null wenn kein direkter Link gefunden
            is_active:     true,
            first_seen_at: new Date().toISOString(),
            last_seen_at:  new Date().toISOString()
          });
          newCount++;
        } catch(e) { /* Duplikat ignorieren */ }
      } else {
        // Bestehende Vakanz: job_url updaten falls jetzt ein besserer Link gefunden wurde
        if (job.job_url) {
          await sbUpdate('career_vacancies',
            `target_id=eq.${target.id}&job_title=eq.${encodeURIComponent(job.title)}`,
            { last_seen_at: new Date().toISOString(), job_url: job.job_url }
          );
        } else {
          await sbUpdate('career_vacancies',
            `target_id=eq.${target.id}&job_title=eq.${encodeURIComponent(job.title)}`,
            { last_seen_at: new Date().toISOString() }
          );
        }
      }
    }

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
      content_length:   pageContent.length,
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
    await sleep(1000);
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
    total_targets:      targets.length,
    total_vacancies:    vacs.length,
    c_level:            vacs.filter(v => v.job_level === 'C-Level').length,
    geschaeftsfuehrung: vacs.filter(v => v.job_level === 'Geschaeftsfuehrung').length,
    vacancies_new_7d:   vacs.filter(v => daysSince(v.first_seen_at) <= 7).length,
    outreach_pending:   vacs.filter(v => !v.outreach_sent).length
  });
}

async function testBrowserless(req, res) {
  const url = req.query.url || 'https://karriere.viennaairport.com';
  try {
    const content = await fetchWithBrowserless(url);
    return res.json({ status: 'ok', content_length: content.length, preview: content.substring(0, 2000) });
  } catch(e) {
    return res.json({ status: 'error', error: e.message });
  }
}

// ── Browserless Fetch speziell fuer Job-Descriptions (8 Sek. Wartezeit) ──────
async function fetchJobPageSlow(pageUrl) {
  if (!BROWSERLESS_KEY) throw new Error('BROWSERLESS_KEY fehlt');

  const baseOrigin = (() => {
    try { return new URL(pageUrl).origin; } catch(e) { return ''; }
  })();

  const fn = `
    export default async function ({ page }) {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const u = req.url();
        if (u.includes('cookiebot.com') || u.includes('cookieconsent') || u.includes('consent.')) {
          req.abort();
        } else {
          req.continue();
        }
      });

      await page.goto('${pageUrl}', { waitUntil: 'networkidle2', timeout: 30000 });
      // 8 Sekunden warten damit JavaScript die Stellenbeschreibung vollstaendig laedt
      await new Promise(r => setTimeout(r, 8000));

      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      return { bodyText };
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

  if (!r.ok) throw new Error(`Browserless error ${r.status}`);
  const data = await r.json();
  const text = (data?.bodyText || data?.data?.bodyText || '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Browserless: leere Antwort');
  return text;
}

// ── Get Job Description (on demand) ──────────────────────────────────────────
async function getJobDescription(req, res) {
  const { vacancy_id, job_url } = req.method === 'POST' ? req.body : req.query;

  if (!job_url) return res.status(400).json({ error: 'job_url fehlt' });

  try {
    // Schritt 1: einfacher HTTP fetch (kostenlos, schnell)
    let text = '';
    try {
      const r = await fetch(job_url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(8000)
      });
      if (r.ok) {
        const html = await r.text();
        text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 8000);
      }
    } catch(e) { /* HTTP fetch fehlgeschlagen — Browserless als Fallback */ }

    // Schritt 2: Browserless als Fallback wenn Text zu kurz — mit 8 Sek. Wartezeit
    if (text.length < 200) {
      try {
        text = await fetchJobPageSlow(job_url);
      } catch(e) {
        return res.status(500).json({ error: 'Seite konnte nicht geladen werden: ' + e.message });
      }
    }

    // Schritt 3: Claude extrahiert strukturierte Stellenbeschreibung
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1500,
        system: `Du bist ein Executive Search Spezialist. Extrahiere aus dem Text einer Stellenausschreibung die wichtigsten Informationen strukturiert und praezise. Antworte auf Deutsch.`,
        messages: [{
          role: 'user',
          content: `Extrahiere aus dieser Stellenausschreibung folgende Informationen in strukturierter Form:

1. **Position & Level:** Titel, Reporting-Linie (an wen berichtet die Stelle?)
2. **Standort:** Stadt/Land
3. **Aufgaben:** Die 3-5 wichtigsten Verantwortungsbereiche (kurz, stichpunktartig)
4. **Anforderungen:** Die 3-5 wichtigsten gesuchten Qualifikationen
5. **Besonderheiten:** Gehalt, Besonderheiten, Startdatum falls erwaehnt
6. **Einschaetzung:** 2 Saetze — fuer welches Kandidatenprofil ist diese Stelle ideal?

Seitentext:
${text.substring(0, 6000)}`
        }]
      })
    });

    const data = await response.json();
    const description = (data.content?.[0]?.text || '').trim();

    // Optional: in Supabase speichern wenn vacancy_id vorhanden
    if (vacancy_id && description) {
      try {
        await sbUpdate('career_vacancies', `id=eq.${vacancy_id}`, {
          job_description: description,
          description_fetched_at: new Date().toISOString()
        });
      } catch(e) { /* Spalte existiert evtl. noch nicht — ignorieren */ }
    }

    return res.json({ description, source_length: text.length });

  } catch(err) {
    return res.status(500).json({ error: err.message });
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

// ── HR Contacts Import (einmalig) ─────────────────────────────────────────────
async function importHrContacts(req, res) {
  const HR_CONTACTS = [{"first_name": "Armin", "last_name": "Thalhammer", "company_name": "AVL List GmbH", "position": "VP Human Resources", "email": "", "city": "Graz", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Georg", "last_name": "Horacek", "company_name": "FACC AG", "position": "Leiter Personal", "email": "", "city": "Ried im Innkreis", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Berit", "last_name": "Buda", "company_name": "KTM AG", "position": "Leiter Personal", "email": "", "city": "Mattighofen", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Rudolf", "last_name": "Bernscheerer", "company_name": "Kapsch TrafficCom AG", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Christian", "last_name": "Zauner", "company_name": "Magna Powertrain GmbH & Co KG", "position": "Leiter Personal", "email": "", "city": "Lannach", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Erich", "last_name": "Mayer", "company_name": "Magna Steyr AG & Co KG", "position": "Leiter Personal", "email": "", "city": "Graz", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Hansjoerg", "last_name": "Tutner", "company_name": "ZKW Group", "position": "Group VP Human Resources", "email": "", "city": "Wieselburg", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Wolfgang", "last_name": "Schimpl", "company_name": "Allianz Österreich", "position": "HR Director", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "BAWAG Group AG", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Bitpanda GmbH", "position": "Head of People", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Sabine", "last_name": "Bothe", "company_name": "Erste Group Bank AG", "position": "Group Head of People & Culture (CHRO)", "email": "sabine.bothe@erstegroup.com", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Stefan", "last_name": "Lorenz", "company_name": "Generali Austria AG", "position": "HR Director Austria", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "PayLife Bank GmbH", "position": "HR Director", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Heike", "last_name": "Mensi-Klarbach", "company_name": "Raiffeisen Bank International", "position": "Head of Group People, Culture & Organisation", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Robert", "last_name": "Bilek", "company_name": "UNIQA Insurance Group AG", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Federico", "last_name": "Bedini", "company_name": "UniCredit Bank Austria AG", "position": "Head of CE & EE People & Culture", "email": "federico.bedini@unicreditgroup.eu", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Barbara", "last_name": "Hohl", "company_name": "Vienna Insurance Group (VIG)", "position": "Head of Human Resources Group", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Maria", "last_name": "Böhm", "company_name": "Baumit Wopfinger Baustoffind.", "position": "HR-Leiterin", "email": "", "city": "Wopfing", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Kurt", "last_name": "König", "company_name": "Doka Group", "position": "Leiter Personal", "email": "", "city": "Amstetten", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Martina", "last_name": "Auer-Klass", "company_name": "Porr AG", "position": "Head of Group Human Resources", "email": "auer-klass.martina@porr-group.com", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Thomas", "last_name": "Cerny", "company_name": "Strabag SE", "position": "Head of People & Culture Development", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Bartek", "last_name": "Cyganek", "company_name": "Wienerberger AG", "position": "Head of HR CEE", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Andrea", "last_name": "Linska", "company_name": "Boston Consulting Group Austria", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Johanna", "last_name": "Einsiedler", "company_name": "CMS Reich-Rohrwig Hainz", "position": "HR Manager", "email": "johanna.einsiedler@cms-rrh.com", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Cerha Hempel", "position": "HR Director", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Harald", "last_name": "Breit", "company_name": "Deloitte Austria", "position": "CEO Austria", "email": "hbreit@deloitte.at", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Eva", "last_name": "Maria Berchtold", "company_name": "EY Austria", "position": "Head of Strategy & Transactions", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Freshfields (Wien)", "position": "HR Manager", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Michael", "last_name": "Ahammer", "company_name": "KPMG Austria", "position": "Managing Director and Partner", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "McKinsey & Company Austria", "position": "HR Manager AT", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Rudolf", "last_name": "Krickl", "company_name": "PwC Austria", "position": "Territory Senior Partner & Chairman", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Roland Berger Austria", "position": "HR Manager AT", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Marguerita", "last_name": "Sedrati-Müller", "company_name": "Schoenherr Attorneys at Law", "position": "Director People & Culture", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Wolf Theiss", "position": "HR Director", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Stefan", "last_name": "Peter", "company_name": "EVN AG", "position": "HR Director", "email": "", "city": "Maria Enzersdorf", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Walter", "last_name": "Wurzinger", "company_name": "Energie AG Oberösterreich", "position": "Leiter Personal", "email": "", "city": "Linz", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Guntram", "last_name": "Aufinger", "company_name": "Energie Steiermark AG", "position": "Leiter Personal", "email": "", "city": "Graz", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Stefan", "last_name": "Doboczky", "company_name": "Lenzing AG", "position": "", "email": "", "city": "Lenzing", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Peter", "last_name": "Pirkner", "company_name": "OMV AG", "position": "SVP Head of Human Resources", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Martin", "last_name": "Kohlmayr", "company_name": "Verbund AG", "position": "HR Manager Recruiting & Employer Branding", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Beate", "last_name": "Pauer Zinggl", "company_name": "Wien Energie GmbH", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Wiener Krankenanstaltenverbund", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Georg", "last_name": "Nemeth", "company_name": "Agrana Beteiligungs-AG", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Barbara", "last_name": "Weber", "company_name": "BILLA AG", "position": "Leiter Personal", "email": "", "city": "Wr. Neudorf", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Kurt", "last_name": "König", "company_name": "Brau Union Österreich AG", "position": "Leiter Personal", "email": "", "city": "Linz", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Lisa", "last_name": "Lichtenegger", "company_name": "Julius Meinl", "position": "Global HR Director", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Johannes", "last_name": "Sobe", "company_name": "REWE Group Austria", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Lukas", "last_name": "Steinbach", "company_name": "Rauch Fruchtsäfte GmbH", "position": "Head of HR International", "email": "", "city": "Rankweil", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Stefan", "last_name": "Salzer", "company_name": "Red Bull GmbH", "position": "Global Head of HR", "email": "", "city": "Salzburg", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Kurt", "last_name": "Liedl", "company_name": "SPAR Österreich", "position": "Leiter Personal", "email": "", "city": "Salzburg", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Petra", "last_name": "Mathi Kogelnik", "company_name": "dm drogerie markt GmbH", "position": "Leiter Personal", "email": "", "city": "Salzburg", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Claudia", "last_name": "Höbart", "company_name": "CA Immo AG", "position": "Group Head of Human Resources", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Sonja", "last_name": "Steinmetz", "company_name": "Immofinanz AG", "position": "Deputy Head of Group HR", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "S IMMO AG", "position": "HR Director", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Petra", "last_name": "Pesendorfer", "company_name": "AMS OSRAM AG", "position": "VP HR Global", "email": "", "city": "Premstätten", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Hubert", "last_name": "Knafl", "company_name": "Andritz AG", "position": "Vice President Group HR", "email": "hubert.knafl@andritz.com", "city": "Graz", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Anton Paar GmbH", "position": "HR Director", "email": "", "city": "Graz", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Markus", "last_name": "Hämmerle", "company_name": "Blum GmbH", "position": "Leiter Personal", "email": "", "city": "Höchst", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Borealis AG", "position": "CHRO", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Michael", "last_name": "Grininger", "company_name": "Engel Austria GmbH", "position": "VP HR/Legal/Insurance", "email": "", "city": "Schwertberg", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Andrea", "last_name": "Pfaffenbauer", "company_name": "Greiner AG", "position": "Global People & Culture Director", "email": "", "city": "Kremsmünster", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Ingo", "last_name": "Spörk", "company_name": "KNAPP AG", "position": "Leiter Personal", "email": "", "city": "Hart bei Graz", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Bernhard", "last_name": "Reisner", "company_name": "Miba AG", "position": "Vice President Human Capital", "email": "", "city": "Laakirchen", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Gerald", "last_name": "Senn", "company_name": "Neveon GmbH", "position": "VP Global Human Resources", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Barbara", "last_name": "Reiner-Karabulut", "company_name": "RHI Magnesita N.V.", "position": "Head of People & Culture Europe C&E", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Waltraud", "last_name": "Kernler", "company_name": "SSI Schäfer Automation GmbH", "position": "Leiter Personal", "email": "", "city": "Graz", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Florian", "last_name": "Austerer", "company_name": "Semperit AG Holding", "position": "Director HR Operations Europe & Americas", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Christian", "last_name": "Nörpel", "company_name": "Teufelberger Holding AG", "position": "Global Head of Human Resources", "email": "", "city": "Wels", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Petra", "last_name": "Steiner", "company_name": "Zumtobel Group AG", "position": "SVP Global Human Resources", "email": "", "city": "Dornbirn", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Paul", "last_name": "Felsberger", "company_name": "voestalpine AG", "position": "Director Human Resources", "email": "", "city": "Linz", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Nathalie", "last_name": "Rau", "company_name": "Austrian Airlines AG", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Monika", "last_name": "Mandl", "company_name": "Gebrüder Weiss GmbH", "position": "Head Corporate HR Development", "email": "monika.mandl@gw-world.com", "city": "Lauterach", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Silvia", "last_name": "Angelo", "company_name": "ÖBB Holding AG", "position": "Arbeitsdirektorin", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Franz", "last_name": "Nigl", "company_name": "Österreichische Post AG", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Eva", "last_name": "Zehetner", "company_name": "A1 Telekom Austria Group", "position": "Head of Group HR", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Johannes", "last_name": "Sobe", "company_name": "Drei Austria GmbH", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Gabriel", "last_name": "Peter Szuhanek", "company_name": "Magenta Telekom", "position": "Vice President HR", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Gabriele", "last_name": "Birkner", "company_name": "ALPLA Group", "position": "Chief Human Resources Officer", "email": "", "city": "Hard", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Natalie", "last_name": "Knight", "company_name": "Coveris Group", "position": "Group HR Director", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Manfred", "last_name": "Huemer", "company_name": "Greiner Packaging", "position": "Leiter Personal", "email": "", "city": "Kremsmünster", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Petra", "last_name": "Pointinger", "company_name": "MM Group (Mayr-Melnhof)", "position": "Head of Group HR", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Bernhard", "last_name": "Wallner", "company_name": "Mondi Group", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Elisabeth", "last_name": "Tomaschko", "company_name": "Boehringer Ingelheim RCV", "position": "HR Director RCV", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Dunja", "last_name": "Mühlbacher", "company_name": "Fresenius Kabi Austria GmbH", "position": "Leiter Personal", "email": "", "city": "Graz", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Octapharma Pharmazeutika Produktionsgesmbh", "position": "Head of HR", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Sandoz GmbH (Novartis)", "position": "HR Director AT", "email": "", "city": "Kundl", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Sandra", "last_name": "Freudenthaler", "company_name": "Vamed AG", "position": "Head of HR", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Regina", "last_name": "Chiles", "company_name": "Dynatrace Austria GmbH", "position": "Leiter Personal", "email": "", "city": "Linz", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Christoph", "last_name": "Leitgeb", "company_name": "Frequentis AG", "position": "Head of HR", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Elisabeth", "last_name": "Engelbrechsmüller Strauß", "company_name": "Fronius International GmbH", "position": "Leiter Personal", "email": "", "city": "Wels", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Thomas", "last_name": "Reisinger", "company_name": "Infineon Technologies Austria", "position": "HR Director AT", "email": "", "city": "Villach", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Rudolf", "last_name": "Bernscheerer", "company_name": "Kapsch Group", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "NTT DATA Austria GmbH", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Nagarro SE", "position": "Head of HR Austria", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "TTTech Computertechnik AG", "position": "HR Director", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Blum-Novotest GmbH", "position": "HR Manager", "email": "", "city": "Bregenz", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Böhlerit GmbH & Co KG", "position": "HR Manager", "email": "", "city": "Kapfenberg", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Melecs EWS GmbH", "position": "HR Manager", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Ursula", "last_name": "Randolf", "company_name": "Hypo Vorarlberg Bank AG", "position": "Leiter Personal", "email": "", "city": "Bregenz", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Klarna Austria GmbH", "position": "HR Manager AT", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Nets Austria GmbH", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Sonja", "last_name": "Lahner", "company_name": "Geberit Vertriebs GmbH", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Vanessa", "last_name": "Kneissl", "company_name": "Liebherr-Werk Bischofshofen", "position": "Leiter Personal", "email": "", "city": "Bischofshofen", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Dorda Rechtsanwälte", "position": "HR Manager", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "AGES GmbH", "position": "HR Manager", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Markus", "last_name": "Tercl", "company_name": "Humanomed Holding GmbH", "position": "Leiter Personal", "email": "", "city": "Klagenfurt", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Martin", "last_name": "Gleitsmann", "company_name": "Vinzenz Gruppe", "position": "HR Director", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Christoph", "last_name": "Tauscher", "company_name": "OBI Austria", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "ARE Austrian Real Estate GmbH", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "UBM Development AG", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Warimpex Finanz- u. Beteiligungs AG", "position": "HR Manager", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Claire", "last_name": "Benedik", "company_name": "Schiebel GmbH", "position": "Head of Human Resources", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Sabine", "last_name": "Ringhofer-Luef", "company_name": "Schoeller-Bleckmann Oilfield Equipment AG", "position": "HR-Manager", "email": "", "city": "Ternitz", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Semperit Technische Produkte", "position": "HR Manager", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Gabriele", "last_name": "Theuerkauf", "company_name": "Welser Profile Austria GmbH", "position": "Leiter Personal", "email": "", "city": "Gresten", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Klaus", "last_name": "Wagner", "company_name": "Schenker & Co AG", "position": "HR Director AT", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Ingrid", "last_name": "Tutschek", "company_name": "ORF", "position": "Personalchef", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "ProSiebenSat.1 PULS 4 GmbH", "position": "HR Director AT", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Bernina International AG", "position": "HR Manager", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Birgit", "last_name": "Humer Altmann", "company_name": "Greiner Bio-One GmbH", "position": "Leiter Personal", "email": "", "city": "Kremsmünster", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Kwizda Holding GmbH", "position": "HR Director", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Bechtle Austria GmbH", "position": "HR Manager", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Contextflow GmbH", "position": "Head of People", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Barbara", "last_name": "Wimmer", "company_name": "Fabasoft AG", "position": "Head of HR", "email": "", "city": "Linz", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Inode IT-Solutions", "position": "HR Manager", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "Loxone Electronics GmbH", "position": "HR Manager", "email": "", "city": "Kollerschlag", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "", "last_name": "", "company_name": "SEC Consult", "position": "Leiter Personal", "email": "", "city": "Wien", "contact_type": "HR", "source": "Herold-Masterliste AT"}, {"first_name": "Heike", "last_name": "Mensi-Klarbach", "company_name": "Raiffeisen Bank International (RBI)", "position": "Head of Group People, Culture & Organisation", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Dr.", "last_name": "Sabine Bothe", "company_name": "Erste Group Bank", "position": "Group Head of People & Culture (CHRO)", "email": "sabine.bothe@erstegroup.com", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Federico", "last_name": "Bedini", "company_name": "UniCredit Bank Austria", "position": "Head of Central Europe & Eastern Europe People&Culture Strategic Partners - Senior Vice President", "email": "federico.bedini@unicreditgroup.eu", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Barbara", "last_name": "Hohl", "company_name": "Vienna Insurance Group (VIG)", "position": "Head of Human Resources (Group)", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Pierre", "last_name": "Bévierre", "company_name": "Coface Central Europe Holding", "position": "Group HR Director", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Elisabeth", "last_name": "Tomaschko", "company_name": "Boehringer Ingelheim RCV", "position": "HR Director, RCV", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Nazim", "last_name": "Ünlü", "company_name": "Novartis Austria/CEE", "position": "Global People & Organization Lead (HR)", "email": "", "city": "France", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Laura", "last_name": "L.", "company_name": "Novartis Austria/CEE", "position": "Head of People & Organization SERCE (Southern, Eastern, Russia and CE)", "email": "", "city": "Spain", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Frederic", "last_name": "Petito", "company_name": "Novartis Austria/CEE", "position": "Head of People & Organization, Europe", "email": "", "city": "Switzerland", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Katarina", "last_name": "Berger", "company_name": "Pfizer CEE", "position": "Human Resources Lead Switzerland & Austria (covers Austria)", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Birgit", "last_name": "Gießrigl", "company_name": "Roche Austria/CEE", "position": "People & Culture Business Partner Austria | Country Connector Austria (Diagnostics)", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Oliver", "last_name": "Coenenberg", "company_name": "Sanofi CEE", "position": "People Director Germany, Switzerland, Austria (Geschäftsführer)", "email": "", "city": "Germany", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Anita", "last_name": "Widmann", "company_name": "Sanofi CEE", "position": "Head of HR Austria", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Rita", "last_name": "Rajkovics", "company_name": "Sanofi CEE", "position": "Head of HR Hungary", "email": "", "city": "Hungary", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Roxana", "last_name": "Ciltea", "company_name": "Sanofi CEE", "position": "Head of HR Romania and Moldova", "email": "", "city": "Romania", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Tereza", "last_name": "Damborska", "company_name": "Takeda/Shire", "position": "Head of HR MCO Eastern Europe / HRBP", "email": "", "city": "Czech", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Angie", "last_name": "Mihalakis", "company_name": "Takeda/Shire", "position": "Head of Human Resources- Oncology Business Unit for Europe and Canada", "email": "", "city": "", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Christina", "last_name": "Mueller", "company_name": "Takeda/Shire", "position": "Head of HR for Europe & Canada", "email": "", "city": "", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Euan", "last_name": "Hosie", "company_name": "Takeda/Shire", "position": "Head of HR, Central & South Eastern Europe", "email": "", "city": "", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Tina", "last_name": "Thallinger", "company_name": "Henkel CEE", "position": "Head of HR Austria / CEE cluster", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Victoria", "last_name": "Klug", "company_name": "Beiersdorf CEE", "position": "HR Director Eastern Europe", "email": "victoria.klug@beiersdorf.com", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Nicola", "last_name": "Lafrentz", "company_name": "Beiersdorf CEE", "position": "Chief Human Resources Officer", "email": "", "city": "Germany", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Rodrigo", "last_name": "Delgado", "company_name": "Beiersdorf CEE", "position": "Senior Vice President Human Resources - Europe & North America", "email": "", "city": "Germany", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Barbara", "last_name": "Stohlmann", "company_name": "Mondelez CEE", "position": "Sr Director, People Lead DACH", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Anna", "last_name": "Krogulska", "company_name": "Mondelez CEE", "position": "People Experience Lead (HR Operations) Central and Eastern Europe", "email": "", "city": "Poland", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Plamena", "last_name": "Atanasova", "company_name": "Mondelez CEE", "position": "HR Operations (People Experience) Lead South Central Europe", "email": "", "city": "Bulgaria", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Agnieszka", "last_name": "Stołczyńska", "company_name": "Mondelez CEE", "position": "Director, People Lead Poland& Baltics", "email": "", "city": "Poland", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Nevyan", "last_name": "Petrov", "company_name": "Coca-Cola HBC Austria / CEE", "position": "Head of People and Culture, Region 2 (including CEE)", "email": "", "city": "Bulgaria", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Simona", "last_name": "Petre", "company_name": "Coca-Cola HBC Austria / CEE", "position": "Talent Acquistion & Identification Manager for Austria, Romania & Switzerland", "email": "", "city": "Romania", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Marketa", "last_name": "Pavelkova", "company_name": "Coca-Cola HBC Austria / CEE", "position": "Head of People & Culture, Region 1", "email": "", "city": "Czechia", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Irina", "last_name": "Firstova", "company_name": "Coca-Cola HBC Austria / CEE", "position": "Head of People and Culture, Region 3", "email": "", "city": "Romania", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Judith", "last_name": "Bejczy", "company_name": "Heineken CEE (Brau Union)", "position": "Senior Director People Europe", "email": "", "city": "Netherlands", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Merel", "last_name": "van Oosterhout", "company_name": "Heineken CEE (Brau Union)", "position": "People Director Europe (10 OpCo's)", "email": "", "city": "Netherlands", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Kurt", "last_name": "Herler", "company_name": "Heineken CEE (Brau Union)", "position": "Global Director People & Organisational Development", "email": "", "city": "Austria", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Peter", "last_name": "Zielonka", "company_name": "Heineken CEE (Brau Union)", "position": "Director People & Culture Brau Union Austria AG", "email": "", "city": "Austria", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Andrei", "last_name": "Pirvulescu", "company_name": "Red Bull GmbH", "position": "Regional HR Manager, Central & Eastern Europe", "email": "andrei-catalin.pirvulescu@redbull.com", "city": "Romania", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Diana", "last_name": "Budianu", "company_name": "Red Bull GmbH", "position": "Regional HR Business Partner CEE", "email": "", "city": "Romania", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Stefan", "last_name": "Salzer", "company_name": "Red Bull GmbH", "position": "Global Head of HR", "email": "", "city": "Austria", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Gemma", "last_name": "Prins", "company_name": "Red Bull GmbH", "position": "HR Director", "email": "", "city": "Netherlands", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Thomas", "last_name": "Degischer", "company_name": "Canon CEE", "position": "HR Director (Canon CEE)", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Gilka", "last_name": "Hennecart", "company_name": "Nikon CEE", "position": "HR Director Europe", "email": "", "city": "Belgium", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Thomas", "last_name": "Böck", "company_name": "Brother International CEE", "position": "HR Manager CEE", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Marketa", "last_name": "Pfleger", "company_name": "Samsung Electronics CEE", "position": "Head of HR Czech Republic & Slovakia", "email": "", "city": "Czehia", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Virgil", "last_name": "Enache", "company_name": "Samsung Electronics CEE", "position": "Head of HR Romania & Bulgaria", "email": "", "city": "Romania", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Katarzyna", "last_name": "Malak", "company_name": "Samsung Electronics CEE", "position": "HR Director", "email": "", "city": "Poland", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "ANNA", "last_name": "Cholewicka", "company_name": "LG Electronics CEE", "position": "Central Europe HR Head", "email": "", "city": "Poland", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Csaba", "last_name": "Stotzer", "company_name": "LG Electronics CEE", "position": "Head of Human Resources Central South Europe", "email": "", "city": "Hungary", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Giuseppe", "last_name": "Dallone", "company_name": "LG Electronics CEE", "position": "HR Director Europe Region", "email": "", "city": "Italy", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "TBD", "last_name": "– not publicly disclosed", "company_name": "Panasonic Eastern Europe", "position": "To be verified (regional HR lead)", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Hendrik", "last_name": "Damm", "company_name": "Mercedes-Benz CEE Hub", "position": "Head of HR Central and Eastern Europe", "email": "", "city": "Czechia", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Klára", "last_name": "Hidasi", "company_name": "BMW Austria / CEE", "position": "HR Manager Hungary, Romania, Slovenia and Bulgaria", "email": "", "city": "Hungary", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Natascha", "last_name": "T.", "company_name": "BMW Austria / CEE", "position": "Head of HR Management / HR Services at BMW Group Central and Southeastern Europe", "email": "", "city": "Austria", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Eva", "last_name": "Burgmeier", "company_name": "BMW Austria / CEE", "position": "Vice President Human Resources Region Europe", "email": "", "city": "Germany", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Hubert", "last_name": "Altschaeffl", "company_name": "MAN Truck & Bus CEE", "position": "Chief Human Resources Officer & Labor Director", "email": "", "city": "Germany", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Lina", "last_name": "Berndtsson", "company_name": "Kia Austria CEE", "position": "Director People and Organization Europe", "email": "", "city": "Germany", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Jang", "last_name": "Whan (Peter) Lee", "company_name": "Hyundai CEE", "position": "Head of People Europe", "email": "", "city": "Germany", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Liam", "last_name": "Williams", "company_name": "Hyundai CEE", "position": "Head of Talent Acquisition - Hyundai and Genesis", "email": "", "city": "Germany", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Massimo", "last_name": "Ruscio", "company_name": "Hyundai CEE", "position": "Director People & Organization", "email": "", "city": "Germany", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Sarah", "last_name": "Kreienbühl", "company_name": "Kuehne+Nagel East Europe", "position": "Chief Human Resources Officer (Global)", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Sebastian", "last_name": "Beinl", "company_name": "DHL Logistics (Vienna Airport)", "position": "Senior Director Human Resources", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Martin", "last_name": "Obermüller", "company_name": "DB Schenker CEE", "position": "Chief People Officer Cluster South East Europe", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Monika", "last_name": "Mandl", "company_name": "Gebrüder Weiss", "position": "Head Corporate HR Development", "email": "monika.mandl@gw-world.com", "city": "Austria", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Lora", "last_name": "Tasseva", "company_name": "ÖBB Rail Cargo Group", "position": "Head of Human Resources", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Peter", "last_name": "Pirkner", "company_name": "OMV AG", "position": "SVP, Head of Human Resources", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Martin", "last_name": "Kohlmayr", "company_name": "VERBUND AG", "position": "HR Manager Recruiting & Employer Branding", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Stefan", "last_name": "Peter", "company_name": "EVN AG", "position": "HR Director", "email": "", "city": "Austria", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Valentina", "last_name": "G.", "company_name": "Lukoil Lubricants Europe", "position": "Head of HR", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Mona", "last_name": "Ketf", "company_name": "STRABAG SE", "position": "HRM, People & Culture, Strategic HR Management CEE/SEE", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Martina", "last_name": "Auer-Klass", "company_name": "PORR AG", "position": "Executive Board Member, Head of Group Human Resources", "email": "auer-klass.martina@porr-group.com", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Hubert", "last_name": "Knafl", "company_name": "Andritz AG", "position": "Vice President Group HR", "email": "hubert.knafl@andritz.com", "city": "Graz", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Nadine", "last_name": "Schönthaler", "company_name": "GEA Service Europe - CEE", "position": "HR Country Manager Austria,Switzerland, Eastern Europe", "email": "nadine.schoenthaler@gea.com", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Olivera", "last_name": "Pesic", "company_name": "Microsoft CEE", "position": "Human Resource Manager CEE", "email": "", "city": "Serbia", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Renato", "last_name": "Mannozzi", "company_name": "IBM Austria/CEE", "position": "HR Director at IBM Northern, Central & Eastern Europe", "email": "", "city": "Milan", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Chetna", "last_name": "Singh", "company_name": "SAP CEE", "position": "Head of Human Resources  Europe,Middle East and Africa", "email": "", "city": "Germany", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Ladislav", "last_name": "Kucera", "company_name": "SAP CEE", "position": "Human Resources Director Czech Republic and Slovakia", "email": "", "city": "Czechia", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Tomáš", "last_name": "Tichý", "company_name": "Cisco CEE", "position": "HR Manager for CEE (Central and Eastern Europe)", "email": "", "city": "Czechia", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Darya", "last_name": "Dmytriyeva", "company_name": "Cisco CEE", "position": "People & Communities HR Senior Leader, Central Europe & CIS", "email": "", "city": "Portugal", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Sonja", "last_name": "Steinmetz", "company_name": "Immofinanz AG", "position": "Deputy Head of Group Human Resources", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "TBD", "last_name": "– not publicly disclosed", "company_name": "S IMMO AG", "position": "To be verified (regional HR lead)", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Claudia", "last_name": "Höbart", "company_name": "CA Immo", "position": "Group Head of Human Resources", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Zlata", "last_name": "Drbalova", "company_name": "PwC CEE", "position": "CEE Recruitment Operations Lead", "email": "", "city": "Czechia", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Dagmar", "last_name": "Vejvodová", "company_name": "PwC CEE", "position": "Human Resources Manager - Central & Eastern Europe", "email": "dagmar.vejvodova@pwc.com", "city": "Czechia", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Tamás", "last_name": "Zemlényi", "company_name": "Deloitte CEE", "position": "Human Resources Director South-East-Europe Cluster", "email": "tzemlenyi@deloitte.com", "city": "Hungary", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Katarzyna", "last_name": "Musialska", "company_name": "Deloitte CEE", "position": "Associate HR Manager - CE - Consulting Central Europe - Talent Team IT & Technology", "email": "kmusialska@deloitte.com", "city": "Poland", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Andrea", "last_name": "Draganovska", "company_name": "EY CEE", "position": "HR Senior Manager - CESA (Central, Eastern, Southeast Europe&Central Asia) Talent Consultant", "email": "", "city": "Slovakia", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Agnieszka", "last_name": "Dziewulska", "company_name": "KPMG CEE", "position": "Head of People, Poland and Central and Eastern Europe", "email": "", "city": "Poland", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Johanna", "last_name": "Einsiedler", "company_name": "CMS Reich-Rohrwig Hainz", "position": "HR Manager", "email": "johanna.einsiedler@cms-rrh.com", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Theresa", "last_name": "Neumann", "company_name": "CMS Reich-Rohrwig Hainz", "position": "HR Recruiting Manager", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Marguerita", "last_name": "Sedrati-Müller", "company_name": "Schoenherr Attorneys at Law", "position": "Director People & Culture", "email": "", "city": "Vienna", "contact_type": "HR", "source": "CEE CHROs Liste"}, {"first_name": "Sylvie", "last_name": "Lemonnier", "company_name": "International Paper / DS Smith", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Packaging"}, {"first_name": "Anne", "last_name": "Delahaye", "company_name": "Smurfit Westrock", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Packaging"}, {"first_name": "Claudia", "last_name": "von Reden", "company_name": "Mondi Group", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Packaging"}, {"first_name": "Sanna", "last_name": "Suvanto-Harsaae", "company_name": "Stora Enso", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Packaging"}, {"first_name": "Cynthia", "last_name": "McDougall", "company_name": "Amcor (inkl. Berry)", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Packaging"}, {"first_name": "Gabriele", "last_name": "Birkner", "company_name": "ALPLA Group", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Packaging"}, {"first_name": "Birgit", "last_name": "Herzer", "company_name": "Greiner Packaging", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Packaging"}, {"first_name": "Natalie", "last_name": "Knight", "company_name": "Coveris Group", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Packaging"}, {"first_name": "Monika", "last_name": "Rupp", "company_name": "Vetropack Group", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Packaging"}, {"first_name": "Brigitte", "last_name": "Ederer", "company_name": "Ardagh Group", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Packaging"}, {"first_name": "Ron", "last_name": "Lewis", "company_name": "Ball Corporation", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Packaging"}, {"first_name": "Tracy", "last_name": "Baxter", "company_name": "Crown Holdings", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Packaging"}, {"first_name": "Annette", "last_name": "Clayton", "company_name": "Tetra Pak", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Packaging"}, {"first_name": "Olivia", "last_name": "Fischer", "company_name": "MM Group", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Packaging"}, {"first_name": "Miriam", "last_name": "Sake (Group CHRO)", "company_name": "Heidelberg Materials", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Construction"}, {"first_name": "Miloš", "last_name": "Mirić (HR Europe)", "company_name": "Holcim", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Construction"}, {"first_name": "Audrey", "last_name": "Abcouwer (HR Europe)", "company_name": "CRH", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Construction"}, {"first_name": "Bartek", "last_name": "Cyganek (HR CEE)", "company_name": "Wienerberger", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Construction"}, {"first_name": "—", "last_name": "", "company_name": "Lasselsberger / Cemix", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Construction"}, {"first_name": "—", "last_name": "", "company_name": "Leier Group", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Construction"}, {"first_name": "Robert", "last_name": "Kudrna (HR EE)", "company_name": "Saint-Gobain", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Construction"}, {"first_name": "Tatiana", "last_name": "Orglerová (HR CEE)", "company_name": "Knauf Group", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Construction"}, {"first_name": "Thomas", "last_name": "Schobinger (HR EE)", "company_name": "Sika", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Construction"}, {"first_name": "Grace", "last_name": "Kelly (HR CEE BU)", "company_name": "Kingspan", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Construction"}, {"first_name": "—", "last_name": "", "company_name": "Buzzi Unicem", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Construction"}, {"first_name": "—", "last_name": "", "company_name": "Rohrdorfer Group", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Construction"}, {"first_name": "—", "last_name": "", "company_name": "Geberit", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Construction"}, {"first_name": "Maude", "last_name": "Ullrich (HR CEE)", "company_name": "BASF", "position": "CHRO / HR Lead CEE", "email": "", "city": "", "contact_type": "HR", "source": "Masterlist Construction"}];
  
  let inserted = 0;
  let skipped = 0;
  let errors = [];

  for (const contact of HR_CONTACTS) {
    try {
      await sbInsert('contacts', {
        first_name:   contact.first_name || null,
        last_name:    contact.last_name  || null,
        company_name: contact.company_name,
        position:     contact.position  || null,
        email:        contact.email     || null
      });
      inserted++;
    } catch(e) {
      if (e.message && e.message.includes('duplicate')) {
        skipped++;
      } else {
        errors.push(contact.company_name + ': ' + e.message);
      }
    }
  }

  return res.json({
    total: HR_CONTACTS.length,
    inserted,
    skipped,
    errors: errors.slice(0, 10)
  });
}
