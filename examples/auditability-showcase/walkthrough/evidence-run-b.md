# Extraits de preuve — Run B · CCR-20260901-001

**Annexe de capacité nulle.** Un run indépendant, créé avec un plafond de zéro
invocation, et une seule tentative d'admission `start`. Aucune relance.

**Extraits curés et expurgés.** Ce fichier est une **projection de
présentation** ; les journaux originaux du run restent les seules autorités.

---

## 1. La chaîne de preuve

L'énoncé à établir est : *aucun appel fournisseur n'a été émis par CCR.*

Il repose sur trois maillons, **dans cet ordre** :

```text
1  SÉMANTIQUE PRODUIT     la garde de quota refuse AVANT toute dépêche
2  RETOUR D'OPÉRATION     l'opération déclare qu'aucun agent n'est sollicité
3  JOURNAL D'ENGAGEMENT   le registre durable ne contient aucun engagement
```

L'ordre n'est pas décoratif. Le premier maillon est une propriété du produit ;
les deux suivants constatent qu'elle s'est appliquée à ce run précis.

### Maillon 1 — la garde précède la dépêche

Dans le chemin de `start`, la vérification de quota est la **première**
opération de la section sérialisée qui gouverne la dépêche. Elle s'exécute avant
l'écriture de l'événement de prompt, avant l'enregistrement de l'engagement, et
avant tout appel d'adaptateur. Un refus à ce point rend la dépêche
inatteignable.

### Maillon 2 — ce que l'opération a répondu

```text
Run créé : CCR-20260901-001

Initialisation incomplète : la session de « author » n'a pas pu être créée.
Erreur [CCR_INVOCATION_QUOTA_EXCEEDED] La politique du run CCR-20260901-001
autorise 0 invocation(s) ; 0 ont déjà été engagées. Aucun agent n'est sollicité.
  runId : CCR-20260901-001
  scope : run
  limit : 0
  consumed : 0
  remaining : 0

État : FAILED_INITIALIZATION. Les sessions déjà créées sont conservées.
```

La phrase « Aucun agent n'est sollicité » est un énoncé du produit sur son propre
comportement, émis au point de refus.

### Maillon 3 — le registre durable

```text
invocations.jsonl     0 enregistrement DISPATCH_COMMITTED
```

Le registre d'engagement est l'autorité sur ce que CCR s'est engagé à tenter. Il
est vide.

---

## 2. Ce que l'absence corrobore — et ne prouve pas

```text
usage.jsonl                  ABSENT
invocation-outcomes.json     ABSENT
événement de prompt          AUCUN
événement de session         AUCUN
```

Ces absences **corroborent** le résultat. Elles ne l'établissent pas :

```text
ABSENCE SEULE  ≠  PREUVE DE ZÉRO APPEL FOURNISSEUR
```

Un journal peut manquer pour des raisons étrangères à l'émission d'un appel —
une écriture qui n'a pas eu lieu, un processus arrêté avant d'observer, un
fichier créé paresseusement. Raisonner depuis le silence reviendrait à commettre,
sur Run B, exactement l'erreur que Run A a servi à corriger.

Ce qui établit le zéro reste la garde qui refuse en amont, et le registre
d'engagement qui n'a rien enregistré.

---

## 3. Artefacts durables

`invocation-policy.json` — intégral :

```json
{
  "schema_version": 1,
  "invocation_quota": { "max_invocations": 0 }
}
```

`state.json` — intégral :

```json
{
  "schema_version": 3,
  "run_id": "CCR-20260901-001",
  "state": "FAILED_INITIALIZATION",
  "control": "HUMAN",
  "round": 0,
  "active_expert_slot": null,
  "next_step_source_slot": null,
  "last_event_id": "evt_000001",
  "pending_operation": null,
  "uncertainty": null,
  "updated_at": "2026-09-01T11:40:45.778Z"
}
```

`events.jsonl` — intégral, un seul événement :

```json
{"round":0,"actor":"system","type":"run_created","content":"<<52 o>>","details":{"workspace_cwd":"<REDACTED_WORKSPACE>"},"timestamp":"2026-09-01T11:40:45.764Z","event_id":"evt_000001","run_id":"CCR-20260901-001"}
```

`manifest.json` — extrait des liaisons :

```json
"experts": {
  "author":     { "provider": "claude", "session_id": null },
  "challenger": { "provider": "codex",  "session_id": null }
}
```

Aucune session native n'a été créée : les deux slots portent `null`.

---

## 4. Surface de lecture

Extrait de statut, expurgé :

```text
Run CCR-20260901-001 — Annexe quota — admission a capacite zero
  état        FAILED_INITIALIZATION / HUMAN   round 0   curseur —
  quota CCR   0/0 engagée(s)   restant 0   ÉPUISÉ
  usage CCR   0 invocation(s) · usage fournisseur 0 observée(s) / 0 non observée(s)
  coût estimé 0 estimée(s) · 0 inconnue(s) · aucun catalogue tarifaire
```

---

## 5. Portée

```text
CE QUE RUN B ÉTABLIT       un plafond de 0 est durable, et il refuse
                           l'admission avant tout engagement d'invocation

CE QUE RUN B N'ÉTABLIT PAS la sûreté du quota sous concurrence
```

La propriété de concurrence n'est pas revendiquée par cette traversée. Elle reste
rattachée à son seul historique de qualification, celui de la version `v0.5.0`.
