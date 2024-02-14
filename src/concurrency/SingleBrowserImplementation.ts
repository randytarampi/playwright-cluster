import * as playwright from 'playwright';
import { ConcurrencyImplementation, ResourceData } from './ConcurrencyImplementation';

import { debugGenerator, timeoutExecute } from '../util';

const debug = debugGenerator('SingleBrowserImpl');

const BROWSER_TIMEOUT = 5000;

export abstract class SingleBrowserImplementation extends ConcurrencyImplementation {
  protected browser: playwright.Browser | null = null;

  private repairing = false;
  private repairRequested = false;
  private openInstances = 0;
  private waitingForRepairResolvers: (() => void)[] = [];

  public constructor(
    options: playwright.LaunchOptions,
    contextOptions: playwright.BrowserContextOptions,
    playwright: any
  ) {
    super(options, contextOptions, playwright);
  }

  protected async repair() {
    if (this.openInstances !== 0 || this.repairing) {
      // already repairing or there are still pages open? wait for start/finish
      await new Promise<void>((resolve) => this.waitingForRepairResolvers.push(resolve));
      return;
    }

    this.repairing = true;
    debug('Starting repair');

    try {
      // will probably fail, but just in case the repair was not necessary
      await (this.browser as playwright.Browser).close();
    } catch (e) {
      /* istanbul ignore next */
      debug('Unable to close browser.');
    }

    try {
      this.browser = (await this.playwright.chromium.launch(this.options)) as playwright.Browser;
    } catch (err) {
      /* istanbul ignore next */
      throw new Error('Unable to restart browser.');
    }
    this.repairRequested = false;
    this.repairing = false;
    this.waitingForRepairResolvers.forEach((resolve) => resolve());
    this.waitingForRepairResolvers = [];
    debug('Repair finished');
  }

  public async init() {
    this.browser = await this.playwright.chromium.launch(this.options);
  }

  public async close() {
    await (this.browser as playwright.Browser).close();
  }

  protected abstract createResources(): Promise<ResourceData>;

  protected abstract freeResources(resources: ResourceData): Promise<void>;

  public async workerInstance() {
    let resources: ResourceData;

    return {
      jobInstance: async () => {
        if (this.repairRequested) {
          await this.repair();
        }

        await timeoutExecute(
          BROWSER_TIMEOUT,
          (async () => {
            resources = await this.createResources();
          })()
        );
        this.openInstances += 1;

        return {
          resources,

          close: async () => {
            this.openInstances -= 1; // decrement first in case of error
            await timeoutExecute(BROWSER_TIMEOUT, this.freeResources(resources));

            /* istanbul ignore next */
            if (this.repairRequested) {
              await this.repair();
            }
          },
        };
      },

      close: async () => {},

      repair: async () => {
        debug('Repair requested');
        this.repairRequested = true;
        await this.repair();
      },
    };
  }
}
