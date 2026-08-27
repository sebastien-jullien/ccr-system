/**
 * Client Chrome DevTools Protocol minimal.
 *
 * Objectif : obtenir une **vraie** preuve navigateur sans introduire de
 * dépendance. Node 22 fournit `WebSocket` en global et Windows fournit déjà
 * Chrome ou Edge ; il ne manquait qu'une centaine de lignes de protocole.
 *
 * Ce module ne prétend pas remplacer un pilote complet : il ouvre un onglet,
 * navigue, évalue des expressions, et écoute la console et le réseau. C'est
 * exactement ce que le Slice 3 doit prouver, et rien de plus.
 *
 * Si aucun navigateur n'est installé, l'appelant doit conclure `NOT_TESTED` —
 * jamais installer quoi que ce soit pour obtenir un statut plus flatteur.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

/** Navigateur système déjà installé, ou `undefined`. Aucune installation. */
export function findBrowser(): string | undefined {
  return CANDIDATES.find((candidate) => existsSync(candidate));
}

interface Pending {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
}

export interface ConsoleEntry {
  readonly level: string;
  readonly text: string;
}

/**
 * Requête observée, avec son **initiateur**.
 *
 * L'initiateur est ce qui permet de distinguer une requête émise par le code de
 * la page d'une requête injectée par l'environnement — une extension du poste,
 * par exemple. Sans lui, on ne pourrait qu'affirmer « il n'y a pas de requête
 * externe », ce qui serait faux, ou tout accepter, ce qui ne prouverait rien.
 */
export interface ObservedRequest {
  readonly url: string;
  readonly initiatorType: string;
  /** URLs de la pile d'appel de l'initiateur, quand elle existe. */
  readonly initiatorUrls: readonly string[];
}

export class BrowserSession {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private sessionId = '';
  readonly consoleEntries: ConsoleEntry[] = [];
  readonly requests: ObservedRequest[] = [];
  /** En-têtes réellement reçus par le navigateur, par URL. */
  readonly responseHeaders = new Map<string, Record<string, string>>();

  private readonly socket: WebSocket;
  private readonly child: ChildProcess;
  private readonly profileDir: string;

  // Champs explicites : les propriétés de paramètre ne sont pas du TypeScript
  // effaçable, et ce dépôt exige que le typage disparaisse sans transformation.
  private constructor(socket: WebSocket, child: ChildProcess, profileDir: string) {
    this.socket = socket;
    this.child = child;
    this.profileDir = profileDir;
  }

  static async launch(executable: string): Promise<BrowserSession> {
    const profileDir = await mkdtemp(path.join(tmpdir(), 'ccr-cdp-'));
    const child = spawn(
      executable,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        'about:blank',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], shell: false },
    );

    const endpoint = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error(`DevTools introuvable. Sortie : ${buffer}`)), 30_000);
      child.stderr?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const match = /ws:\/\/[^\s]+/.exec(buffer);
        if (match === null) return;
        clearTimeout(timer);
        resolve(match[0]);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Le navigateur s'est arrêté (code ${String(code)}). Sortie : ${buffer}`));
      });
    });

    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('WebSocket DevTools inaccessible')), { once: true });
    });

    const session = new BrowserSession(socket, child, profileDir);
    socket.addEventListener('message', (event) => session.handle(String(event.data)));

    const target = await session.send('Target.createTarget', { url: 'about:blank' });
    const attached = await session.send('Target.attachToTarget', {
      targetId: target['targetId'],
      flatten: true,
    });
    session.sessionId = String(attached['sessionId']);

    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Log.enable');
    await session.send('Network.enable');
    return session;
  }

  private handle(raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>;
    const id = message['id'];
    if (typeof id === 'number') {
      const pending = this.pending.get(id);
      if (pending === undefined) return;
      this.pending.delete(id);
      const error = message['error'] as { message?: string } | undefined;
      if (error !== undefined) pending.reject(new Error(error.message ?? 'erreur CDP'));
      else pending.resolve((message['result'] ?? {}) as Record<string, unknown>);
      return;
    }

    const method = message['method'];
    const params = (message['params'] ?? {}) as Record<string, unknown>;
    if (method === 'Runtime.consoleAPICalled') {
      const args = (params['args'] ?? []) as { value?: unknown; description?: string }[];
      this.consoleEntries.push({
        level: String(params['type']),
        text: args.map((arg) => String(arg.value ?? arg.description ?? '')).join(' '),
      });
    } else if (method === 'Log.entryAdded') {
      const entry = params['entry'] as { level?: string; text?: string };
      this.consoleEntries.push({ level: String(entry.level), text: String(entry.text) });
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params['exceptionDetails'] as { text?: string };
      this.consoleEntries.push({ level: 'error', text: String(details.text) });
    } else if (method === 'Network.responseReceived') {
      const response = params['response'] as { url?: string; headers?: Record<string, string> };
      this.responseHeaders.set(String(response.url), response.headers ?? {});
    } else if (method === 'Network.requestWillBeSent') {
      const requested = params['request'] as { url?: string };
      const initiator = (params['initiator'] ?? {}) as {
        type?: string;
        url?: string;
        stack?: { callFrames?: { url?: string }[] };
      };
      const urls = [
        ...(initiator.url === undefined ? [] : [initiator.url]),
        ...(initiator.stack?.callFrames ?? []).map((frame) => String(frame.url ?? '')),
      ].filter((value) => value.length > 0);
      this.requests.push({
        url: String(requested.url),
        initiatorType: String(initiator.type ?? 'unknown'),
        initiatorUrls: urls,
      });
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (this.sessionId.length > 0 && !method.startsWith('Target.')) payload['sessionId'] = this.sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Délai dépassé pour ${method}`));
      }, 30_000);
    });
  }

  /** Navigue et attend que la page ait terminé son chargement. */
  async navigate(url: string): Promise<void> {
    const loaded = this.once('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded;
  }

  private once(method: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Événement ${method} non reçu`)), 30_000);
      const listener = (event: MessageEvent): void => {
        const message = JSON.parse(String(event.data)) as { method?: string };
        if (message.method !== method) return;
        clearTimeout(timer);
        this.socket.removeEventListener('message', listener);
        resolve();
      };
      this.socket.addEventListener('message', listener);
    });
  }

  /** Évalue une expression et rend sa valeur JSON. */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const details = result['exceptionDetails'] as { text?: string } | undefined;
    if (details !== undefined) throw new Error(`Évaluation en échec : ${details.text ?? ''}`);
    return (result['result'] as { value: T }).value;
  }

  /** Attend qu'une expression devienne vraie, sans jamais boucler indéfiniment. */
  async waitFor(expression: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.evaluate<boolean>(`Boolean(${expression})`)) return;
      if (Date.now() > deadline) throw new Error(`Condition jamais vraie : ${expression}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async close(): Promise<void> {
    try {
      this.socket.close();
    } catch {
      // Fermeture au mieux : le processus est tué juste après.
    }
    this.child.kill('SIGKILL');
    await new Promise((resolve) => this.child.on('close', resolve));
    await rm(this.profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
