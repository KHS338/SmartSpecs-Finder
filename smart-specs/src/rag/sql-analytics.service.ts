import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ChatGroq } from '@langchain/groq';
import { SqlDatabase } from '@langchain/classic/sql_db';
import { createSqlQueryChain } from '@langchain/classic/chains/sql_db';
import { QuerySqlTool } from '@langchain/classic/tools/sql';
import { PromptTemplate } from '@langchain/core/prompts';
import { FeaturePreprocessor } from './feature-preprocessor';
import { RagService } from './rag.service';

export interface SqlAskResult {
  question: string;
  sql: string;
  rawResult: string;
  answer: string;
}

export interface PhoneDetailsQuery {
  id?: string;
  url?: string;
  name?: string;
}

export interface PhoneDetailsResult {
  id: string;
  name: string;
  company: string;
  model: string;
  pricePkr: number | null;
  url: string;
  colors: string;
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
  rawSpecs: Record<string, unknown> | null;
}

type DirectSqlKind =
  | 'cheapest_brand'
  | 'best_display'
  | 'highest_battery'
  | 'lowest_battery'
  | 'top_battery'
  | 'battery_for_phone';

@Injectable()
export class SqlAnalyticsService {
  private readonly logger = new Logger(SqlAnalyticsService.name);
  private readonly sqlitePath = 'analytics.sqlite';
  private dataSource: DataSource | null = null;
  private sqlDb: SqlDatabase | null = null;

  private readonly llm = new ChatGroq({
    apiKey: process.env.GROQ_API_KEY,
    model: 'llama-3.3-70b-versatile',
    temperature: 0,
  });

  constructor(private readonly ragService: RagService) {}

  async syncFromLatestExcel() {
    const phones = await this.ragService.loadLatestPhonesFromExcel();
    const normalized = FeaturePreprocessor.normalizePhones(phones);

    const ds = await this.getDataSource();
    await ds.query(`
      CREATE TABLE IF NOT EXISTS phones_analytics (
        id TEXT PRIMARY KEY,
        name TEXT,
        company TEXT,
        model TEXT,
        price_pkr INTEGER,
        url TEXT,
        colors TEXT,
        colors_count INTEGER,
        storage_options TEXT,
        max_storage_gb REAL,
        battery_mah REAL,
        screen_size_inches REAL,
        display_type TEXT,
        refresh_rate_hz REAL,
        ram_gb REAL,
        processor TEXT,
        operating_system TEXT,
        release_date TEXT,
        sim_support TEXT,
        has_5g INTEGER,
        has_nfc INTEGER,
        has_wifi INTEGER,
        has_bluetooth INTEGER,
        back_camera_mp REAL,
        front_camera_mp REAL,
        raw_specs_json TEXT
      )
    `);

    await ds.query('DELETE FROM phones_analytics');

    for (const row of normalized) {
      await ds.query(
        `
        INSERT INTO phones_analytics (
          id, name, company, model, price_pkr, url, colors, colors_count,
          storage_options, max_storage_gb, battery_mah, screen_size_inches,
          display_type, refresh_rate_hz, ram_gb, processor, operating_system,
          release_date, sim_support, has_5g, has_nfc, has_wifi, has_bluetooth,
          back_camera_mp, front_camera_mp, raw_specs_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          row.id,
          row.name,
          row.company,
          row.model,
          row.pricePkr,
          row.url,
          row.colors,
          row.colorsCount,
          row.storageOptions,
          row.maxStorageGb,
          row.batteryMah,
          row.screenSizeInches,
          row.displayType,
          row.refreshRateHz,
          row.ramGb,
          row.processor,
          row.operatingSystem,
          row.releaseDate,
          row.simSupport,
          this.boolToInt(row.has5G),
          this.boolToInt(row.hasNfc),
          this.boolToInt(row.hasWifi),
          this.boolToInt(row.hasBluetooth),
          row.backCameraMp,
          row.frontCameraMp,
          row.rawSpecsJson,
        ],
      );
    }

    this.sqlDb = await SqlDatabase.fromDataSourceParams({
      appDataSource: ds,
      includesTables: ['phones_analytics'],
    });

    this.logger.log(
      `SQLite analytics database refreshed with ${normalized.length} rows.`,
    );

    return {
      message: 'SQLite analytics database synced from latest Excel export.',
      count: normalized.length,
      sqlitePath: this.sqlitePath,
      table: 'phones_analytics',
    };
  }

  async askWithSql(question: string): Promise<SqlAskResult> {
    await this.ensureSqlDbReady();
    if (!this.sqlDb) {
      throw new Error('SQL database initialization failed.');
    }

    const direct = this.buildDeterministicSql(question);
    if (direct) {
      const queryTool = new QuerySqlTool(this.sqlDb);
      const rawResultValue: unknown = await queryTool.invoke(direct.sql);
      const rawResultInitial =
        typeof rawResultValue === 'string'
          ? rawResultValue
          : JSON.stringify(rawResultValue);
      const rawResult = await this.enrichRowsForCards(rawResultInitial);

      return {
        question,
        sql: direct.sql,
        rawResult,
        answer: this.summarizeDeterministic(question, direct.kind, rawResult),
      };
    }

    const customSqlPrompt = PromptTemplate.fromTemplate(`
      You are an expert SQLite data analyst. Given an input question, create a syntactically correct SQLite query to run.
      Unless the user specifies a specific number of examples to obtain, query for at most {top_k} results using the LIMIT clause.
      You must query ONLY the columns that are needed to answer the question.

      Here is the database schema:
      {table_info}

      Here are some examples of how to query this specific database:

      User: "Which Apple phone has the highest battery?"
      SQL: SELECT name, battery_mah FROM phones_analytics WHERE lower(company) = 'apple' AND battery_mah IS NOT NULL ORDER BY battery_mah DESC LIMIT 1;

      User: "What is the average price of phones with 120Hz displays?"
      SQL: SELECT AVG(price_pkr) FROM phones_analytics WHERE refresh_rate_hz = 120 AND price_pkr IS NOT NULL;

      User: "List all phones under 80000 with a 50MP back camera."
      SQL: SELECT name, price_pkr FROM phones_analytics WHERE price_pkr <= 80000 AND back_camera_mp >= 50;

      User: "How many Samsung phones have 5G?"
      SQL: SELECT COUNT(*) FROM phones_analytics WHERE lower(company) = 'samsung' AND has_5g = 1;

      User: "Find all Apple phones with battery smaller than 4000 mAh ordered by most expensive first."
      SQL: SELECT name, price_pkr, battery_mah, url FROM phones_analytics WHERE lower(company) = 'apple' AND battery_mah < 4000 ORDER BY price_pkr DESC;

      Now, write the SQL query for the following user input. Output ONLY the raw SQL query, no markdown formatting.

      User: {input}
      SQL:
    `);

    const chain = await createSqlQueryChain({
      llm: this.llm,
      db: this.sqlDb,
      dialect: 'sqlite',
      prompt: customSqlPrompt,
    });

    const sqlDraft: unknown = await chain.invoke({
      question,
      input: question,
      top_k: 10,
    });

    const sql = this.cleanSql(sqlDraft);
    const queryTool = new QuerySqlTool(this.sqlDb);
    const rawResultValue: unknown = await queryTool.invoke(sql);
    const rawResultInitial =
      typeof rawResultValue === 'string'
        ? rawResultValue
        : JSON.stringify(rawResultValue);
    const rawResult = await this.enrichRowsForCards(rawResultInitial);

    const final = await this.llm.invoke([
      [
        'system',
        'You are a data analyst. Given a SQL question, SQL query and SQL result, answer clearly and concisely. Use only the SQL result and do not invent phones or values. If result is empty, say no matching data found.',
      ],
      [
        'user',
        `Question: ${question}\nSQL: ${sql}\nResult: ${rawResult}\nAnswer:`,
      ],
    ]);

    const answer =
      typeof final.content === 'string'
        ? final.content
        : JSON.stringify(final.content);

    return {
      question,
      sql,
      rawResult,
      answer,
    };
  }

  async getPhoneDetails(
    query: PhoneDetailsQuery,
  ): Promise<PhoneDetailsResult | null> {
    await this.ensureSqlDbReady();
    const ds = await this.getDataSource();

    let rows: Array<Record<string, unknown>> = [];

    if (typeof query.id === 'string' && query.id.trim().length > 0) {
      rows = await ds.query(
        'SELECT * FROM phones_analytics WHERE id = ? LIMIT 1',
        [query.id.trim()],
      );
    }

    if (
      rows.length === 0 &&
      typeof query.url === 'string' &&
      query.url.trim().length > 0
    ) {
      rows = await ds.query(
        'SELECT * FROM phones_analytics WHERE url = ? LIMIT 1',
        [query.url.trim()],
      );
    }

    if (
      rows.length === 0 &&
      typeof query.name === 'string' &&
      query.name.trim().length > 0
    ) {
      rows = await ds.query(
        'SELECT * FROM phones_analytics WHERE lower(name) = lower(?) LIMIT 1',
        [query.name.trim()],
      );
    }

    if (rows.length === 0) {
      return null;
    }

    return this.toPhoneDetails(rows[0]);
  }

  private buildDeterministicSql(
    question: string,
  ): { kind: DirectSqlKind; sql: string } | null {
    const q = question.toLowerCase();
    const brand = this.extractBrand(q);
    const budget = this.extractBudget(question);
    const hasBatteryComparator =
      /(battery|mah|capacity).*(less than|smaller than|under|below|greater than|more than|over|at least|at most|between)/.test(
        q,
      ) ||
      /(less than|smaller than|under|below|greater than|more than|over|at least|at most|between).*(battery|mah|capacity)/.test(
        q,
      );
    const hasPriceOrdering =
      /(most expensive|least expensive|order by|sorted by|sort by)/.test(q);

    // Let the LLM SQL chain handle complex battery-filter and ordering queries.
    if (hasBatteryComparator || hasPriceOrdering) {
      return null;
    }

    const asksHighestBattery =
      /(highest|max)\s*(battery|mah|capacity)/.test(q) ||
      /(battery|mah|capacity)\s*(highest|max)/.test(q) ||
      /most\s*(battery|mah|capacity)/.test(q) ||
      /(battery|mah|capacity)\s*most/.test(q);
    const asksLowestBattery =
      /(lowest|min)\s*(battery|mah|capacity)/.test(q) ||
      /(battery|mah|capacity)\s*(lowest|min)/.test(q) ||
      /least\s*(battery|mah|capacity)/.test(q) ||
      /(battery|mah|capacity)\s*least/.test(q);
    const asksBatterySize = /(battery|mah|capacity)/.test(q);

    if (/cheapest/.test(q) && brand) {
      const where = this.brandWhereClause(brand);
      return {
        kind: 'cheapest_brand',
        sql: `SELECT name, price_pkr, url FROM phones_analytics WHERE ${where} ORDER BY price_pkr ASC LIMIT 1;`,
      };
    }

    if (/best.*display|display.*best/.test(q)) {
      const budgetClause = budget !== null ? `AND price_pkr <= ${budget}` : '';
      const brandClause = brand ? `AND (${this.brandWhereClause(brand)})` : '';

      return {
        kind: 'best_display',
        sql: `SELECT name, price_pkr, display_type, refresh_rate_hz, screen_size_inches, url
              FROM phones_analytics
              WHERE price_pkr > 0 ${budgetClause} ${brandClause}
              ORDER BY
                COALESCE(refresh_rate_hz, 0) DESC,
                CASE
                  WHEN lower(display_type) LIKE '%amoled%' OR lower(display_type) LIKE '%oled%' THEN 2
                  WHEN lower(display_type) LIKE '%ips%' THEN 1
                  ELSE 0
                END DESC,
                COALESCE(screen_size_inches, 0) DESC,
                price_pkr ASC
              LIMIT 5;`,
      };
    }

    if (asksHighestBattery) {
      const brandClause = brand ? `AND (${this.brandWhereClause(brand)})` : '';
      return {
        kind: 'highest_battery',
        sql: `SELECT name, battery_mah, price_pkr, url FROM phones_analytics WHERE battery_mah IS NOT NULL ${brandClause} ORDER BY battery_mah DESC, price_pkr ASC LIMIT 1;`,
      };
    }

    if (asksLowestBattery) {
      const brandClause = brand ? `AND (${this.brandWhereClause(brand)})` : '';
      return {
        kind: 'lowest_battery',
        sql: `SELECT name, battery_mah, price_pkr, url FROM phones_analytics WHERE battery_mah IS NOT NULL ${brandClause} ORDER BY battery_mah ASC, price_pkr ASC LIMIT 1;`,
      };
    }

    if (asksBatterySize && !/top\s*\d+/.test(q)) {
      const phoneNameHint = this.extractPhoneNameHintForBattery(q);
      if (phoneNameHint) {
        const escapedHint = this.escapeSqlLiteral(phoneNameHint);
        return {
          kind: 'battery_for_phone',
          sql: `SELECT name, battery_mah, price_pkr, url
                FROM phones_analytics
                WHERE battery_mah IS NOT NULL
                  AND (lower(name) LIKE '%${escapedHint}%' OR lower(model) LIKE '%${escapedHint}%')
                ORDER BY LENGTH(name) ASC, price_pkr DESC
                LIMIT 1;`,
        };
      }
    }

    if (/top\s*\d+.*battery|list.*highest.*battery/.test(q)) {
      const top = this.extractTopN(question);
      return {
        kind: 'top_battery',
        sql: `SELECT name, battery_mah, price_pkr, url FROM phones_analytics WHERE battery_mah IS NOT NULL ORDER BY battery_mah DESC, price_pkr ASC LIMIT ${top};`,
      };
    }

    return null;
  }

  private summarizeDeterministic(
    question: string,
    kind: DirectSqlKind,
    rawResult: string,
  ): string {
    const rows = this.parseRows(rawResult);
    if (rows.length === 0) {
      return 'No matching data found for this query.';
    }

    if (kind === 'cheapest_brand') {
      const row = rows[0];
      return `The cheapest matching phone is ${this.valueToText(row.name, 'Unknown')} at PKR ${this.valueToText(row.price_pkr, 'N/A')}.`;
    }

    if (kind === 'highest_battery') {
      const row = rows[0];
      return `The highest battery phone is ${this.valueToText(row.name, 'Unknown')} with ${this.valueToText(row.battery_mah, 'N/A')} mAh.`;
    }

    if (kind === 'lowest_battery') {
      const row = rows[0];
      return `The lowest battery phone is ${this.valueToText(row.name, 'Unknown')} with ${this.valueToText(row.battery_mah, 'N/A')} mAh.`;
    }

    if (kind === 'best_display') {
      const list = rows
        .map(
          (r, i) =>
            `${i + 1}. ${this.valueToText(r.name, 'Unknown')} - PKR ${this.valueToText(r.price_pkr, 'N/A')} (${this.valueToText(r.display_type, 'N/A')}, ${this.valueToText(r.refresh_rate_hz, 'N/A')}Hz)`,
        )
        .join('\n');
      return `Best display options based on refresh rate, display panel type, and screen size:\n${list}`;
    }

    if (kind === 'top_battery') {
      const list = rows
        .map(
          (r, i) =>
            `${i + 1}. ${this.valueToText(r.name, 'Unknown')} - ${this.valueToText(r.battery_mah, 'N/A')} mAh (PKR ${this.valueToText(r.price_pkr, 'N/A')})`,
        )
        .join('\n');
      return `Top battery phones:\n${list}`;
    }

    if (kind === 'battery_for_phone') {
      const row = rows[0];
      return `${this.valueToText(row.name, 'This phone')} has a battery capacity of ${this.valueToText(row.battery_mah, 'N/A')} mAh.`;
    }

    return `Result for "${question}": ${rawResult}`;
  }

  private parseRows(rawResult: string): Array<Record<string, unknown>> {
    try {
      const parsed: unknown = JSON.parse(rawResult);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is Record<string, unknown> =>
            !!item && typeof item === 'object',
        );
      }
      return [];
    } catch {
      return [];
    }
  }

  private async enrichRowsForCards(rawResult: string): Promise<string> {
    const rows = this.parseRows(rawResult);
    if (rows.length === 0) {
      return rawResult;
    }

    const ds = await this.getDataSource();
    let changed = false;
    const enrichedRows: Array<Record<string, unknown>> = [];

    for (const row of rows) {
      const name = this.valueToText(row.name, '').trim();
      const hasPrice = this.toNumberOrNull(row.price_pkr) !== null;
      const hasUrl = this.valueToText(row.url, '').trim().length > 0;
      const hasId = this.valueToText(row.id, '').trim().length > 0;

      if (!name || (hasPrice && hasUrl && hasId)) {
        enrichedRows.push(row);
        continue;
      }

      const lookupRowsUnknown: unknown = await ds.query(
        'SELECT id, name, price_pkr, url FROM phones_analytics WHERE lower(name) = lower(?) LIMIT 1',
        [name],
      );

      if (!Array.isArray(lookupRowsUnknown) || lookupRowsUnknown.length === 0) {
        enrichedRows.push(row);
        continue;
      }

      const lookupRows = lookupRowsUnknown as unknown[];
      const first: unknown = lookupRows[0];
      if (!first || typeof first !== 'object') {
        enrichedRows.push(row);
        continue;
      }

      const lookupRow = first as Record<string, unknown>;

      enrichedRows.push({
        ...lookupRow,
        ...row,
      });
      changed = true;
    }

    return changed ? JSON.stringify(enrichedRows) : rawResult;
  }

  private extractTopN(question: string): number {
    const match = question.toLowerCase().match(/top\s*(\d{1,2})/);
    if (!match) {
      return 10;
    }
    const n = Number.parseInt(match[1], 10);
    if (!Number.isFinite(n) || n <= 0) {
      return 10;
    }
    return Math.min(n, 50);
  }

  private extractBrand(questionLower: string): string | null {
    const brands = [
      'apple',
      'iphone',
      'samsung',
      'xiaomi',
      'oppo',
      'vivo',
      'infinix',
      'tecno',
      'realme',
      'google',
      'oneplus',
      'honor',
      'zte',
      'calme',
    ];
    for (const b of brands) {
      if (questionLower.includes(b)) {
        return b;
      }
    }
    return null;
  }

  private brandWhereClause(brand: string): string {
    if (brand === 'iphone') {
      return "lower(company) = 'apple' OR lower(name) LIKE '%iphone%'";
    }
    return `lower(company) = '${brand.replace(/'/g, "''")}'`;
  }

  private extractBudget(question: string): number | null {
    const lowered = question.toLowerCase();
    const hasCue =
      /\bbudget\b/.test(lowered) ||
      /\bunder\b/.test(lowered) ||
      /\bwithin\b/.test(lowered) ||
      /\bpkr\b/.test(lowered) ||
      /\brs\.?\b/.test(lowered) ||
      /\bi have\b/.test(lowered) ||
      /\bcan spend\b/.test(lowered);

    const kAmounts: number[] = [];
    const kRegex = /\b(\d{2,3})\s*k\b/g;
    let kMatch: RegExpExecArray | null;
    while ((kMatch = kRegex.exec(lowered)) !== null) {
      const parsed = Number.parseInt(kMatch[1], 10) * 1000;
      if (Number.isFinite(parsed) && parsed >= 10_000) {
        kAmounts.push(parsed);
      }
    }

    if (!hasCue && kAmounts.length === 0) {
      return null;
    }

    const numsFromDigits: number[] = [];
    const digitRegex = /\d[\d,]*/g;
    let digitMatch: RegExpExecArray | null;
    while ((digitMatch = digitRegex.exec(lowered)) !== null) {
      const parsed = Number.parseInt(digitMatch[0].replace(/,/g, ''), 10);
      if (Number.isFinite(parsed) && parsed >= 10_000) {
        numsFromDigits.push(parsed);
      }
    }

    const nums = [...numsFromDigits, ...kAmounts];

    if (nums.length === 0) {
      return null;
    }
    return Math.max(...nums);
  }

  private extractPhoneNameHintForBattery(questionLower: string): string | null {
    const cleaned = questionLower
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(
        /\b(what|which|is|the|of|for|with|and|tell|me|please|phone|mobile|smartphone|battery|mah|capacity|size|lowest|highest|max|min|most|least)\b/g,
        ' ',
      )
      .replace(/\s+/g, ' ')
      .trim();

    if (cleaned.length < 3) {
      return null;
    }
    return cleaned;
  }

  private escapeSqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
  }

  private valueToText(value: unknown, fallback: string): string {
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    return fallback;
  }

  private toPhoneDetails(row: Record<string, unknown>): PhoneDetailsResult {
    const rawSpecsText = this.valueToText(row.raw_specs_json, '');
    let rawSpecs: Record<string, unknown> | null = null;
    if (rawSpecsText.length > 0) {
      try {
        const parsed = JSON.parse(rawSpecsText) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          rawSpecs = parsed as Record<string, unknown>;
        }
      } catch {
        rawSpecs = null;
      }
    }

    return {
      id: this.valueToText(row.id, ''),
      name: this.valueToText(row.name, 'Unknown'),
      company: this.valueToText(row.company, 'Unknown'),
      model: this.valueToText(row.model, 'Unknown'),
      pricePkr: this.toNumberOrNull(row.price_pkr),
      url: this.valueToText(row.url, ''),
      colors: this.valueToText(row.colors, 'N/A'),
      storageOptions: this.valueToText(row.storage_options, 'N/A'),
      maxStorageGb: this.toNumberOrNull(row.max_storage_gb),
      batteryMah: this.toNumberOrNull(row.battery_mah),
      screenSizeInches: this.toNumberOrNull(row.screen_size_inches),
      displayType: this.valueToText(row.display_type, 'N/A'),
      refreshRateHz: this.toNumberOrNull(row.refresh_rate_hz),
      ramGb: this.toNumberOrNull(row.ram_gb),
      processor: this.valueToText(row.processor, 'N/A'),
      operatingSystem: this.valueToText(row.operating_system, 'N/A'),
      releaseDate: this.valueToText(row.release_date, 'N/A'),
      simSupport: this.valueToText(row.sim_support, 'N/A'),
      has5G: this.toBoolOrNull(row.has_5g),
      hasNfc: this.toBoolOrNull(row.has_nfc),
      hasWifi: this.toBoolOrNull(row.has_wifi),
      hasBluetooth: this.toBoolOrNull(row.has_bluetooth),
      backCameraMp: this.toNumberOrNull(row.back_camera_mp),
      frontCameraMp: this.toNumberOrNull(row.front_camera_mp),
      rawSpecs,
    };
  }

  private toNumberOrNull(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  }

  private toBoolOrNull(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      if (value === 1) {
        return true;
      }
      if (value === 0) {
        return false;
      }
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
        return true;
      }
      if (normalized === '0' || normalized === 'false' || normalized === 'no') {
        return false;
      }
    }
    return null;
  }

  private async ensureSqlDbReady(): Promise<void> {
    if (this.sqlDb) {
      return;
    }
    await this.syncFromLatestExcel();
  }

  private async getDataSource(): Promise<DataSource> {
    if (!this.dataSource) {
      this.dataSource = new DataSource({
        type: 'sqlite',
        database: this.sqlitePath,
        synchronize: false,
      });
    }

    if (!this.dataSource.isInitialized) {
      await this.dataSource.initialize();
    }

    return this.dataSource;
  }

  private boolToInt(value: boolean | null): number | null {
    if (value === null) {
      return null;
    }
    return value ? 1 : 0;
  }

  private cleanSql(candidate: unknown): string {
    const raw =
      typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
    let sql = raw.trim();
    sql = sql
      .replace(/```sql/gi, '')
      .replace(/```/g, '')
      .trim();
    sql = sql.replace(/^SQLQuery:\s*/i, '').trim();
    const selectIndex = sql.toLowerCase().indexOf('select');
    if (selectIndex > 0) {
      sql = sql.slice(selectIndex);
    }
    if (!sql.endsWith(';')) {
      sql = `${sql};`;
    }
    return sql;
  }
}
