import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as ExcelJS from 'exceljs';
import { PhoneData } from '../scraper/scraper.service';

export interface NormalizedPhoneFeatures {
  id: string;
  name: string;
  company: string;
  model: string;
  pricePkr: number;
  url: string;
  colors: string;
  colorsCount: number;
  storageOptions: string;
  maxStorageGb: number | null;
  batteryMah: number | null;
  screenSizeInches: number | null;
  displayType: string;
  refreshRateHz: number | null;
  ramGb: number | null;
  processor: string;
  operatingSystem: string;
  releaseDate: string;
  simSupport: string;
  has5G: boolean | null;
  hasNfc: boolean | null;
  hasWifi: boolean | null;
  hasBluetooth: boolean | null;
  backCameraMp: number | null;
  frontCameraMp: number | null;
  rawSpecsJson: string;
}

export class FeaturePreprocessor {
  static normalizePhones(phones: PhoneData[]): NormalizedPhoneFeatures[] {
    return phones.map((phone) => this.normalizePhone(phone));
  }

  static async writeAnalyticsWorkbook(
    phones: PhoneData[],
    exportsDir: string,
  ): Promise<string> {
    const normalized = this.normalizePhones(phones);

    const workbook = new ExcelJS.Workbook();
    const normalizedSheet = workbook.addWorksheet('PhonesNormalized');
    normalizedSheet.columns = [
      { header: 'ID', key: 'id', width: 16 },
      { header: 'Name', key: 'name', width: 36 },
      { header: 'Company', key: 'company', width: 20 },
      { header: 'Model', key: 'model', width: 28 },
      { header: 'Price (PKR)', key: 'pricePkr', width: 14 },
      { header: 'URL', key: 'url', width: 54 },
      { header: 'Colors', key: 'colors', width: 32 },
      { header: 'Colors Count', key: 'colorsCount', width: 12 },
      { header: 'Storage Options', key: 'storageOptions', width: 28 },
      { header: 'Max Storage (GB)', key: 'maxStorageGb', width: 16 },
      { header: 'Battery (mAh)', key: 'batteryMah', width: 14 },
      { header: 'Screen Size (in)', key: 'screenSizeInches', width: 16 },
      { header: 'Display Type', key: 'displayType', width: 34 },
      { header: 'Refresh Rate (Hz)', key: 'refreshRateHz', width: 16 },
      { header: 'RAM (GB)', key: 'ramGb', width: 10 },
      { header: 'Processor', key: 'processor', width: 36 },
      { header: 'Operating System', key: 'operatingSystem', width: 22 },
      { header: 'Release Date', key: 'releaseDate', width: 16 },
      { header: 'SIM Support', key: 'simSupport', width: 20 },
      { header: 'Has 5G', key: 'has5G', width: 10 },
      { header: 'Has NFC', key: 'hasNfc', width: 10 },
      { header: 'Has WiFi', key: 'hasWifi', width: 10 },
      { header: 'Has Bluetooth', key: 'hasBluetooth', width: 14 },
      { header: 'Back Camera (MP)', key: 'backCameraMp', width: 16 },
      { header: 'Front Camera (MP)', key: 'frontCameraMp', width: 16 },
      { header: 'Specs (JSON)', key: 'rawSpecsJson', width: 62 },
    ];

    for (const item of normalized) {
      normalizedSheet.addRow(item);
    }

    this.addDisplayAnalyticsSheet(workbook, normalized);
    this.addBatteryAnalyticsSheet(workbook, normalized);

    await mkdir(exportsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = join(exportsDir, `analytics-${timestamp}.xlsx`);
    await workbook.xlsx.writeFile(outputPath);
    return outputPath;
  }

  private static normalizePhone(phone: PhoneData): NormalizedPhoneFeatures {
    const company = this.extractCompany(phone.name);
    const model = this.extractModel(phone.name, company);
    const batteryText = this.findSpecValue(phone.specs, ['battery - type']);
    const screenSizeText = this.findSpecValue(phone.specs, [
      'display - screen size',
    ]);
    const displayTypeText = this.findSpecValue(phone.specs, [
      'display - screen type',
    ]);
    const ramText = this.findSpecValue(phone.specs, ['memory - ram']);
    const storageText = this.findSpecValue(phone.specs, [
      'memory - internal memory',
    ]);
    const processor = this.findSpecValue(phone.specs, [
      'performance - processor',
    ]);
    const operatingSystem = this.findSpecValue(phone.specs, [
      'general features - operating system',
    ]);
    const releaseDate = this.findSpecValue(phone.specs, [
      'general features - release date',
    ]);
    const simSupport = this.findSpecValue(phone.specs, [
      'general features - sim support',
    ]);

    const connectivityText = Object.entries(phone.specs)
      .filter(([key]) => key.toLowerCase().includes('connectivity'))
      .map(([k, v]) => `${k}: ${v}`)
      .join(' | ');

    return {
      id: phone.id,
      name: phone.name,
      company,
      model,
      pricePkr: phone.price,
      url: phone.url,
      colors: phone.colors.join(', '),
      colorsCount: phone.colors.length,
      storageOptions: phone.storageOptions.join(', '),
      maxStorageGb: this.extractMaxStorageGb(
        `${storageText} ${phone.storageOptions.join(' ')}`,
      ),
      batteryMah: this.extractFirstNumberWithUnit(batteryText, 'mah'),
      screenSizeInches: this.extractFirstDecimal(screenSizeText),
      displayType: this.normalizeDisplayType(displayTypeText),
      refreshRateHz: this.extractRefreshRateHz(
        `${displayTypeText} ${phone.formattedText}`,
      ),
      ramGb: this.extractFirstNumberWithUnit(ramText, 'gb'),
      processor,
      operatingSystem,
      releaseDate,
      simSupport,
      has5G: this.extractBoolFromText(connectivityText, '5g'),
      hasNfc: this.extractBoolFromText(connectivityText, 'nfc'),
      hasWifi: this.extractBoolFromText(connectivityText, 'wifi'),
      hasBluetooth: this.extractBoolFromText(connectivityText, 'bluetooth'),
      backCameraMp: this.extractMaxMp(
        this.findSpecValue(phone.specs, ['camera - back camera']),
      ),
      frontCameraMp: this.extractMaxMp(
        this.findSpecValue(phone.specs, ['camera - front camera']),
      ),
      rawSpecsJson: JSON.stringify(phone.specs),
    };
  }

  private static addDisplayAnalyticsSheet(
    workbook: ExcelJS.Workbook,
    rows: NormalizedPhoneFeatures[],
  ): void {
    const sheet = workbook.addWorksheet('DisplayAnalytics');
    sheet.columns = [
      { header: 'Screen Size (in)', key: 'screenSizeInches', width: 16 },
      { header: 'Display Type', key: 'displayType', width: 34 },
      { header: 'Refresh Rate (Hz)', key: 'refreshRateHz', width: 16 },
      { header: 'Count', key: 'count', width: 10 },
    ];

    const grouped = new Map<string, number>();
    for (const row of rows) {
      const key = [
        row.screenSizeInches ?? 'N/A',
        row.displayType || 'N/A',
        row.refreshRateHz ?? 'N/A',
      ].join('|');
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }

    for (const [key, count] of grouped.entries()) {
      const [screenSizeInches, displayType, refreshRateHz] = key.split('|');
      sheet.addRow({
        screenSizeInches,
        displayType,
        refreshRateHz,
        count,
      });
    }
  }

  private static addBatteryAnalyticsSheet(
    workbook: ExcelJS.Workbook,
    rows: NormalizedPhoneFeatures[],
  ): void {
    const sheet = workbook.addWorksheet('BatteryAnalytics');
    sheet.columns = [
      { header: 'Battery (mAh)', key: 'batteryMah', width: 14 },
      { header: 'Count', key: 'count', width: 10 },
      { header: 'Example Phones', key: 'examples', width: 58 },
    ];

    const grouped = new Map<number, string[]>();
    for (const row of rows) {
      if (!row.batteryMah) {
        continue;
      }
      const list = grouped.get(row.batteryMah) ?? [];
      list.push(row.name);
      grouped.set(row.batteryMah, list);
    }

    const sorted = Array.from(grouped.entries()).sort((a, b) => b[0] - a[0]);
    for (const [batteryMah, names] of sorted) {
      sheet.addRow({
        batteryMah,
        count: names.length,
        examples: names.slice(0, 5).join(' | '),
      });
    }
  }

  private static extractCompany(name: string): string {
    return name.trim().split(/\s+/)[0] ?? 'Unknown';
  }

  private static extractModel(name: string, company: string): string {
    const prefix = `${company} `;
    if (name.startsWith(prefix)) {
      return name.slice(prefix.length).trim();
    }
    return name;
  }

  private static findSpecValue(
    specs: Record<string, string>,
    candidates: string[],
  ): string {
    const entries = Object.entries(specs);
    for (const candidate of candidates) {
      const matched = entries.find(([key]) =>
        key.toLowerCase().includes(candidate.toLowerCase()),
      );
      if (matched) {
        return matched[1] ?? 'N/A';
      }
    }
    return 'N/A';
  }

  private static normalizeDisplayType(input: string): string {
    if (!input || input === 'N/A') {
      return 'N/A';
    }
    const cleaned = input.replace(/\b\d{2,3}\s*hz\b/gi, '').trim();
    return cleaned || input;
  }

  private static extractFirstDecimal(input: string): number | null {
    const match = input.match(/(\d+(?:\.\d+)?)/);
    if (!match) {
      return null;
    }
    const value = Number.parseFloat(match[1]);
    return Number.isFinite(value) ? value : null;
  }

  private static extractFirstNumberWithUnit(
    input: string,
    unit: string,
  ): number | null {
    const regex = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit}`, 'i');
    const match = input.match(regex);
    if (!match) {
      return this.extractFirstDecimal(input);
    }
    const value = Number.parseFloat(match[1]);
    return Number.isFinite(value) ? value : null;
  }

  private static extractRefreshRateHz(input: string): number | null {
    const matches = Array.from(input.matchAll(/(\d{2,3})\s*hz/gi));
    if (matches.length === 0) {
      return null;
    }

    const values = matches
      .map((m) => Number.parseInt(m[1], 10))
      .filter((n) => Number.isFinite(n));
    if (values.length === 0) {
      return null;
    }

    return Math.max(...values);
  }

  private static extractMaxStorageGb(input: string): number | null {
    const values: number[] = [];

    for (const match of input.matchAll(/(\d+(?:\.\d+)?)\s*tb/gi)) {
      values.push(Number.parseFloat(match[1]) * 1024);
    }
    for (const match of input.matchAll(/(\d+(?:\.\d+)?)\s*gb/gi)) {
      values.push(Number.parseFloat(match[1]));
    }

    if (values.length === 0) {
      return null;
    }

    return Math.max(...values.filter((n) => Number.isFinite(n)));
  }

  private static extractBoolFromText(
    input: string,
    feature: string,
  ): boolean | null {
    const regex = new RegExp(`${feature}[^|:]*[:\\s]+(yes|no)`, 'i');
    const match = input.match(regex);
    if (!match) {
      return null;
    }
    return match[1].toLowerCase() === 'yes';
  }

  private static extractMaxMp(input: string): number | null {
    const values = Array.from(input.matchAll(/(\d+(?:\.\d+)?)\s*mp/gi))
      .map((m) => Number.parseFloat(m[1]))
      .filter((n) => Number.isFinite(n));

    if (values.length === 0) {
      return null;
    }

    return Math.max(...values);
  }
}
