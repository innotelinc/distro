import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { atom, type WritableAtom } from 'nanostores';
import type { ITerminal } from '~/types/terminal';
import { newBoltShellProcess, newShellProcess } from '~/utils/shell';
import { coloredText } from '~/utils/terminal';

export class TerminalStore {
  #webcontainer: Promise<WebContainer>;
  #terminals: Array<{ terminal: ITerminal; process: WebContainerProcess }> = [];
  #boltTerminal = newBoltShellProcess();

  showTerminal: WritableAtom<boolean> = import.meta.hot?.data.showTerminal ?? atom(true);

  constructor(webcontainerPromise: Promise<WebContainer>) {
    this.#webcontainer = webcontainerPromise;

    if (import.meta.hot) {
      import.meta.hot.data.showTerminal = this.showTerminal;
    }
  }
  get boltTerminal() {
    return this.#boltTerminal;
  }

  toggleTerminal(value?: boolean) {
    this.showTerminal.set(value !== undefined ? value : !this.showTerminal.get());
  }

  /** Why WebContainer (terminal/preview) cannot run on this origin, or null.
   *  WebContainer needs cross-origin isolation, which browsers only grant on
   *  trustworthy origins (HTTPS or http://localhost / 127.0.0.1). Plain HTTP
   *  from a LAN IP/hostname chats fine but can never boot the container. */
  static blockedReason(): string | null {
    if (typeof window === 'undefined') return null;
    if (window.isSecureContext !== true) {
      return 'This page is not on a secure origin (HTTPS or localhost), so the browser blocks WebContainer — the live preview and terminal cannot connect. Chat still works. Open the app via https:// or http://localhost:5173.';
    }
    if (window.crossOriginIsolated !== true) {
      return 'Cross-origin isolation is not active on this page (COOP/COEP headers missing), so WebContainer — the live preview and terminal — cannot connect. Serve the app over HTTPS or localhost so the headers take effect.';
    }
    return null;
  }

  async attachBoltTerminal(terminal: ITerminal) {
    const blocked = TerminalStore.blockedReason();
    if (blocked) {
      terminal.write(coloredText.red('WebContainer unavailable\n\n') + blocked + '\n');
      return;
    }
    try {
      const wc = await this.#webcontainer;
      await this.#boltTerminal.init(wc, terminal);
    } catch (error: any) {
      terminal.write(coloredText.red('Failed to spawn shell\n\n') + error.message);
      return;
    }
  }

  async attachTerminal(terminal: ITerminal) {
    const blocked = TerminalStore.blockedReason();
    if (blocked) {
      terminal.write(coloredText.red('WebContainer unavailable\n\n') + blocked + '\n');
      return;
    }
    try {
      const shellProcess = await newShellProcess(await this.#webcontainer, terminal);
      this.#terminals.push({ terminal, process: shellProcess });
    } catch (error: any) {
      terminal.write(coloredText.red('Failed to spawn shell\n\n') + error.message);
      return;
    }
  }

  onTerminalResize(cols: number, rows: number) {
    for (const { process } of this.#terminals) {
      process.resize({ cols, rows });
    }
  }
}
