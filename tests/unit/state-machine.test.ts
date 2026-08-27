/**
 * Tests unitaires de la machine d'état V1 (spécification V0.2, §18).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTROL_OWNERS,
  RUN_STATES,
  allowedTransitionsFrom,
  assertTransition,
  isControlOwner,
  isRunState,
  isTransitionAllowed,
  stateAfterTurnFrom,
} from '../../src/core/state.ts';
import type { RunState } from '../../src/core/state.ts';
import { isCcrError } from '../../src/core/errors.ts';

test('la machine V1 comporte exactement les neuf états exécutables', () => {
  assert.deepEqual([...RUN_STATES], [
    'READY',
    'RUNNING',
    'WAITING_AGENT',
    'WAITING_HUMAN',
    'PAUSED',
    'RECOVERY_REQUIRED',
    'FAILED_INITIALIZATION',
    'FAILED',
    'CLOSED',
  ]);
});

test("CONVERGED n'appartient pas au runtime V1 (amendement A-3)", () => {
  assert.equal(isRunState('CONVERGED'), false);
  assert.ok(!(RUN_STATES as readonly string[]).includes('CONVERGED'));
});

test('WAITING_EVIDENCE relève de la doctrine, pas du runtime V1', () => {
  assert.equal(isRunState('WAITING_EVIDENCE'), false);
});

test('le contrôle est une dimension séparée à deux valeurs', () => {
  assert.deepEqual([...CONTROL_OWNERS], ['AUTOMATION', 'HUMAN']);
  assert.equal(isControlOwner('AUTOMATION'), true);
  assert.equal(isControlOwner('HUMAN'), true);
  assert.equal(isControlOwner('AUTOMATISATION'), false);
});

test('les transitions nominales du cycle de vie sont autorisées', () => {
  const nominal: ReadonlyArray<readonly [RunState, RunState]> = [
    ['READY', 'RUNNING'],
    ['RUNNING', 'WAITING_AGENT'],
    ['WAITING_AGENT', 'RUNNING'],
    ['RUNNING', 'READY'],
    ['READY', 'PAUSED'],
    ['PAUSED', 'READY'],
    ['WAITING_AGENT', 'RECOVERY_REQUIRED'],
    ['RECOVERY_REQUIRED', 'READY'],
    ['FAILED_INITIALIZATION', 'READY'],
    ['READY', 'CLOSED'],
  ];

  for (const [from, to] of nominal) {
    assert.equal(isTransitionAllowed(from, to), true, `${from} → ${to} devrait être autorisée`);
  }
});

test('un envoi humain peut emprunter WAITING_AGENT depuis un run suspendu ou bloqué', () => {
  // Amendement A-7 : `ccr send` reste utilisable sous contrôle humain, et tout
  // appel agent doit passer par WAITING_AGENT avant d'être considéré lancé.
  const humanSend: ReadonlyArray<readonly [RunState, RunState]> = [
    ['PAUSED', 'WAITING_AGENT'],
    ['WAITING_AGENT', 'PAUSED'],
    ['WAITING_HUMAN', 'WAITING_AGENT'],
    ['WAITING_AGENT', 'WAITING_HUMAN'],
  ];

  for (const [from, to] of humanSend) {
    assert.equal(isTransitionAllowed(from, to), true, `${from} → ${to} devrait être autorisée`);
  }
});

test("l'échec d'une création de session produit FAILED_INITIALIZATION", () => {
  assert.equal(isTransitionAllowed('RUNNING', 'FAILED_INITIALIZATION'), true);
  assert.equal(isTransitionAllowed('WAITING_AGENT', 'FAILED_INITIALIZATION'), true);
  // Une initialisation partielle ne survient que sur le chemin de création.
  assert.equal(isTransitionAllowed('READY', 'FAILED_INITIALIZATION'), false);
  assert.equal(isTransitionAllowed('PAUSED', 'FAILED_INITIALIZATION'), false);
});

test('les transitions interdites sont refusées explicitement', () => {
  const forbidden: ReadonlyArray<readonly [RunState, RunState]> = [
    ['CLOSED', 'READY'],
    ['CLOSED', 'RUNNING'],
    ['CLOSED', 'WAITING_AGENT'],
    ['FAILED', 'READY'],
    ['FAILED', 'RUNNING'],
    ['READY', 'WAITING_AGENT'],
    ['RECOVERY_REQUIRED', 'WAITING_AGENT'],
    ['RECOVERY_REQUIRED', 'RUNNING'],
  ];

  for (const [from, to] of forbidden) {
    assert.equal(isTransitionAllowed(from, to), false, `${from} → ${to} devrait être interdite`);
    assert.throws(
      () => assertTransition(from, to),
      (error: unknown) => isCcrError(error) && error.code === 'ILLEGAL_STATE_TRANSITION',
    );
  }
});

test("un run rechargé en ambiguïté ne peut pas repartir sans passer par la reprise", () => {
  // RECOVERY_REQUIRED n'ouvre aucun chemin direct vers un nouveau tour.
  assert.deepEqual([...allowedTransitionsFrom('RECOVERY_REQUIRED')], ['READY', 'PAUSED', 'FAILED', 'CLOSED']);
});

test('stateAfterTurnFrom rend le run à son état de départ (§24.1)', () => {
  assert.equal(stateAfterTurnFrom('PAUSED'), 'PAUSED');
  assert.equal(stateAfterTurnFrom('WAITING_HUMAN'), 'WAITING_HUMAN');
  assert.equal(stateAfterTurnFrom('READY'), 'RUNNING');
  assert.equal(stateAfterTurnFrom('RUNNING'), 'RUNNING');
});

test("un run ne peut pas passer directement de READY à WAITING_AGENT sans passer par RUNNING", () => {
  // Cette contrainte est ce qui rend l'état WAITING_AGENT interprétable :
  // il n'est atteint que lorsqu'une commande a réellement émis un tour.
  assert.equal(isTransitionAllowed('READY', 'WAITING_AGENT'), false);
  assert.ok(allowedTransitionsFrom('RUNNING').includes('WAITING_AGENT'));
});

test('CLOSED est terminal', () => {
  assert.deepEqual([...allowedTransitionsFrom('CLOSED')], []);
});

test("FAILED n'est pas récupérable automatiquement en V1", () => {
  assert.deepEqual([...allowedTransitionsFrom('FAILED')], ['CLOSED']);
});

test("une transition vers le même état est un non-événement, pas une erreur", () => {
  for (const state of RUN_STATES) {
    assert.equal(isTransitionAllowed(state, state), true);
  }
});
