/**
 * Exécution qualifiée du banc d'essai.
 *
 * 27 traces configurées × 4 rejeux = 108 processus Node neufs.
 *
 * Énumération gelée : nombre de classes 4, 40, 400 ; puis densité de propriété
 * 10, 35, 70 ; puis graine de charge 1, 2, 3. Pour l'ordinal `n`, l'ordre de
 * rejeu de base est tourné à gauche de `n mod 4`.
 *
 * Le banc ne règle rien, ne réessaie rien et n'écarte aucun rejeu. Un résultat
 * surprenant est un résultat.
 */

import { spawnSync } from 'node:child_process';
import { cpus } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BASE_REPLAY_ORDER,
  CLASS_COUNTS,
  MUTATION_KINDS,
  OWNERSHIP_DENSITIES,
  PRIVATE_COUNTS,
  R1_TARGET_RATIO,
  STRATEGY_REFERENCE,
  WORKLOAD_SEED_ORDINALS,
} from '../src/constants.mjs';
import { enumerateConfiguredTraces } from '../src/trace.mjs';
import { ratioOf, summarize } from '../src/metrics.mjs';
import { corpusDigest } from '../src/corpus.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'replay-worker.mjs');
const OUTPUT_DIR = join(HERE, '..', 'observations', 'generated');

/**
 * Métadonnées d'hôte.
 *
 * Champs autorisés uniquement. Le nom de machine, le nom d'utilisateur, le
 * répertoire personnel, le répertoire courant et l'environnement sont
 * volontairement absents : le ratio R1 est conditionné par la machine, mais la
 * machine n'a pas à être identifiable.
 */
export function hostMetadata() {
  const list = cpus();
  return {
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu_model: list.length === 0 ? 'inconnu' : list[0].model,
    logical_cores: list.length,
  };
}

/** Ordre de rejeu d'un ordinal : rotation gauche de `ordinal mod 4`. */
export function replayOrderFor(ordinal) {
  const shift = ordinal % BASE_REPLAY_ORDER.length;
  return [...BASE_REPLAY_ORDER.slice(shift), ...BASE_REPLAY_ORDER.slice(0, shift)];
}

function runOneReplay(trace, strategy) {
  const privateCount = PRIVATE_COUNTS[OWNERSHIP_DENSITIES.indexOf(trace.density)];
  const request = JSON.stringify({
    classCount: trace.classCount,
    privateCount,
    seedOrdinal: trace.seedOrdinal,
    strategy,
  });
  const child = spawnSync(process.execPath, [WORKER, request], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.status !== 0) {
    throw new Error(
      `Rejeu ${strategy} ordinal ${trace.ordinal} : sortie ${String(child.status)}\n${child.stderr}`,
    );
  }
  return JSON.parse(child.stdout.trim());
}

function main() {
  const traces = enumerateConfiguredTraces(CLASS_COUNTS, OWNERSHIP_DENSITIES, WORKLOAD_SEED_ORDINALS);
  const host = hostMetadata();
  const corpus = corpusDigest();
  const startedAt = process.hrtime.bigint();

  const replays = [];
  for (const trace of traces) {
    const order = replayOrderFor(trace.ordinal);
    process.stderr.write(
      `trace ${String(trace.ordinal).padStart(2)} `
      + `classes=${String(trace.classCount).padStart(3)} `
      + `densite=${String(trace.density).padStart(2)} `
      + `graine=${trace.seedOrdinal} ordre=${order.join(',')}\n`,
    );
    for (const strategy of order) {
      const outcome = runOneReplay(trace, strategy);
      replays.push({ ordinal: trace.ordinal, ...trace, ...outcome });
    }
  }

  const finishedAt = process.hrtime.bigint();

  // ---- R1 : ratio d'un p95 de stratégie au p95 de la REFERENCE de la MÊME trace.
  const byOrdinal = new Map();
  for (const replay of replays) {
    if (!byOrdinal.has(replay.ordinal)) byOrdinal.set(replay.ordinal, {});
    byOrdinal.get(replay.ordinal)[replay.strategy] = replay;
  }

  const perTrace = [];
  for (const trace of traces) {
    const group = byOrdinal.get(trace.ordinal);
    const reference = group[STRATEGY_REFERENCE];
    const entry = { ...trace, reference_p95_ns: reference.read_p95_ns, ratios: {} };
    for (const strategy of BASE_REPLAY_ORDER) {
      if (strategy === STRATEGY_REFERENCE) continue;
      entry.ratios[strategy] = ratioOf(
        BigInt(group[strategy].read_p95_ns),
        BigInt(reference.read_p95_ns),
      );
    }
    perTrace.push(entry);
  }

  const perConfiguration = [];
  for (const classCount of CLASS_COUNTS) {
    for (const density of OWNERSHIP_DENSITIES) {
      const matching = perTrace.filter((t) => t.classCount === classCount && t.density === density);
      const ratios = {};
      for (const strategy of BASE_REPLAY_ORDER) {
        if (strategy === STRATEGY_REFERENCE) continue;
        ratios[strategy] = summarize(matching.map((t) => t.ratios[strategy]));
      }
      perConfiguration.push({ classCount, density, seeds: matching.length, ratios });
    }
  }

  const report = {
    generated_by: 'bench/run-bench.mjs',
    host,
    corpus_sha256: corpus,
    r1_target_ratio: R1_TARGET_RATIO,
    wall_clock_ns: Number(finishedAt - startedAt),
    traces: traces.length,
    replays: replays.length,
    per_trace: perTrace,
    per_configuration: perConfiguration,
    raw: replays,
  };

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, 'benchmark.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(OUTPUT_DIR, 'benchmark.md'), renderMarkdown(report), 'utf8');

  process.stderr.write(`\nTerminé en ${(report.wall_clock_ns / 1e9).toFixed(1)} s\n`);
  process.stdout.write(`${JSON.stringify({
    corpus_sha256: report.corpus_sha256,
    wall_clock_s: report.wall_clock_ns / 1e9,
    replays: report.replays,
  })}\n`);
}

function fmt(value, digits = 3) {
  return value === null || value === undefined ? 'n/a' : value.toFixed(digits);
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Banc d\'essai — showcase de cache');
  lines.push('');
  lines.push('Faits issus d\'une exécution. Aucun chiffre de ce fichier n\'est écrit à la main.');
  lines.push('');
  lines.push('## Hôte');
  lines.push('');
  for (const [key, value] of Object.entries(report.host)) {
    lines.push(`- \`${key}\` : ${String(value)}`);
  }
  lines.push('');
  lines.push(`- \`corpus_sha256\` : \`${report.corpus_sha256}\``);
  lines.push(`- durée totale : ${(report.wall_clock_ns / 1e9).toFixed(1)} s`);
  lines.push(`- rejeux : ${String(report.replays)}`);
  lines.push('');
  lines.push('## R1 — ratio p95 stratégie / p95 REFERENCE');
  lines.push('');
  lines.push(`Cible d'auteur, figée avant mesure : médiane ≤ ${report.r1_target_ratio}.`);
  lines.push('');
  lines.push('| classes | densité | S1 méd | S1 min | S1 max | S2 méd | S2 min | S2 max | S3 méd | S3 min | S3 max |');
  lines.push('|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
  for (const row of report.per_configuration) {
    lines.push(`| ${row.classCount} | ${row.density} % | `
      + `${fmt(row.ratios.S1.median)} | ${fmt(row.ratios.S1.min)} | ${fmt(row.ratios.S1.max)} | `
      + `${fmt(row.ratios.S2.median)} | ${fmt(row.ratios.S2.min)} | ${fmt(row.ratios.S2.max)} | `
      + `${fmt(row.ratios.S3.median)} | ${fmt(row.ratios.S3.min)} | ${fmt(row.ratios.S3.max)} |`);
  }
  lines.push('');
  lines.push('## Latence de lecture, par trace');
  lines.push('');
  lines.push('| ordinal | classes | densité | graine | REFERENCE p95 (µs) | S1 p95 (µs) | S2 p95 (µs) | S3 p95 (µs) |');
  lines.push('|--:|--:|--:|--:|--:|--:|--:|--:|');
  const index = new Map(report.raw.map((r) => [`${r.ordinal}:${r.strategy}`, r]));
  for (const trace of report.per_trace) {
    const us = (strategy) => (index.get(`${trace.ordinal}:${strategy}`).read_p95_ns / 1000).toFixed(1);
    lines.push(`| ${trace.ordinal} | ${trace.classCount} | ${trace.density} % | ${trace.seedOrdinal} | `
      + `${us('REFERENCE')} | ${us('S1')} | ${us('S2')} | ${us('S3')} |`);
  }
  lines.push('');
  lines.push('## Mutations — coût et entrées invalidées');
  lines.push('');
  lines.push('| stratégie | mutation | nombre | médiane (µs) | p95 (µs) | entrées invalidées |');
  lines.push('|:--|:--|--:|--:|--:|--:|');
  for (const strategy of BASE_REPLAY_ORDER) {
    for (const kind of MUTATION_KINDS) {
      let count = 0;
      let entries = 0;
      const medians = [];
      const p95s = [];
      for (const replay of report.raw) {
        if (replay.strategy !== strategy) continue;
        const stats = replay.mutations[kind];
        count += stats.count;
        entries += stats.entries_invalidated;
        if (stats.median_ns !== null) medians.push(stats.median_ns);
        if (stats.p95_ns !== null) p95s.push(stats.p95_ns);
      }
      const median = medians.length === 0 ? null : summarize(medians).median / 1000;
      const p95 = p95s.length === 0 ? null : summarize(p95s).median / 1000;
      lines.push(`| ${strategy} | ${kind} | ${count} | ${fmt(median, 1)} | ${fmt(p95, 1)} | ${entries} |`);
    }
  }
  lines.push('');
  lines.push('## Résidence — entrées présentes');
  lines.push('');
  lines.push('| stratégie | après warmup (méd) | pic (méd) | fin (méd) |');
  lines.push('|:--|--:|--:|--:|');
  for (const strategy of BASE_REPLAY_ORDER) {
    const rows = report.raw.filter((r) => r.strategy === strategy);
    const pick = (path) => summarize(rows.map((r) => r.residency[path].total)).median;
    lines.push(`| ${strategy} | ${pick('afterWarmup')} | ${pick('peak')} | ${pick('end')} |`);
  }
  lines.push('');
  lines.push('Le nombre d\'entrées ne permet aucun classement mémoire : les charges');
  lines.push('utiles d\'une entrée diffèrent entre une réponse complète, une réponse');
  lines.push('partagée, une surcouche et une projection.');
  lines.push('');
  return lines.join('\n');
}

// Exécuté seulement lorsque ce fichier EST le point d'entrée : les tests
// importent `hostMetadata` et `replayOrderFor` sans déclencher le banc.
if (process.argv[1] !== undefined && process.argv[1].endsWith('run-bench.mjs')) {
  main();
}
