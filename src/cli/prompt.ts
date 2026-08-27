/**
 * Confirmation interactive `[y/N]` (spécification V1.1, §15.5, INV-11-03).
 *
 * Une seule forme de question existe dans CCR, et elle est imposée par cette
 * primitive plutôt que laissée à chaque appelant : le suffixe `[y/N]` est
 * ajouté ici, et le défaut est **NON**.
 *
 * Règle de lecture, volontairement pauvre :
 *
 *   y, Y, yes, YES  → oui
 *   tout le reste   → non
 *
 * Entrée vide, `Enter`, `n`, réponse non reconnue, flux fermé : non. Aucune
 * relance n'est tentée — une question répétée finit par être expédiée, et le
 * consentement doit rester un acte, pas une formalité.
 *
 * Ce n'est pas un moteur de formulaires : une question, une réponse booléenne.
 */

import { createInterface } from 'node:readline/promises';

export type Confirm = (question: string) => Promise<boolean>;

/**
 * Interprète une réponse brute.
 *
 * Aucune valeur inconnue ne vaut oui : c'est la propriété centrale, et elle
 * est testée pour elle-même.
 */
export function interpretConfirmAnswer(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
}

/** Formulation unique des invites, défaut NON visible. */
export function formatConfirmQuestion(question: string): string {
  return `${question} [y/N] `;
}

export interface TerminalPrompt {
  readonly confirm: Confirm;
  close(): void;
}

/**
 * Confirmation lue sur le terminal.
 *
 * L'interface `readline` est créée une fois pour toute la commande et fermée
 * par l'appelant : ouvrir un flux par question laisserait des descripteurs
 * ouverts derrière une commande interrompue.
 */
export function createTerminalPrompt(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): TerminalPrompt {
  const rl = createInterface({ input, output });
  let closed = false;

  return {
    async confirm(question: string): Promise<boolean> {
      if (closed) return false;
      try {
        return interpretConfirmAnswer(await rl.question(formatConfirmQuestion(question)));
      } catch {
        // Flux interrompu ou fermé : l'absence de réponse n'est pas un oui.
        return false;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      rl.close();
    },
  };
}
