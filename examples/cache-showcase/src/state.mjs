/**
 * État canonique d'une configuration, et application des mutations.
 *
 * L'état est reconstruit intégralement avant chaque rejeu : aucune fuite d'état
 * entre stratégies n'est possible, puisque chaque rejeu s'exécute d'ailleurs
 * dans un processus Node neuf.
 *
 * La confidentialité est une SURCOUCHE de configuration : elle fixe les
 * étiquettes effectives d'un document, sans jamais toucher son `base_label`,
 * son corps ni son propriétaire initial.
 */

import {
  DOCUMENT_IDS,
  FACETS,
  FILLERS,
  FILLER_TOKEN_COUNT,
  GRANTS,
  OP_CONTENT_FILLER,
  OP_CONTENT_MEMBERSHIP,
  OP_GRANT,
  OP_LABEL,
  OP_OWNERSHIP,
  PRIVATE_LABEL,
  TOPICS,
  VIEWER_IDS,
} from './constants.mjs';
import { INDEX, digestOf } from './prng.mjs';
import { buildCorpus, privateRanking } from './corpus.mjs';
import { canonicalClass, initialClassAssignment } from './topology.mjs';

/**
 * Construit l'état initial d'une configuration.
 *
 * @param {number} classCount    4, 40 ou 400
 * @param {number} privateCount  40, 140 ou 280
 */
export function buildInitialState(classCount, privateCount) {
  const corpus = buildCorpus();
  const privateSet = new Set(privateRanking().slice(0, privateCount));

  const documents = corpus.map((record) => {
    const tokens = record.body.split(' ');
    return {
      id: record.id,
      owner: record.owner,
      base_label: record.base_label,
      labels: privateSet.has(record.id) ? [PRIVATE_LABEL] : [record.base_label],
      content_version: record.content_version,
      tokens,
      body: record.body,
    };
  });

  const classOf = initialClassAssignment(classCount);
  const viewers = VIEWER_IDS.map((id, index) => {
    const grants = [...classOf(index).grants];
    return { id, grants, grantSet: new Set(grants) };
  });

  return {
    classCount,
    privateCount,
    documents,
    documentsById: new Map(documents.map((d) => [d.id, d])),
    viewers,
    viewersById: new Map(viewers.map((v) => [v.id, v])),
  };
}

/** Classe canonique VIVANTE d'un viewer, redérivée de ses grants courants. */
export function liveGrantClass(viewer) {
  return canonicalClass(viewer.grants);
}

// --------------------------------------------------------------------------
// Empreinte de l'état initial
// --------------------------------------------------------------------------

/**
 * NDJSON canonique — documents d'abord, puis viewers, chacun en ordre d'id.
 *
 * Compact, UTF-8, sans BOM, enregistrements séparés par LF, LF final.
 */
export function serializeState(state) {
  const lines = [];
  for (const document of state.documents) {
    lines.push(JSON.stringify({
      kind: 'document',
      id: document.id,
      owner: document.owner,
      labels: document.labels,
      content_version: document.content_version,
      body: document.body,
    }));
  }
  for (const viewer of state.viewers) {
    lines.push(JSON.stringify({
      kind: 'viewer',
      id: viewer.id,
      grants: viewer.grants,
    }));
  }
  return `${lines.join('\n')}\n`;
}

/** SHA-256 de l'état canonique. Artefact dérivé, jamais codé en dur. */
export function stateDigest(state) {
  return digestOf(serializeState(state)).toString('hex');
}

// --------------------------------------------------------------------------
// Mutations
// --------------------------------------------------------------------------

/** Alternatives canoniques à une valeur, dans l'ordre du vocabulaire. */
function alternatives(vocabulary, current) {
  return vocabulary.filter((value) => value !== current);
}

/**
 * Résout puis applique une mutation contre l'état vivant.
 *
 * Les tirages sont ceux du squelette — identiques pour une même graine à
 * travers les neuf configurations. Seule la RÉSOLUTION diffère, et uniquement
 * là où l'ensemble éligible diffère réellement.
 *
 * Rend un descripteur décrivant exactement ce qui a changé : c'est lui, et rien
 * d'autre, qui pilote l'invalidation des caches.
 */
export function applyMutation(state, operation) {
  const [d0, d1, d2] = operation.draws;

  switch (operation.kind) {
    case OP_CONTENT_MEMBERSHIP: {
      // Cible : les 400 documents, ordre canonique — appariée entre configurations.
      const document = state.documents[INDEX(d0, DOCUMENT_IDS.length)];
      const useTopic = d1 < 2147483648;
      const position = useTopic ? 0 : 1;
      const vocabulary = useTopic ? TOPICS : FACETS;
      const options = alternatives(vocabulary, document.tokens[position]);
      document.tokens[position] = options[INDEX(d2, options.length)];
      document.body = document.tokens.join(' ');
      document.content_version += 1;
      return { kind: operation.kind, document, dimension: useTopic ? 'topic' : 'facet' };
    }

    case OP_CONTENT_FILLER: {
      const document = state.documents[INDEX(d0, DOCUMENT_IDS.length)];
      const slot = 2 + INDEX(d1, FILLER_TOKEN_COUNT);
      const options = alternatives(FILLERS, document.tokens[slot]);
      document.tokens[slot] = options[INDEX(d2, options.length)];
      document.body = document.tokens.join(' ');
      document.content_version += 1;
      return { kind: operation.kind, document, slot };
    }

    case OP_LABEL: {
      // Éligibles : documents actuellement NON privés, ordre d'identifiant.
      const eligible = state.documents.filter((doc) => doc.labels[0] !== PRIVATE_LABEL);
      const document = eligible[INDEX(d0, eligible.length)];
      const previous = document.labels[0];
      const options = alternatives(GRANTS, previous);
      const next = options[INDEX(d1, options.length)];
      const oldLabels = [...document.labels];
      document.labels = [next];
      // Une mutation d'étiquette n'est pas une mutation de contenu : la version
      // de contenu ne bouge pas, et les étiquettes ne sont pas indexables.
      return {
        kind: operation.kind,
        document,
        oldLabels,
        newLabels: [...document.labels],
      };
    }

    case OP_GRANT: {
      const viewerA = state.viewers[INDEX(d0, VIEWER_IDS.length)];
      const classA = liveGrantClass(viewerA);
      // Éligibles : viewers dont la classe COURANTE diffère de celle de A.
      const eligible = state.viewers.filter((v) => liveGrantClass(v) !== classA);
      const viewerB = eligible[INDEX(d1, eligible.length)];
      const grantsA = viewerA.grants;
      viewerA.grants = viewerB.grants;
      viewerB.grants = grantsA;
      viewerA.grantSet = new Set(viewerA.grants);
      viewerB.grantSet = new Set(viewerB.grants);
      return { kind: operation.kind, viewerA, viewerB };
    }

    case OP_OWNERSHIP: {
      // Éligibles : documents actuellement « propriété seule », ordre d'identifiant.
      const eligible = state.documents.filter((doc) => doc.labels[0] === PRIVATE_LABEL);
      const document = eligible[INDEX(d0, eligible.length)];
      const previousOwner = document.owner;
      const options = alternatives(VIEWER_IDS, previousOwner);
      document.owner = options[INDEX(d1, options.length)];
      return {
        kind: operation.kind,
        document,
        oldOwner: previousOwner,
        newOwner: document.owner,
      };
    }

    default:
      throw new Error(`Nature de mutation inconnue : ${String(operation.kind)}`);
  }
}
