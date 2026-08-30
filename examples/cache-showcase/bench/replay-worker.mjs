/**
 * Enfant de rejeu — un processus Node neuf par rejeu.
 *
 * Module purement organisationnel. Le contrat gelé exige qu'un rejeu s'exécute
 * dans un processus neuf ; ce fichier est le point d'entrée de ce processus, et
 * n'ajoute aucune sémantique.
 *
 * Le démarrage du processus, le chargement de la fixture et le décodage de la
 * trace sont hors mesure : seule la boucle de rejeu chronomètre.
 */

import { runReplay } from '../src/replay.mjs';
import { MUTATION_KINDS } from '../src/constants.mjs';
import { percentiles, toNanos } from '../src/metrics.mjs';

const request = JSON.parse(process.argv[2]);

const started = process.hrtime.bigint();
const outcome = runReplay(request);
const finished = process.hrtime.bigint();

const reads = percentiles(outcome.readDurations);

const mutations = {};
for (const kind of MUTATION_KINDS) {
  const durations = outcome.mutationDurations.get(kind);
  const stats = percentiles(durations);
  mutations[kind] = {
    count: outcome.mutationCounts.get(kind),
    median_ns: toNanos(stats.p50),
    p95_ns: toNanos(stats.p95),
    entries_invalidated: outcome.mutationEntries.get(kind),
  };
}

process.stdout.write(`${JSON.stringify({
  strategy: outcome.strategy,
  class_count: outcome.classCount,
  private_count: outcome.privateCount,
  seed_ordinal: outcome.seedOrdinal,
  initial_state_sha256: outcome.initialStateDigest,
  operations: outcome.operations,
  measured_reads: reads.count,
  read_p50_ns: toNanos(reads.p50),
  read_p95_ns: toNanos(reads.p95),
  mutations,
  residency: outcome.residency,
  replay_wall_ns: Number(finished - started),
})}\n`);
