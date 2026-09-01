# Extraits de preuve — Run A · CCR-20260901-002

**Extraits curés et expurgés.** Ce fichier est une **projection de présentation**
des artefacts durables du run. Il ne les remplace pas et n'en constitue pas une
copie fidèle : les journaux originaux du run restent les seules autorités.

Les catégories expurgées sont listées dans [`MANIFEST.md`](MANIFEST.md). Aucun
identifiant CCR, aucun chiffre de quota, aucun horodatage utile à l'ordre causal
n'a été modifié.

---

## 1. Identité et gouvernance — M1

`manifest.json` — extrait :

```json
{
  "schema_version": 2,
  "run_id": "CCR-20260901-002",
  "title": "Projection de lecture des faits d'issue d'invocation",
  "created_at": "2026-09-01T11:43:44.295Z",
  "workspace": { "cwd": "<REDACTED_WORKSPACE>" },
  "experts": {
    "author":     { "provider": "claude", "session_id": "<REDACTED_SESSION_ID>" },
    "challenger": { "provider": "codex",  "session_id": "<REDACTED_SESSION_ID>" }
  }
}
```

Configuration figée à la création — extrait restreint à ce qui gouverne la
traversée :

```json
"runtime_config": {
  "schema_version": 2,
  "captured_at": "2026-09-01T11:43:44.293Z",
  "claude": {
    "required": true,
    "probe_status": "OBSERVED",
    "cli_version": "2.1.224",
    "auth_preflight": "<REDACTED_AUTH_STATE>"
  },
  "codex": {
    "required": true,
    "probe_status": "OBSERVED",
    "cli_version": "0.146.0",
    "auth_preflight": "<REDACTED_AUTH_STATE>",
    "skip_git_repo_check": true,
    "source_at_capture": "config"
  }
}
```

`invocation-policy.json` — intégral :

```json
{
  "schema_version": 1,
  "invocation_quota": { "max_invocations": 6 }
}
```

Le plafond est posé à la naissance du run et n'est plus modifiable.

---

## 2. Autorité d'engagement — M2

`invocations.jsonl` — les deux enregistrements, intégraux :

```json
{"schema_version":1,"kind":"DISPATCH_COMMITTED","invocation_id":"inv_000001","run_id":"CCR-20260901-002","identity":{"generation":"NATIVE_V21_EXECUTION","expert_slot":"author","provider":"claude"},"trigger_kind":"START","prompt_event_id":"evt_000002","dispatch_committed_at":"2026-09-01T11:43:44.341Z"}
{"schema_version":1,"kind":"DISPATCH_COMMITTED","invocation_id":"inv_000002","run_id":"CCR-20260901-002","identity":{"generation":"NATIVE_V21_EXECUTION","expert_slot":"challenger","provider":"codex"},"trigger_kind":"START","prompt_event_id":"evt_000005","dispatch_committed_at":"2026-09-01T11:49:50.441Z"}
```

Aucune expurgation n'a été nécessaire : ces enregistrements ne contiennent que
des localisateurs de domaine.

```text
ENGAGEMENT  =  ce que CCR s'est engagé à tenter
            ≠  ce qui en est résulté
```

---

## 3. Journal d'événements — M4

`events.jsonl` — contenus remplacés par leur taille, tout le reste intégral :

```json
{"round":0,"actor":"system","type":"run_created","content":"<<52 o>>","details":{"workspace_cwd":"<REDACTED_WORKSPACE>"},"timestamp":"2026-09-01T11:43:44.324Z","event_id":"evt_000001","run_id":"CCR-20260901-002"}
{"round":0,"actor":"human","type":"prompt_sent","target_expert_slot_id":"author","content":"<<558 o>>","timestamp":"2026-09-01T11:43:44.338Z","event_id":"evt_000002","run_id":"CCR-20260901-002"}
{"round":0,"actor":"expert","type":"assistant_response","expert_slot_id":"author","session_id":"<REDACTED_SESSION_ID>","content":"<<10190 o>>","exit_code":0,"based_on":["evt_000002"],"timestamp":"2026-09-01T11:49:50.413Z","event_id":"evt_000003","run_id":"CCR-20260901-002"}
{"round":0,"actor":"system","type":"session_created","expert_slot_id":"author","session_id":"<REDACTED_SESSION_ID>","timestamp":"2026-09-01T11:49:50.425Z","event_id":"evt_000004","run_id":"CCR-20260901-002"}
{"round":0,"actor":"human","type":"prompt_sent","target_expert_slot_id":"challenger","content":"<<558 o>>","timestamp":"2026-09-01T11:49:50.438Z","event_id":"evt_000005","run_id":"CCR-20260901-002"}
{"round":0,"actor":"expert","type":"assistant_response","expert_slot_id":"challenger","session_id":"<REDACTED_SESSION_ID>","content":"<<6920 o>>","exit_code":0,"based_on":["evt_000005"],"timestamp":"2026-09-01T11:56:58.436Z","event_id":"evt_000006","run_id":"CCR-20260901-002"}
{"round":0,"actor":"system","type":"session_created","expert_slot_id":"challenger","session_id":"<REDACTED_SESSION_ID>","timestamp":"2026-09-01T11:56:58.442Z","event_id":"evt_000007","run_id":"CCR-20260901-002"}
```

### La jointure de corrélation

Les événements natifs ne portent aucun `invocation_id`. La corrélation est
**indirecte**, par l'événement de prompt :

```text
inv_000001   prompt_event_id = evt_000002
             evt_000003.based_on = ["evt_000002"]     →  corrélée

inv_000002   prompt_event_id = evt_000005
             evt_000006.based_on = ["evt_000005"]     →  corrélée
```

Les deux invocations sont donc classées `NATIVE_DURABLE_EVENT_EVIDENCE`.

---

## 4. État final et quota — M3

`state.json` — intégral :

```json
{
  "schema_version": 3,
  "run_id": "CCR-20260901-002",
  "state": "READY",
  "control": "AUTOMATION",
  "round": 0,
  "active_expert_slot": null,
  "next_step_source_slot": "author",
  "last_event_id": "evt_000007",
  "pending_operation": null,
  "uncertainty": null,
  "updated_at": "2026-09-01T11:56:58.447Z"
}
```

Surface de lecture du produit — extrait de statut, expurgé :

```text
Run CCR-20260901-002 — Projection de lecture des faits d'issue d'invocation
  génération  NATIVE_V21_EXECUTION
  workspace   <REDACTED_WORKSPACE>
  état        READY / AUTOMATION   round 0   curseur author
  author     claude  session <REDACTED_SESSION_ID>  BOUND
  challenger codex   session <REDACTED_SESSION_ID>  BOUND
  transfert   author → challenger (source evt_000003, round 1, 10775 octets)
  reprises    initialisation NONE · transfert NONE · envoi NONE · handoff NONE
  alias       claude → author · codex → challenger
  quota CCR   2/6 engagée(s)   restant 4
  usage CCR   2 invocation(s) · usage fournisseur 2 observée(s) / 0 non observée(s)
  coût estimé 0 estimée(s) · 2 inconnue(s) · aucun catalogue tarifaire
```

Réconciliation :

```text
plafond                6      invocation-policy.json
engagements durables   2      invocations.jsonl
restant                4      6 − 2
surface de lecture     2/6 · restant 4
```

`reprises initialisation NONE` : aucune opération de reprise n'a été exécutée.
Le statut intermédiaire exposait `RECOVERY_REQUIRED` à partir des faits alors
observables ; l'exécution sous-jacente s'est ensuite terminée, et l'état durable
final est `READY`.

---

## 5. Observation d'exécution — corroborante

```text
usage.jsonl  =  PREUVE DURABLE D'OBSERVATION D'EXÉCUTION
             ≠  AUTORITÉ D'ISSUE TERMINALE DE PRODUIT
```

Quatre observations, deux par invocation, de provenances distinctes. Elles
**corroborent** les deux exécutions natives ; elles ne les établissent pas.

| invocation | provenance | issue d'exécution | fait durable |
|---|---|---|---|
| `inv_000001` | `PROVIDER_REPORTED` | `RESPONSE_RECEIVED` | 22 923 jetons de sortie · `duration_ms` 359 902 |
| `inv_000001` | `CCR_MEASURED` | `RESPONSE_RECEIVED` | `ccr_elapsed_ms` 365 954 · `exit_code` 0 |
| `inv_000002` | `PROVIDER_REPORTED` | `RESPONSE_RECEIVED` | 16 283 jetons de sortie · 10 131 de raisonnement |
| `inv_000002` | `CCR_MEASURED` | `RESPONSE_RECEIVED` | `ccr_elapsed_ms` 427 979 · `exit_code` 0 |

Deux précisions que ces enregistrements portent eux-mêmes :

- L'identité du modèle est `UNKNOWN` pour les deux invocations, sous **deux
  motifs durables distincts** — `AMBIGUOUS_MULTIPLE_MODELS` d'un côté,
  `NOT_REPORTED` de l'autre. CCR ne les fusionne pas.
- Le coût n'est rapporté que par un fournisseur. En l'absence de catalogue
  tarifaire, CCR déclare `inconnue` plutôt que d'estimer. Les montants facturés
  ne sont pas publiés ici : ils relèvent du compte de l'opérateur.

`outcome` vaut ici `RESPONSE_RECEIVED` : c'est un **vocabulaire d'exécution**,
jamais une issue de produit.

---

## 6. Absence de fait dédié dans `invocation-outcomes.json`

```text
invocation-outcomes.json     ABSENT

CONSÉQUENCE ADMISE           aucun fait dédié d'issue d'invocation n'est
                             enregistré dans ce journal pour ce run
CONSÉQUENCE INTERDITE        en déduire un succès
                             en déduire un échec
```

Aucun objet de domaine n'existe non plus : `controversies.jsonl`,
`evidence.jsonl`, `reconciliations.jsonl` sont absents. Les répertoires
`rounds/` et `artifacts/` sont vides.

La classification des deux invocations ne s'appuie donc sur aucune de ces
sources, mais sur la preuve événementielle native — la plus forte autorité
durable effectivement présente.
