/**
 * Process Runner — primitive d'exécution de sous-processus de CCR (lot V1.1).
 *
 * Contraintes normatives appliquées ici (spécification V1, §5.x, §34, §46) :
 *
 *  - les processus sont lancés par tableau d'arguments, jamais par
 *    concaténation d'une ligne de commande shell (`shell: false`) ;
 *  - `stdout` et `stderr` restent strictement séparés ;
 *  - le code de sortie est conservé tel quel ;
 *  - un timeout est configurable et se traduit par un drapeau explicite,
 *    jamais par une réponse vide considérée comme valide ;
 *  - un échec de lancement (exécutable absent) est une erreur explicite ;
 *  - aucune variable d'environnement n'est journalisée.
 *
 * Ce module ne connaît ni Claude ni Codex.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { CcrError } from '../core/errors.ts';

/** Plafond par défaut de capture, par flux. Au-delà, le flux est marqué tronqué. */
export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Délai laissé à un processus POSIX entre SIGTERM et SIGKILL. */
const KILL_GRACE_MS = 5_000;

export interface ProcessSpec {
  /** Chemin ou nom de l'exécutable. Aucun shell n'est utilisé pour le résoudre. */
  readonly executable: string;
  readonly args: readonly string[];
  /** Répertoire de travail canonique du run. */
  readonly cwd: string;
  /** Délai maximal en millisecondes. `0` ou négatif désactive le timeout. */
  readonly timeoutMs: number;
  /**
   * Charge utile écrite sur l'entrée standard puis fermée.
   * Si absent, `stdin` est explicitement fermé (`ignore`) : certaines CLI
   * attendent indéfiniment une entrée si le descripteur reste ouvert.
   */
  readonly stdin?: string;
  /** Environnement de base. Par défaut celui du processus CCR. */
  readonly env?: NodeJS.ProcessEnv;
  /** Variables retirées de l'environnement transmis à l'enfant. */
  readonly unsetEnv?: readonly string[];
  readonly maxOutputBytes?: number;
}

export interface ProcessResult {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly pid: number | undefined;
  /** `null` lorsque le processus a été terminé par un signal. */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Vrai si CCR a tué le processus parce que le délai a expiré. */
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

export interface InteractiveSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly unsetEnv?: readonly string[];
}

export interface InteractiveResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

interface Collector {
  push(chunk: Buffer): void;
  text(): string;
  isTruncated(): boolean;
}

function createCollector(limitBytes: number): Collector {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;

  return {
    push(chunk: Buffer): void {
      if (size >= limitBytes) {
        truncated = true;
        return;
      }
      const remaining = limitBytes - size;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        size = limitBytes;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    },
    text(): string {
      return Buffer.concat(chunks).toString('utf8');
    },
    isTruncated(): boolean {
      return truncated;
    },
  };
}

/**
 * Construit l'environnement transmis à l'enfant.
 *
 * CCR ne fabrique aucun credential et n'en retire aucun par défaut : il
 * transmet l'environnement du processus courant afin que les CLI officielles
 * utilisent leur authentification normale. `unsetEnv` existe uniquement pour
 * les cas où CCR est lui-même lancé depuis un agent qui injecte des variables
 * susceptibles de perturber le client enfant.
 */
export function buildChildEnv(spec: Pick<ProcessSpec, 'env' | 'unsetEnv'>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(spec.env ?? process.env) };
  for (const name of spec.unsetEnv ?? []) {
    delete env[name];
  }
  return env;
}

/**
 * Description d'une commande destinée aux journaux.
 * Les arguments longs sont tronqués ; l'environnement n'apparaît jamais.
 */
export function describeCommand(
  spec: Pick<ProcessSpec, 'executable' | 'args'>,
  maxArgLength = 120,
): string {
  const args = spec.args.map((arg) =>
    arg.length > maxArgLength ? `${arg.slice(0, maxArgLength)}…[${arg.length}]` : arg,
  );
  return [spec.executable, ...args].join(' ');
}

function launchError(spec: ProcessSpec | InteractiveSpec, cause: unknown): CcrError {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new CcrError(
      'EXECUTABLE_NOT_FOUND',
      `Exécutable introuvable : ${spec.executable}`,
      { details: { executable: spec.executable, cwd: spec.cwd }, cause },
    );
  }
  return new CcrError(
    'PROCESS_LAUNCH_FAILED',
    `Échec du lancement de ${spec.executable} (${String(code ?? 'inconnu')})`,
    { details: { executable: spec.executable, cwd: spec.cwd, errno: code ?? null }, cause },
  );
}

/**
 * Termine un processus et, sur Windows, sa descendance.
 *
 * `child.kill()` ne tue pas l'arbre sous Windows ; `taskkill /T` est la
 * primitive officielle correspondante. Elle est invoquée par tableau
 * d'arguments, sans shell.
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* le processus n'a jamais démarré */
    }
    return;
  }

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        shell: false,
      });
      killer.on('error', () => {
        try {
          child.kill();
        } catch {
          /* déjà terminé */
        }
      });
    } catch {
      try {
        child.kill();
      } catch {
        /* déjà terminé */
      }
    }
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
    /* déjà terminé */
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* déjà terminé */
    }
  }, KILL_GRACE_MS).unref();
}

/**
 * Exécute un processus non interactif et capture ses flux.
 *
 * Résout toujours avec un `ProcessResult`, y compris pour un code de sortie
 * non nul ou un timeout : c'est à l'appelant (adapter) de décider ce que cela
 * signifie. Rejette uniquement lorsque le processus n'a pas pu être lancé.
 */
export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const limit = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const stdout = createCollector(limit);
    const stderr = createCollector(limit);

    let timedOut = false;
    let settled = false;

    let child: ChildProcess;
    try {
      child = spawn(spec.executable, [...spec.args], {
        cwd: spec.cwd,
        env: buildChildEnv(spec),
        shell: false,
        windowsHide: true,
        stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (cause) {
      reject(launchError(spec, cause));
      return;
    }

    const timer =
      spec.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
          }, spec.timeoutMs)
        : undefined;

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

    if (spec.stdin !== undefined && child.stdin !== null) {
      // Le client peut se terminer avant d'avoir tout lu : EPIPE n'est pas
      // une erreur CCR, le code de sortie fait foi.
      child.stdin.on('error', () => undefined);
      child.stdin.end(spec.stdin, 'utf8');
    }

    child.on('error', (cause) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      reject(launchError(spec, cause));
    });

    // `close` (et non `exit`) garantit que les flux ont été entièrement lus.
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      const completedAtMs = Date.now();
      resolve({
        executable: spec.executable,
        args: [...spec.args],
        cwd: spec.cwd,
        pid: child.pid,
        exitCode: code,
        signal,
        timedOut,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.isTruncated(),
        stderrTruncated: stderr.isTruncated(),
        startedAt,
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: completedAtMs - startedAtMs,
      });
    });
  });
}

/**
 * Lance un processus interactif attaché au terminal courant (handoff humain).
 *
 * Aucun flux n'est capturé : l'humain dialogue directement avec la CLI
 * officielle. CCR n'observe que la durée et le code de sortie.
 */
export function runInteractiveProcess(spec: InteractiveSpec): Promise<InteractiveResult> {
  return new Promise<InteractiveResult>((resolve, reject) => {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();

    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(spec.executable, [...spec.args], {
        cwd: spec.cwd,
        env: buildChildEnv(spec),
        shell: false,
        stdio: 'inherit',
      });
    } catch (cause) {
      reject(launchError(spec, cause));
      return;
    }

    child.on('error', (cause) => {
      if (settled) return;
      settled = true;
      reject(launchError(spec, cause));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      const completedAtMs = Date.now();
      resolve({
        exitCode: code,
        signal,
        startedAt,
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: completedAtMs - startedAtMs,
      });
    });
  });
}
