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

    // Schritt 2: Browserless als Fallback wenn Text zu kurz
    if (text.length < 200) {
      try {
        text = await fetchWithBrowserless(job_url);
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
