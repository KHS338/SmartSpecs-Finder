import { Injectable, Logger } from '@nestjs/common';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Builder, By, until, WebDriver } from 'selenium-webdriver';
import * as chrome from 'selenium-webdriver/chrome';
import 'chromedriver';
import * as ExcelJS from 'exceljs';

export interface PhoneData {
  id: string;
  name: string;
  price: number;
  url: string;
  colors: string[];
  storageOptions: string[];
  specs: Record<string, string>;
  formattedText: string;
}

export interface ScrapeRunResult {
  phones: PhoneData[];
  excelFilePath: string;
}

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);
  private readonly LISTING_URL_BASE =
    'https://priceoye.pk/mobiles/pricelist?sort=price_desc&page=';
  private readonly START_PAGE = 1;
  private readonly MAX_PAGES = 200;

  async scrapeAndExportPhones(): Promise<ScrapeRunResult> {
    const phones = await this.scrapePhones();
    const excelFilePath = await this.exportPhonesToExcel(phones);

    return {
      phones,
      excelFilePath,
    };
  }

  async scrapePhones(): Promise<PhoneData[]> {
    this.logger.log(`Spinning up Headless Chrome for deep scraping...`);
    const phones: PhoneData[] = [];

    const options = new chrome.Options();
    options.addArguments('--headless=new');
    options.addArguments('--disable-gpu');
    options.addArguments('--no-sandbox');
    options.addArguments('--disable-dev-shm-usage');
    options.addArguments('window-size=1920x1080');

    const driver = await new Builder()
      .forBrowser('chrome')
      .setChromeOptions(options)
      .build();

    try {
      // --- STAGE 1: Crawl all listing pages and collect product URLs ---
      const productUrls = await this.collectAllProductUrls(driver);

      this.logger.log(
        `Found ${productUrls.length} phone URLs. Starting deep dive...`,
      );

      // --- STAGE 2: Deep Dive into each URL ---
      for (let i = 0; i < productUrls.length; i++) {
        const url = productUrls[i];
        this.logger.log(`Scraping specs from: ${url}`);

        await driver.get(url);

        // Wait for the main heading to ensure page loaded
        await driver.wait(
          until.elementLocated(By.css('.product-title-text')),
          10000,
        );

        // 1. Name
        const nameEl = await driver.findElement(By.css('.product-title-text'));
        const name = (await nameEl.getText()).trim();

        // 2. Price
        let price = 0;
        try {
          const priceEl = await driver.findElement(
            By.css('.summary-price.price-size-lg.bold span'),
          );
          const priceText = await priceEl.getText();
          price = parseInt(priceText.replace(/[^0-9]/g, ''), 10);
          if (Number.isNaN(price)) {
            this.logger.warn(`Parsed price is invalid for ${name}`);
            continue;
          }
        } catch {
          this.logger.warn(`Could not find price for ${name}`);
          continue; // Skip if no price
        }

        const phoneData: PhoneData = {
          id: `phone_${i}`,
          name,
          price,
          url,
          colors: [],
          storageOptions: [],
          specs: {},
          formattedText: '',
        };

        // 3. Colors
        try {
          const colorEls = await driver.findElements(
            By.css('ul.colors li .color-name span'),
          );
          for (const el of colorEls) {
            const color = (await el.getText()).trim();
            if (color) phoneData.colors.push(color);
          }
        } catch {
          /* Ignore if no colors listed */
        }

        // 4. Storage Variants
        try {
          const storageEls = await driver.findElements(
            By.css('.size-item a span'),
          );
          for (const el of storageEls) {
            const text = await el.getText();
            if (text) phoneData.storageOptions.push(text);
          }
        } catch {
          /* Ignore */
        }

        // 5. Expand and extract the spec table from the product specs section
        try {
          await this.scrollForSpecs(driver);
          await this.ensureSpecsExpanded(driver);

          phoneData.specs = await this.extractSpecsFromDom(driver);

          if (Object.keys(phoneData.specs).length === 0) {
            phoneData.specs = await this.extractSpecsFromPageSource(driver);
          }

          if (Object.keys(phoneData.specs).length === 0) {
            phoneData.specs = await this.extractQuickSpecsFromDom(driver);
          }

          this.logger.debug(
            `Extracted ${Object.keys(phoneData.specs).length} specs for ${phoneData.name}`,
          );
        } catch {
          this.logger.warn(
            `Failed to extract specs table for ${phoneData.name}`,
          );
        }

        // 6. Format for the LLM
        phoneData.formattedText = `
Product Name: ${phoneData.name}
Current Price: ${phoneData.price} PKR
Available Colors: ${phoneData.colors.join(', ')}
Storage Options: ${phoneData.storageOptions.join(', ')}
--- Specifications ---
${Object.entries(phoneData.specs)
  .map(([k, v]) => `${k}: ${v}`)
  .join('\n')}
Product URL: ${phoneData.url}
        `.trim();

        phones.push(phoneData);
      }

      this.logger.log(
        `Successfully extracted detailed data for ${phones.length} smartphones.`,
      );
      return phones;
    } catch (error) {
      this.logger.error('Selenium scraping failed catastrophically:', error);
      throw error;
    } finally {
      await driver.quit();
      this.logger.log('Browser instance destroyed.');
    }
  }

  private async collectAllProductUrls(driver: WebDriver): Promise<string[]> {
    const urlSet = new Set<string>();
    let page = this.START_PAGE;
    let pagesWithoutNewUrls = 0;

    while (page <= this.MAX_PAGES) {
      const pageUrl = `${this.LISTING_URL_BASE}${page}`;
      this.logger.log(`Scanning listing page ${page}: ${pageUrl}`);

      await driver.get(pageUrl);

      try {
        await driver.wait(until.elementLocated(By.css('.productBox')), 8000);
      } catch {
        this.logger.log(
          `No product cards found on listing page ${page}. Stopping pagination.`,
        );
        break;
      }

      const productElements = await driver.findElements(By.css('.productBox'));
      if (productElements.length === 0) {
        this.logger.log(
          `Listing page ${page} has 0 product cards. Stopping pagination.`,
        );
        break;
      }

      let addedThisPage = 0;
      for (const productEl of productElements) {
        try {
          const linkEl = await productEl.findElement(By.css('a'));
          const url = await linkEl.getAttribute('href');
          if (url && !urlSet.has(url)) {
            urlSet.add(url);
            addedThisPage++;
          }
        } catch {
          // Ignore malformed cards and continue.
        }
      }

      this.logger.log(
        `Page ${page}: found ${productElements.length} cards, added ${addedThisPage} new URLs.`,
      );

      if (addedThisPage === 0) {
        pagesWithoutNewUrls += 1;
      } else {
        pagesWithoutNewUrls = 0;
      }

      // Stop if we reached pagination tail or a repeated page pattern.
      if (pagesWithoutNewUrls >= 2) {
        this.logger.log(
          'Two consecutive pages added no new URLs. Assuming end of listings.',
        );
        break;
      }

      page += 1;
    }

    return [...urlSet];
  }

  private async ensureSpecsExpanded(driver: WebDriver): Promise<void> {
    try {
      await driver.executeScript(`
        const btn = document.querySelector('#product-specs .see-more-btn, .see-more-btn');
        if (!btn) return;

        btn.scrollIntoView({ block: 'center' });
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text.includes('show more')) {
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
      `);

      await driver.sleep(700);
    } catch {
      this.logger.debug(
        'Could not force-expand specs section, continuing with visible specs.',
      );
    }
  }

  private async scrollForSpecs(driver: WebDriver): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const hasSpecs = await driver.executeScript(`
        return Boolean(
          document.querySelector('#product-specs .spec-term') ||
          document.querySelector('#product-specs .bullet-specs li') ||
          document.querySelector('.p-spec-table .spec-term')
        );
      `);

      if (hasSpecs) {
        return;
      }

      await driver.executeScript('window.scrollBy(0, 900);');
      if (i % 3 === 2) {
        await driver.executeScript(
          'window.scrollTo(0, document.body.scrollHeight);',
        );
      }
      await driver.sleep(450);
    }

    await driver.executeScript(`
      const trigger = document.querySelector(
        'a[href="#product-specs"], [data-target="#product-specs"], [data-section-name="Specifications"]'
      );
      if (trigger) {
        trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    `);
    await driver.sleep(600);
  }

  private async extractSpecsFromDom(
    driver: WebDriver,
  ): Promise<Record<string, string>> {
    const specs = await driver.executeScript(`
      const output = {};
      const section = document.querySelector('#product-specs') || document;
      const cards = section.querySelectorAll('.p-spec-table');

      cards.forEach((card) => {
        const sectionTitle = (card.querySelector('h6')?.textContent || '').trim();
        const terms = card.querySelectorAll('dt.spec-term');
        const details = card.querySelectorAll('dd.spec-detail');
        const count = Math.min(terms.length, details.length);

        for (let i = 0; i < count; i++) {
          const term = (terms[i].textContent || '').trim();
          const detail = (details[i].textContent || '').trim();
          if (!term) continue;
          const key = sectionTitle ? sectionTitle + ' - ' + term : term;
          output[key] = detail;
        }
      });

      if (Object.keys(output).length === 0) {
        const terms = section.querySelectorAll('.spec-term');
        const details = section.querySelectorAll('.spec-detail');
        const count = Math.min(terms.length, details.length);
        for (let i = 0; i < count; i++) {
          const term = (terms[i].textContent || '').trim();
          const detail = (details[i].textContent || '').trim();
          if (term) output[term] = detail;
        }
      }

      return output;
    `);

    return (specs ?? {}) as Record<string, string>;
  }

  private async extractSpecsFromPageSource(
    driver: WebDriver,
  ): Promise<Record<string, string>> {
    const html = await driver.getPageSource();
    const specs: Record<string, string> = {};

    const pairRegex =
      /<dt[^>]*class="[^"]*spec-term[^"]*"[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*class="[^"]*spec-detail[^"]*"[^>]*>([\s\S]*?)<\/dd>/gi;

    for (const match of html.matchAll(pairRegex)) {
      const rawTerm = match[1] ?? '';
      const rawDetail = match[2] ?? '';

      const term = rawTerm
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const detail = rawDetail
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (term) {
        specs[term] = detail;
      }
    }

    return specs;
  }

  private async extractQuickSpecsFromDom(
    driver: WebDriver,
  ): Promise<Record<string, string>> {
    const quickSpecs = await driver.executeScript(`
      const section = document.querySelector('#product-specs') || document;
      const output = {};
      const items = section.querySelectorAll('.bullet-specs li');

      items.forEach((item) => {
        const key = (item.querySelector('.spec-desc span')?.textContent || '').trim();
        const value = (item.querySelector('.spec-desc strong')?.textContent || '').trim();
        if (key && value) {
          output['Quick Specs - ' + key] = value;
        }
      });

      return output;
    `);

    const normalized: Record<string, string> = {};
    if (!quickSpecs || typeof quickSpecs !== 'object') {
      return normalized;
    }

    for (const [key, value] of Object.entries(
      quickSpecs as Record<string, unknown>,
    )) {
      if (typeof value === 'string') {
        normalized[key] = value;
      } else if (
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        typeof value === 'bigint'
      ) {
        normalized[key] = `${value}`;
      } else if (value && typeof value === 'object') {
        const json = JSON.stringify(value);
        if (json) {
          normalized[key] = json;
        }
      }
    }

    return normalized;
  }

  private async exportPhonesToExcel(phones: PhoneData[]): Promise<string> {
    const workbook = new ExcelJS.Workbook();
    const phonesSheet = workbook.addWorksheet('Phones');

    phonesSheet.columns = [
      { header: 'ID', key: 'id', width: 16 },
      { header: 'Name', key: 'name', width: 40 },
      { header: 'Price (PKR)', key: 'price', width: 16 },
      { header: 'URL', key: 'url', width: 55 },
      { header: 'Colors', key: 'colors', width: 28 },
      { header: 'Storage Options', key: 'storageOptions', width: 28 },
      { header: 'Specs (JSON)', key: 'specs', width: 60 },
      { header: 'Formatted Text', key: 'formattedText', width: 80 },
    ];

    for (const phone of phones) {
      phonesSheet.addRow({
        id: phone.id,
        name: phone.name,
        price: phone.price,
        url: phone.url,
        colors: phone.colors.join(', '),
        storageOptions: phone.storageOptions.join(', '),
        specs: JSON.stringify(phone.specs),
        formattedText: phone.formattedText,
      });
    }

    const specsSheet = workbook.addWorksheet('Specs');
    specsSheet.columns = [
      { header: 'Phone ID', key: 'phoneId', width: 16 },
      { header: 'Phone Name', key: 'phoneName', width: 40 },
      { header: 'Spec Key', key: 'specKey', width: 30 },
      { header: 'Spec Value', key: 'specValue', width: 50 },
    ];

    for (const phone of phones) {
      for (const [specKey, specValue] of Object.entries(phone.specs)) {
        specsSheet.addRow({
          phoneId: phone.id,
          phoneName: phone.name,
          specKey,
          specValue,
        });
      }
    }

    const exportsDir = join(process.cwd(), 'exports');
    await mkdir(exportsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = join(exportsDir, `scrape-${timestamp}.xlsx`);
    await workbook.xlsx.writeFile(filePath);

    this.logger.log(`Scraping data exported to Excel: ${filePath}`);
    return filePath;
  }
}
