#!/usr/bin/env node
/*
 * Scans Nexus Mods for No Man's Sky mods that are new
 */

const { readFile, writeFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');

const API_KEY = process.env.NEXUS_API_KEY;
const MOD_WARNINGS_PATH = process.env.MOD_WARNINGS_PATH || 'mod_warnings.json';
const BLACKLIST_PATH = process.env.BLACKLIST_PATH || 'mod_blacklist.json';
const PERIOD = process.env.PERIOD || '1m'; // 1d | 1w | 1m
const GAME_DOMAIN = process.env.GAME_DOMAIN || 'nomanssky';
const DETAIL_FETCH_DELAY_MS = 300;

const PERIOD_SECONDS = { '1d': 86400, '1w': 7 * 86400, '1m': 31 * 86400 };
const HIDDEN_STATUSES = new Set(['not_published', 'hidden', 'removed', 'wastebinned', 'under_moderation']);

const UPDATED_URL = `https://api.nexusmods.com/v1/games/${GAME_DOMAIN}/mods/updated.json?period=${PERIOD}`;
const MOD_DETAIL_URL = (id) => `https://api.nexusmods.com/v1/games/${GAME_DOMAIN}/mods/${id}.json`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

async function nexusGet(url) {
  const res = await fetch(url, {
    headers: { apikey: API_KEY, Accept: 'application/json' }
  });
  return res;
}

async function loadCache(path) {
  if (!existsSync(path)) {
    console.log(`No existing file at ${path} — starting from an empty cache.`);
    return [];
  }
  const raw = await readFile(path, 'utf-8');
  if (!raw.trim()) return [];
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    fail(`${path} is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(data)) {
    fail(`${path} must contain a JSON array.`);
  }
  return data;
}

async function loadBlacklist(path) {
  if (!existsSync(path)) {
    console.log(`No blacklist file at ${path} — nothing will be excluded on that basis.`);
    return new Set();
  }
  const raw = await readFile(path, 'utf-8');
  if (!raw.trim()) return new Set();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    fail(`${path} is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(data)) {
    fail(`${path} must contain a JSON array of mod IDs, e.g. ["1234", "5678"].`);
  }
  return new Set(data.map((id) => String(id)));
}

async function main() {
  if (!API_KEY) fail('NEXUS_API_KEY is not set.');

  const cache = await loadCache(MOD_WARNINGS_PATH);
  const cacheIds = new Set(cache.filter((m) => m && m.id !== undefined).map((m) => String(m.id)));
  console.log(`Loaded ${cache.length} mods from ${MOD_WARNINGS_PATH} (${cacheIds.size} usable IDs).`);

  const blacklist = await loadBlacklist(BLACKLIST_PATH);
  console.log(`Loaded ${blacklist.size} blacklisted mod ID(s) from ${BLACKLIST_PATH}.`);

  const blacklistedButCached = cache.filter((m) => m && m.id !== undefined && blacklist.has(String(m.id)));
  if (blacklistedButCached.length > 0) {
    console.log(
      `\n⚠️  ${blacklistedButCached.length} mod(s) already in ${MOD_WARNINGS_PATH} are on the blacklist ` +
      `but were NOT removed automatically:`
    );
    blacklistedButCached.forEach((m) => console.log(`   - ${m.name} (${m.id})`));
    console.log('   Remove these manually if you want them out of the list.\n');

    if (process.env.GITHUB_STEP_SUMMARY) {
      const blacklistList = blacklistedButCached.map((m) => `- **${m.name}** (\`${m.id}\`)`).join('\n');
      await writeFile(
        process.env.GITHUB_STEP_SUMMARY,
        `### ⚠️ Blacklisted mods still in \`${MOD_WARNINGS_PATH}\`\n\n` +
        `These weren't removed automatically — remove them by hand if you want them out:\n\n` +
        `${blacklistList}\n`,
        { flag: 'a' }
      );
    }
  }

  console.log(`Requesting ${GAME_DOMAIN} mod activity for period=${PERIOD}...`);
  const listRes = await nexusGet(UPDATED_URL);
  if (!listRes.ok) {
    const body = await listRes.text().catch(() => '');
    fail(`updated.json request failed: HTTP ${listRes.status} ${body.slice(0, 300)}`);
  }
  const activity = await listRes.json();
  console.log(`${activity.length} mods had activity in the last ${PERIOD}.`);

  const skippedBlacklist = activity.filter(
    (m) => m && m.mod_id !== undefined && blacklist.has(String(m.mod_id))
  ).length;

  const candidates = activity.filter(
    (m) => m && m.mod_id !== undefined && !cacheIds.has(String(m.mod_id)) && !blacklist.has(String(m.mod_id))
  );
  console.log(`${candidates.length} of those aren't already cached or blacklisted (${skippedBlacklist} blacklisted).`);

  const cutoff = Date.now() / 1000 - (PERIOD_SECONDS[PERIOD] || PERIOD_SECONDS['1m']);
  const newEntries = [];
  let skippedOld = 0;
  let skippedStatus = 0;
  let skippedError = 0;

  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    process.stdout.write(`  [${i + 1}/${candidates.length}] checking mod ${m.mod_id}...\r`);

    try {
      const dRes = await nexusGet(MOD_DETAIL_URL(m.mod_id));
      if (!dRes.ok) {
        console.log(`\n  mod ${m.mod_id}: detail request failed (HTTP ${dRes.status}), skipping.`);
        skippedError++;
        continue;
      }
      const detail = await dRes.json();
      const status = (detail.status || '').toLowerCase();
      const createdAt = detail.created_timestamp || 0;

      if (HIDDEN_STATUSES.has(status)) {
        skippedStatus++;
      } else if (createdAt < cutoff) {
        skippedOld++;
      } else {
        newEntries.push({
          name: detail.name || `Mod ${m.mod_id}`,
          id: String(m.mod_id),
          state: 'normal',
          warningMessage: '',
          _created: createdAt
        });
      }
    } catch (e) {
      console.log(`\n  mod ${m.mod_id}: request error (${e.message}), skipping.`);
      skippedError++;
    }

    if (i < candidates.length - 1) await sleep(DETAIL_FETCH_DELAY_MS);
  }
  console.log(''); // clear the \r line

  console.log(
    `Result: ${newEntries.length} genuinely new & published, ` +
    `${skippedOld} were edits to older mods, ` +
    `${skippedStatus} were removed/hidden/unpublished, ` +
    `${skippedBlacklist} were blacklisted, ` +
    `${skippedError} couldn't be checked.`
  );

  if (newEntries.length === 0) {
    console.log('Nothing new to add. Leaving mod_warnings.json untouched.');
    return;
  }

  // Oldest-of-the-new first, so the most recently created mod ends up at the very bottom.
  newEntries.sort((a, b) => a._created - b._created);
  newEntries.forEach((e) => delete e._created);

  const updated = [...cache, ...newEntries];
  await writeFile(MOD_WARNINGS_PATH, JSON.stringify(updated, null, 4) + '\n', 'utf-8');
  console.log(`Wrote ${updated.length} total mods to ${MOD_WARNINGS_PATH} (${newEntries.length} appended).`);

  // Surface a readable summary in the Actions run (and in the job summary, if available).
  const list = newEntries.map((e) => `- **${e.name}** (\`${e.id}\`)`).join('\n');
  console.log(`\nNew mods added:\n${list}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### New mods added to \`${MOD_WARNINGS_PATH}\`\n\n${list}\n`,
      { flag: 'a' }
    );
  }
}

main().catch((e) => fail(e.stack || e.message));
