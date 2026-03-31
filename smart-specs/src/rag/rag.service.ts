import { Injectable, Logger } from '@nestjs/common';
import { Chroma } from '@langchain/community/vectorstores/chroma';
import { Embeddings } from '@langchain/core/embeddings';
import { ChatGroq } from '@langchain/groq';
import { Document } from '@langchain/core/documents';
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory';
import * as ExcelJS from 'exceljs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PhoneData } from '../scraper/scraper.service';

class LocalHashEmbeddings extends Embeddings {
  constructor(private readonly dimensions = 384) {
    super({});
  }

  embedDocuments(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.embedText(text)));
  }

  embedQuery(text: string): Promise<number[]> {
    return Promise.resolve(this.embedText(text));
  }

  private embedText(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);

    for (const token of tokens) {
      const index = this.hashToken(token) % this.dimensions;
      vector[index] += 1;
    }

    const norm = Math.sqrt(
      vector.reduce((sum, value) => sum + value * value, 0),
    );
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= norm;
      }
    }

    return vector;
  }

  private hashToken(token: string): number {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash +=
        (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return Math.abs(hash >>> 0);
  }
}

interface QueryConstraints {
  brand: string | null;
  budget: number | null;
  needs120Hz: boolean;
}

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private indexedPhones: PhoneData[] = [];
  private vectorStore:
    | Chroma
    | {
        similaritySearch(
          query: string,
          k: number,
        ): Promise<Array<Document<Record<string, unknown>>>>;
      };
  private llm: ChatGroq;
  private embeddings: Embeddings;

  constructor() {
    // 1. Initialize deterministic local embeddings (no network/model downloads)
    this.embeddings = new LocalHashEmbeddings(384);

    // 2. Initialize Groq (Blazing fast inference)
    // Ensure GROQ_API_KEY is in your environment variables
    this.llm = new ChatGroq({
      apiKey: process.env.GROQ_API_KEY,
      model: 'llama-3.1-8b-instant',
      temperature: 0.1, // Low temp prevents hallucinating fake specs/prices
    });
  }

  async ingestLatestExcelExport() {
    const phones = await this.readPhonesFromLatestExcel();
    return await this.ingestPhones(phones);
  }

  async ingestPhones(phones: PhoneData[]) {
    this.logger.log(`Embedding ${phones.length} phones into ChromaDB...`);
    this.indexedPhones = phones;

    // Convert raw JSON into LangChain Documents
    const docs = phones.map((phone) => {
      const features = this.extractPhoneFeatures(phone);
      return new Document({
        pageContent: this.buildEnrichedDocumentText(phone, features),
        metadata: {
          id: phone.id,
          name: phone.name,
          price: phone.price,
          url: phone.url,
          company: features.company,
          screenSize: features.screenSize,
          refreshRateHz: features.refreshRateHz,
          battery: features.battery,
          ram: features.ram,
          processor: features.processor,
        },
      });
    });

    try {
      // Prefer Chroma if server is available.
      this.vectorStore = await Chroma.fromDocuments(docs, this.embeddings, {
        collectionName: 'smartphones',
        url: 'http://localhost:8000',
      });
      this.logger.log('Connected to ChromaDB at http://localhost:8000');
    } catch (error) {
      this.logger.warn(
        'ChromaDB unavailable; falling back to in-memory vector store.',
      );
      if (error instanceof Error) {
        this.logger.warn(error.message);
      }

      const memoryStore = new MemoryVectorStore(this.embeddings);
      await memoryStore.addDocuments(docs);
      this.vectorStore = memoryStore;
    }

    this.logger.log('Successfully ingested phones into Vector Database.');
    return { message: 'Database updated', count: docs.length };
  }

  async askOracle(query: string) {
    if (!this.vectorStore) {
      throw new Error(
        'Database is empty. Please run /rag/update-database first.',
      );
    }

    this.logger.log(`User asks: "${query}"`);

    const constraints = this.extractConstraints(query);
    let results = await this.findConstraintAwareResults(query, constraints, 8);

    const hasConstraints =
      constraints.brand !== null ||
      constraints.budget !== null ||
      constraints.needs120Hz;

    // Only use generic vector fallback if no explicit constraints were requested.
    if (results.length === 0 && !hasConstraints) {
      results = await this.vectorStore.similaritySearch(query, 8);
    }

    if (results.length === 0 && hasConstraints) {
      const closeMatches = this.findClosestMatches(query, constraints, 4);
      const recommendationLines = [
        'No exact phones in your indexed database match all requested constraints.',
      ];

      if (closeMatches.length > 0) {
        recommendationLines.push('Closest available options are:');
        for (const phone of closeMatches) {
          recommendationLines.push(
            `- ${phone.name} | PKR ${phone.price} | ${phone.url}`,
          );
        }
      }

      return {
        recommendation: recommendationLines.join('\n'),
        sources: closeMatches.map((phone) => ({
          id: phone.id,
          name: phone.name,
          price: phone.price,
          url: phone.url,
        })),
      };
    }

    const context = results.map((r) => r.pageContent).join('\n\n---\n\n');

    const prompt = `
      You are an expert smartphone buying assistant.
      Use ONLY the provided phone database below to make your recommendation.
      Do not mention phones that are not in the database.
      If the user specifies a budget, verify the "Current Price" fits before recommending it.
      If there is no exact match, explicitly say so and then suggest the closest options from the provided database.
      Always include the exact price, key specs, and why it fits their specific needs.
      
      Phone Database:
      ${context}
      
      User Request: ${query}
    `;

    const response = await this.llm.invoke(prompt);
    const recommendation =
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);

    const safeRecommendation = this.normalizeRefusalIfNeeded(
      recommendation,
      results,
    );

    return {
      recommendation: safeRecommendation,
      sources: results.map((r) => r.metadata),
    };
  }

  private findConstraintAwareResults(
    query: string,
    constraints: QueryConstraints,
    maxResults: number,
  ): Promise<Array<Document<Record<string, unknown>>>> {
    if (this.indexedPhones.length === 0) {
      return Promise.resolve([]);
    }

    let candidates = [...this.indexedPhones];

    const brand = constraints.brand;
    if (brand) {
      candidates = candidates.filter((phone) =>
        this.matchesBrand(phone, brand),
      );
    }

    const budget = constraints.budget;
    if (budget !== null) {
      candidates = candidates.filter(
        (phone) => phone.price > 0 && phone.price <= budget,
      );
    }

    if (constraints.needs120Hz) {
      candidates = candidates.filter((phone) => this.has120HzDisplay(phone));
    }

    const ranked = candidates
      .map((phone) => ({
        phone,
        score: this.keywordScore(query, phone),
      }))
      .sort((a, b) => b.score - a.score || b.phone.price - a.phone.price)
      .slice(0, maxResults)
      .map(
        ({ phone }) =>
          new Document<Record<string, unknown>>({
            pageContent: phone.formattedText,
            metadata: {
              id: phone.id,
              name: phone.name,
              price: phone.price,
              url: phone.url,
            },
          }),
      );

    return Promise.resolve(ranked);
  }

  private extractBrand(query: string): string | null {
    const lowered = query.toLowerCase();
    const knownBrands = [
      'apple',
      'iphone',
      'samsung',
      'xiaomi',
      'infinix',
      'tecno',
      'realme',
      'oppo',
      'vivo',
      'google',
      'oneplus',
    ];
    for (const brand of knownBrands) {
      if (lowered.includes(brand)) {
        return brand;
      }
    }
    return null;
  }

  private extractConstraints(query: string): QueryConstraints {
    return {
      brand: this.extractBrand(query),
      budget: this.extractBudget(query),
      needs120Hz: /120\s*hz/i.test(query),
    };
  }

  private matchesBrand(phone: PhoneData, brand: string): boolean {
    const name = phone.name.toLowerCase();
    if (brand === 'apple' || brand === 'iphone') {
      return name.includes('apple') || name.includes('iphone');
    }
    return name.includes(brand);
  }

  private findClosestMatches(
    query: string,
    constraints: QueryConstraints,
    maxResults: number,
  ): PhoneData[] {
    let candidates = [...this.indexedPhones];

    if (constraints.brand) {
      const brandFiltered = candidates.filter((phone) =>
        this.matchesBrand(phone, constraints.brand as string),
      );
      if (brandFiltered.length > 0) {
        candidates = brandFiltered;
      }
    }

    if (constraints.budget !== null) {
      const withinBudget = candidates.filter(
        (phone) => phone.price > 0 && phone.price <= constraints.budget!,
      );
      if (withinBudget.length > 0) {
        candidates = withinBudget;
      }
    }

    return candidates
      .map((phone) => ({
        phone,
        score: this.keywordScore(query, phone),
      }))
      .sort((a, b) => b.score - a.score || b.phone.price - a.phone.price)
      .slice(0, maxResults)
      .map((entry) => entry.phone);
  }

  private extractBudget(query: string): number | null {
    const numericMatches = query.match(/\d[\d,]*/g);
    if (!numericMatches || numericMatches.length === 0) {
      return null;
    }

    const parsed = numericMatches
      .map((v) => Number.parseInt(v.replace(/,/g, ''), 10))
      .filter((v) => Number.isFinite(v) && v > 0);

    if (parsed.length === 0) {
      return null;
    }

    return Math.max(...parsed);
  }

  private has120HzDisplay(phone: PhoneData): boolean {
    const haystack =
      `${phone.name} ${phone.formattedText} ${Object.values(phone.specs).join(' ')}`.toLowerCase();
    return /120\s*hz/.test(haystack);
  }

  private keywordScore(query: string, phone: PhoneData): number {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2);

    if (tokens.length === 0) {
      return 0;
    }

    const text = `${phone.name} ${phone.formattedText}`.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (text.includes(token)) {
        score += 1;
      }
    }

    return score;
  }

  private normalizeRefusalIfNeeded(
    recommendation: string,
    results: Array<Document<Record<string, unknown>>>,
  ): string {
    const lowered = recommendation.toLowerCase();
    const looksLikeRefusal =
      lowered.includes("can't help") ||
      lowered.includes('cannot help') ||
      lowered.includes("can't assist") ||
      lowered.includes('cannot assist');

    if (!looksLikeRefusal || results.length === 0) {
      return recommendation;
    }

    const lines = results.slice(0, 4).map((doc) => {
      const name = this.metadataToString(doc.metadata.name, 'Unknown phone');
      const price = this.metadataToString(doc.metadata.price, 'N/A');
      const url = this.metadataToString(doc.metadata.url, 'N/A');
      return `- ${name} | PKR ${price} | ${url}`;
    });

    return [
      'I could not produce a model-generated explanation for this request, but here are the closest matches from your indexed database:',
      ...lines,
    ].join('\n');
  }

  private metadataToString(value: unknown, fallback: string): string {
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    return fallback;
  }

  private async readPhonesFromLatestExcel(): Promise<PhoneData[]> {
    const exportsDir = join(process.cwd(), 'exports');
    const allFiles = await readdir(exportsDir);
    const excelFiles = allFiles.filter(
      (file) => file.endsWith('.xlsx') && !file.startsWith('~$'),
    );

    if (excelFiles.length === 0) {
      throw new Error(
        'No Excel export found. Run /scraper/run once to generate exports/*.xlsx.',
      );
    }

    const fileStats = await Promise.all(
      excelFiles.map(async (file) => {
        const filePath = join(exportsDir, file);
        const info = await stat(filePath);
        return { filePath, mtimeMs: info.mtimeMs };
      }),
    );

    fileStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const latestExcelPath = fileStats[0].filePath;

    this.logger.log(`Loading phones from Excel: ${latestExcelPath}`);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(latestExcelPath);

    const phonesSheet =
      workbook.getWorksheet('Phones') ?? workbook.worksheets[0];
    if (!phonesSheet) {
      throw new Error('Excel file has no worksheets to ingest.');
    }

    const headerRow = phonesSheet.getRow(1);
    const headerIndex = new Map<string, number>();
    headerRow.eachCell((cell, colNumber) => {
      const header = this.cellText(cell.value);
      if (header) {
        headerIndex.set(header, colNumber);
      }
    });

    const requiredHeaders = ['ID', 'Name', 'Price (PKR)', 'URL'];
    const missingHeaders = requiredHeaders.filter((h) => !headerIndex.has(h));
    if (missingHeaders.length > 0) {
      throw new Error(
        `Excel Phones sheet is missing required columns: ${missingHeaders.join(', ')}`,
      );
    }

    const phones: PhoneData[] = [];

    for (let i = 2; i <= phonesSheet.rowCount; i++) {
      const row = phonesSheet.getRow(i);
      const id = this.readCell(row, headerIndex, 'ID');
      const name = this.readCell(row, headerIndex, 'Name');
      const priceRaw = this.readCell(row, headerIndex, 'Price (PKR)');
      const url = this.readCell(row, headerIndex, 'URL');

      if (!id || !name || !url) {
        continue;
      }

      const colors = this.readCell(row, headerIndex, 'Colors')
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0);

      const storageOptions = this.readCell(row, headerIndex, 'Storage Options')
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0);

      const specs = this.parseSpecsJson(
        this.readCell(row, headerIndex, 'Specs (JSON)'),
      );

      const parsedPrice = Number.parseFloat(priceRaw.replace(/[^\d.]/g, ''));
      const price = Number.isFinite(parsedPrice) ? parsedPrice : 0;

      let formattedText = this.readCell(row, headerIndex, 'Formatted Text');
      if (!formattedText) {
        formattedText = this.buildFormattedText({
          id,
          name,
          price,
          url,
          colors,
          storageOptions,
          specs,
        });
      }

      const normalizedColors = this.normalizeCsvList(colors.join(','));
      const normalizedStorage = this.normalizeStorageOptions(storageOptions);

      // Always rebuild a canonical text block so retrieval is stable even if source text format varies.
      const canonicalFormattedText = this.buildFormattedText({
        id,
        name,
        price,
        url,
        colors: normalizedColors,
        storageOptions: normalizedStorage,
        specs,
      });

      phones.push({
        id,
        name,
        price,
        url,
        colors: normalizedColors,
        storageOptions: normalizedStorage,
        specs,
        formattedText: canonicalFormattedText,
      });
    }

    if (phones.length === 0) {
      throw new Error(
        'Excel file was loaded, but no valid phone rows were found.',
      );
    }

    return phones;
  }

  private readCell(
    row: ExcelJS.Row,
    headerIndex: Map<string, number>,
    header: string,
  ): string {
    const col = headerIndex.get(header);
    if (!col) {
      return '';
    }
    return this.cellText(row.getCell(col).value);
  }

  private cellText(value: ExcelJS.CellValue): string {
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value === 'string') {
      return value.trim();
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === 'object' && 'text' in value) {
      const maybeText = value.text;
      return typeof maybeText === 'string' ? maybeText.trim() : '';
    }
    return '';
  }

  private parseSpecsJson(raw: string): Record<string, string> {
    if (!raw) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return {};
      }

      const output: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') {
          output[key] = value;
        } else if (value !== null && value !== undefined) {
          output[key] = String(value);
        }
      }
      return output;
    } catch {
      return {};
    }
  }

  private normalizeCsvList(raw: string): string[] {
    const unique = new Set<string>();
    for (const part of raw.split(',')) {
      const normalized = part.trim();
      if (normalized.length > 0) {
        unique.add(normalized);
      }
    }
    return Array.from(unique);
  }

  private normalizeStorageOptions(storageOptions: string[]): string[] {
    const normalized = this.normalizeCsvList(storageOptions.join(','));

    const ranked = normalized
      .map((entry) => ({
        entry,
        rank: this.storageRank(entry),
      }))
      .sort((a, b) => a.rank - b.rank)
      .map((item) => item.entry);

    return ranked;
  }

  private storageRank(value: string): number {
    const trimmed = value.toUpperCase().replace(/\s+/g, '');
    const tbMatch = trimmed.match(/(\d+(?:\.\d+)?)TB/);
    if (tbMatch) {
      return Number.parseFloat(tbMatch[1]) * 1024;
    }

    const gbMatch = trimmed.match(/(\d+(?:\.\d+)?)GB/);
    if (gbMatch) {
      return Number.parseFloat(gbMatch[1]);
    }

    return Number.MAX_SAFE_INTEGER;
  }

  private extractPhoneFeatures(phone: PhoneData): {
    company: string;
    screenSize: string;
    refreshRateHz: number | null;
    battery: string;
    ram: string;
    processor: string;
  } {
    const company = this.extractCompanyFromName(phone.name);
    const screenSize = this.pickSpecValue(phone.specs, [
      'display - screen size',
    ]);
    const battery = this.pickSpecValue(phone.specs, ['battery - type']);
    const ram = this.pickSpecValue(phone.specs, ['memory - ram']);
    const processor = this.pickSpecValue(phone.specs, [
      'performance - processor',
    ]);
    const refreshRateHz = this.extractRefreshRateHz(phone);

    return {
      company,
      screenSize,
      refreshRateHz,
      battery,
      ram,
      processor,
    };
  }

  private extractCompanyFromName(name: string): string {
    const firstWord = name.trim().split(/\s+/)[0] ?? 'Unknown';
    return firstWord;
  }

  private pickSpecValue(
    specs: Record<string, string>,
    contains: string[],
  ): string {
    const normalizedKeys = Object.keys(specs);
    for (const wanted of contains) {
      const match = normalizedKeys.find((key) =>
        key.toLowerCase().includes(wanted.toLowerCase()),
      );
      if (match) {
        return specs[match] ?? 'N/A';
      }
    }
    return 'N/A';
  }

  private extractRefreshRateHz(phone: PhoneData): number | null {
    const displayText = [
      this.pickSpecValue(phone.specs, ['display - screen type']),
      this.pickSpecValue(phone.specs, ['display - screen resolution']),
      phone.formattedText,
    ].join(' ');

    const matches = Array.from(displayText.matchAll(/(\d{2,3})\s*hz/gi));
    if (matches.length === 0) {
      return null;
    }

    const parsed = matches
      .map((m) => Number.parseInt(m[1], 10))
      .filter((v) => Number.isFinite(v));

    if (parsed.length === 0) {
      return null;
    }

    return Math.max(...parsed);
  }

  private buildEnrichedDocumentText(
    phone: PhoneData,
    features: {
      company: string;
      screenSize: string;
      refreshRateHz: number | null;
      battery: string;
      ram: string;
      processor: string;
    },
  ): string {
    const specsText = Object.entries(phone.specs)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');

    return [
      `Phone: ${phone.name}`,
      `Company: ${features.company}`,
      `Price: PKR ${phone.price}`,
      `Colors: ${phone.colors.join(', ')}`,
      `Storage Options: ${phone.storageOptions.join(', ')}`,
      `Screen Size: ${features.screenSize}`,
      `Refresh Rate: ${features.refreshRateHz ?? 'N/A'} Hz`,
      `Battery: ${features.battery}`,
      `RAM: ${features.ram}`,
      `Processor: ${features.processor}`,
      `URL: ${phone.url}`,
      '',
      'Specifications:',
      specsText,
    ].join('\n');
  }

  private buildFormattedText(phone: Omit<PhoneData, 'formattedText'>): string {
    const specsText = Object.entries(phone.specs)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');

    return [
      `Phone: ${phone.name}`,
      `Price: PKR ${phone.price}`,
      `Colors: ${phone.colors.join(', ')}`,
      `Storage: ${phone.storageOptions.join(', ')}`,
      `URL: ${phone.url}`,
      '',
      'Specifications:',
      specsText,
    ].join('\n');
  }
}
