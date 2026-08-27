/**
 * Client HTTP du cockpit.
 *
 * Lectures : `GET` exclusivement. Mutations : `POST`, et **uniquement** vers
 * les quatre routes courtes du Slice 4 — la table ci-dessous est close, et un
 * appelant ne peut pas fabriquer une route depuis une chaîne arbitraire.
 *
 * `STEP`, `SEND`, `START`, la reprise et le handoff n'y figurent pas : ils
 * n'ont pas de fonction ici, donc pas de chemin d'exécution non éprouvé.
 *
 * L'authentification repose entièrement sur le cookie `HttpOnly` posé par « / ».
 * Le JavaScript ne peut pas le lire, ne le stocke nulle part, et ne le
 * transporte jamais dans une URL. L'en-tête `Origin` est posé par le navigateur
 * lui-même : le cockpit ne peut pas le forger, et c'est précisément ce qui en
 * fait une protection.
 */

/** Table close action → segment de route. Seules ces quatre existent. */
/**
 * Table close des routes de reprise.
 *
 * Le miroir exact de celle du serveur. Une capacité que le client ne connaît
 * pas n'est pas devinée : elle n'est pas envoyée.
 */
export const RECOVERY_ROUTES = Object.freeze({
  RECOVERY_FINALIZE_JOURNALED_RESPONSE: 'finalize-journaled-response',
  RECOVERY_CONTINUE_INITIALIZATION: 'continue-initialization',
  RECOVERY_MATERIALIZE_AMBIGUITY: 'materialize-ambiguity',
  RECOVERY_ACKNOWLEDGE_AMBIGUITY: 'acknowledge-ambiguity',
  RECOVERY_CLEAR_STALE_LOCK: 'clear-stale-lock',
});

export const MUTATION_ROUTES = Object.freeze({
  PAUSE: 'pause',
  RESUME: 'resume',
  DECIDE: 'decide',
  STOP: 'stop',
  // Opérations longues : même table close, même point d'émission. Elles se
  // distinguent par la réponse — un `202` et un reçu à suivre — pas par la
  // façon dont la requête est construite.
  STEP: 'step',
  SEND: 'send',
});

/**
 * Clé d'idempotence d'une **tentative** humaine.
 *
 * Générée une fois par intention, pas une fois par envoi : c'est ce qui rend
 * une retransmission inoffensive. La régénérer à chaque essai transformerait
 * chaque retry en nouvel effet.
 */
export function newIdempotencyKey() {
  const random = globalThis.crypto;
  if (random && typeof random.randomUUID === 'function') return `ccr-${random.randomUUID()}`;
  const bytes = new Uint8Array(16);
  random.getRandomValues(bytes);
  return `ccr-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Erreur applicative portant le code public renvoyé par le serveur. */
export class ApiError extends Error {
  constructor(status, code) {
    super(`${String(status)} ${code}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query.length === 0 ? '' : `?${query}`;
}

/**
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl] Injection pour les tests.
 */
export function createApi(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function get(path, signal) {
    let response;
    try {
      response = await fetchImpl(path, {
        method: 'GET',
        // Même origine, cookie de session inclus, aucun en-tête inventé.
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal,
      });
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      throw new ApiError(0, 'NETWORK');
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (response.ok) return payload;

    // Le code public fait foi ; le message serveur n'est jamais réaffiché tel
    // quel, et aucun autre champ de la réponse n'est exploité.
    const code = payload && payload.error && typeof payload.error.code === 'string'
      ? payload.error.code
      : 'INTERNAL_ERROR';
    throw new ApiError(response.status, code);
  }

  /**
   * Exécute une mutation courte.
   *
   * Le corps ne transporte que des champs validés côté serveur ; la clé voyage
   * en en-tête, jamais dans l'URL.
   */
  async function mutate(action, runId, payload, idempotencyKey) {
    const segment = MUTATION_ROUTES[action];
    if (segment === undefined) throw new ApiError(0, 'INTERNAL_ERROR');

    let response;
    try {
      response = await fetchImpl(`/api/runs/${encodeURIComponent(runId)}/${segment}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new ApiError(0, 'NETWORK');
    }

    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (response.ok) return parsed;

    const code = parsed && parsed.error && typeof parsed.error.code === 'string'
      ? parsed.error.code
      : 'INTERNAL_ERROR';
    const failure = new ApiError(response.status, code);
    // L'identifiant permet de consulter le reçu ; rien d'autre n'est repris.
    if (parsed && typeof parsed.operation_id === 'string') failure.operationId = parsed.operation_id;
    throw failure;
  }

  /**
   * `POST /api/runs/:id/recovery/:capability`.
   *
   * Le corps est fourni par l'appelant, qui l'a construit depuis la capacité
   * reçue — jamais depuis l'état affiché.
   */
  async function recover(capabilityId, runId, payload, idempotencyKey) {
    const segment = RECOVERY_ROUTES[capabilityId];
    if (segment === undefined) throw new ApiError(0, 'INTERNAL_ERROR');

    let response;
    try {
      response = await fetchImpl(`/api/runs/${encodeURIComponent(runId)}/recovery/${segment}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new ApiError(0, 'NETWORK');
    }

    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (response.ok) return parsed;

    const code = parsed && parsed.error && typeof parsed.error.code === 'string'
      ? parsed.error.code
      : 'INTERNAL_ERROR';
    const failure = new ApiError(response.status, code);
    if (parsed && typeof parsed.operation_id === 'string') failure.operationId = parsed.operation_id;
    throw failure;
  }

  /**
   * `POST /api/runs` — création.
   *
   * Route de collection : elle ne porte aucun `run_id`, et pas davantage
   * d'`expected_revision`. Le run n'existe pas encore ; aucune vue ne peut donc
   * être périmée.
   */
  async function createRun(payload, idempotencyKey) {
    let response;
    try {
      response = await fetchImpl('/api/runs', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new ApiError(0, 'NETWORK');
    }

    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (response.ok) return parsed;

    const code = parsed && parsed.error && typeof parsed.error.code === 'string'
      ? parsed.error.code
      : 'INTERNAL_ERROR';
    const failure = new ApiError(response.status, code);
    if (parsed && typeof parsed.operation_id === 'string') failure.operationId = parsed.operation_id;
    throw failure;
  }

  /**
   * Émission mutante générique — chemin, charge, clé.
   *
   * Elle existe parce qu'un appelant la référençait déjà sans qu'elle soit
   * jamais définie : `recoverNative` s'écrivait `post(...)`, et l'identifiant
   * libre levait une `ReferenceError` au premier appel réel. Le défaut a
   * survécu parce que ce client n'est jamais exécuté par les tests — il y est
   * toujours doublé.
   *
   * Même forme que ses voisines : `same-origin`, en-têtes gelés, corps JSON,
   * `ApiError` portant le code public et, s'il existe, l'`operation_id`.
   */
  async function post(path, payload, idempotencyKey) {
    let response;
    try {
      response = await fetchImpl(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new ApiError(0, 'NETWORK');
    }

    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (response.ok) return parsed;

    const code = parsed && parsed.error && typeof parsed.error.code === 'string'
      ? parsed.error.code
      : 'INTERNAL_ERROR';
    const failure = new ApiError(response.status, code);
    if (parsed && typeof parsed.operation_id === 'string') failure.operationId = parsed.operation_id;
    throw failure;
  }

  /**
   * `POST /api/runs/:id/reconciliations` — écritures V5 (V5.1).
   *
   * Une route, une union fermée d'opérations. Le corps porte l'opération et ses
   * champs métier tels que l'humain les a saisis : aucun n'est validé ici, car
   * seul le service V5 peut refuser avec le motif exact.
   *
   * Un `202` est une réponse normale — la proposition assistée est une opération
   * longue, et son reçu se suit par `getOperation`.
   */
  async function reconcile(runId, payload, idempotencyKey) {
    let response;
    try {
      response = await fetchImpl(`/api/runs/${encodeURIComponent(runId)}/reconciliations`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new ApiError(0, 'NETWORK');
    }

    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (response.ok) return parsed;

    const code = parsed && parsed.error && typeof parsed.error.code === 'string'
      ? parsed.error.code
      : 'INTERNAL_ERROR';
    const failure = new ApiError(response.status, code);
    if (parsed && typeof parsed.operation_id === 'string') failure.operationId = parsed.operation_id;
    throw failure;
  }

  return {
    mutate,
    createRun,
    getOperation: (operationId, signal) => get(`/api/operations/${encodeURIComponent(operationId)}`, signal),
    listRuns: (signal) => get('/api/runs', signal),
    getRun: (runId, signal) => get(`/api/runs/${encodeURIComponent(runId)}`, signal),
    getTimeline: (runId, options = {}, signal) =>
      get(
        `/api/runs/${encodeURIComponent(runId)}/timeline${buildQuery({
          limit: options.limit,
          cursor: options.cursor,
        })}`,
        signal,
      ),
    getRecovery: (runId, signal) => get(`/api/runs/${encodeURIComponent(runId)}/recovery`, signal),
    /**
     * URL des flux d'invalidation.
     *
     * Aucun jeton n'y figure : `EventSource` ne sait pas poser d'en-tête, mais
     * il envoie le cookie de session, et c'est lui qui authentifie. Mettre un
     * secret dans une URL le ferait entrer dans l'historique, les journaux et
     * le `Referer`.
     */
    runStreamUrl: (runId) => `/api/runs/${encodeURIComponent(runId)}/stream`,
    listStreamUrl: () => '/api/stream',
    recover,
    /**
     * Reprise **native** : un domaine et un geste, nommes tous les deux.
     *
     * Table de routes distincte de celle de V1, et deliberement : `domaine x
     * geste` n'a aucune traduction vers les capacites historiques, et en
     * inventer une reviendrait a decider ce que l'humain a voulu.
     *
     * La note n'est ni rognee ni normalisee ici : c'est une affirmation
     * humaine, et le transport la porte telle quelle.
     */
    recoverNative: (runId, payload, key) =>
      post(`/api/runs/${encodeURIComponent(runId)}/recovery`, payload, key),
    /**
     * `POST /api/runs/:id/controversies` — écritures V3 (V5.1).
     *
     * La route existait côté serveur depuis V3 ; aucune surface ne l'appelait.
     * Le corps porte l'opération et ses champs métier tels que l'humain les a
     * saisis : seul le service V3 refuse, et lui seul rend le motif exact.
     */
    recordControversy: (runId, payload, key) =>
      post(`/api/runs/${encodeURIComponent(runId)}/controversies`, payload, key),
    /**
     * `POST /api/runs/:id/evidence` — écritures V4 (V5.1).
     *
     * Deux opérations distinctes y transitent — retenir un matériau, et le
     * verser au débat. Le client ne les fusionne pas davantage que le service.
     */
    recordEvidence: (runId, payload, key) =>
      post(`/api/runs/${encodeURIComponent(runId)}/evidence`, payload, key),
    reconcile,
    getConfig: (signal) => get('/api/config', signal),
    getDoctor: (signal) => get('/api/doctor', signal),
  };
}
