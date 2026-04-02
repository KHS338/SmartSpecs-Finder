import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { RagService } from './rag.service';
import { ScraperService } from '../scraper/scraper.service';
import { SqlAnalyticsService } from './sql-analytics.service';

@Controller('rag')
export class RagController {
  constructor(
    private readonly ragService: RagService,
    private readonly scraperService: ScraperService,
    private readonly sqlAnalyticsService: SqlAnalyticsService,
  ) {}

  // Trigger this to ingest the latest Excel export into the vector database
  @Post('update-database')
  async updateDatabase() {
    return await this.ragService.ingestLatestExcelExport();
  }

  // Build an analytics-ready Excel file with normalized feature columns
  @Post('preprocess-analytics')
  async preprocessAnalytics() {
    return await this.ragService.preprocessLatestExcelForAnalytics();
  }

  // Run live scraping and refresh all downstream artifacts in one shot
  @Post('refresh-live')
  async refreshLive() {
    const scrape = await this.scraperService.scrapeAndExportPhones();
    const analytics = await this.ragService.preprocessPhonesForAnalytics(
      scrape.phones,
    );
    const sqlSync = await this.sqlAnalyticsService.syncFromLatestExcel();
    const index = await this.ragService.ingestPhones(scrape.phones);

    return {
      message: 'Live refresh completed.',
      count: scrape.phones.length,
      scrapeFilePath: scrape.excelFilePath,
      analyticsFilePath: analytics.analyticsFilePath,
      sqlSyncStatus: sqlSync.message,
      indexStatus: index.message,
    };
  }

  // Sync latest Excel export into local SQLite analytics table
  @Post('sql/sync')
  async sqlSync() {
    return await this.sqlAnalyticsService.syncFromLatestExcel();
  }

  // Ask analytics questions through Text-to-SQL on SQLite
  @Post('sql/ask')
  async sqlAsk(@Body() body: Record<string, unknown>) {
    const query = this.extractQuery(body);
    return await this.sqlAnalyticsService.askWithSql(query);
  }

  // Fetch full analytics details for a selected phone card
  @Post('sql/phone-details')
  async sqlPhoneDetails(@Body() body: Record<string, unknown>) {
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    const url = typeof body?.url === 'string' ? body.url.trim() : '';
    const name = typeof body?.name === 'string' ? body.name.trim() : '';

    if (!id && !url && !name) {
      throw new BadRequestException(
        'Provide at least one of id, url, or name.',
      );
    }

    const details = await this.sqlAnalyticsService.getPhoneDetails({
      id: id || undefined,
      url: url || undefined,
      name: name || undefined,
    });

    return {
      found: details !== null,
      details,
    };
  }

  // The chat endpoint for the frontend
  @Post('ask')
  async ask(@Body() body: Record<string, unknown>) {
    const query = this.extractQuery(body);

    if (this.isSqlAnalyticsQuery(query)) {
      const sql = await this.sqlAnalyticsService.askWithSql(query);
      return {
        recommendation: sql.answer,
        sources: [],
        sql: sql.sql,
        rawResult: sql.rawResult,
      };
    }

    return await this.ragService.askOracle(query);
  }

  private isSqlAnalyticsQuery(query: string): boolean {
    const q = query.toLowerCase();
    return (
      /\b(avg|average|mean|median|min|max|highest|lowest|top|cheapest|expensive|best)\b/.test(
        q,
      ) ||
      /\bhow many\b/.test(q) ||
      /\bcount\b/.test(q) ||
      /\b(sum|total)\b/.test(q) ||
      /\b(battery|mah|screen|display|screen size|display type|ram|price|storage|camera|processor)\b/.test(
        q,
      )
    );
  }

  private extractQuery(body: Record<string, unknown> | undefined): string {
    const query = body?.query;
    const question = body?.question;
    const prompt = body?.prompt;
    const raw = query ?? question ?? prompt;

    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new BadRequestException(
        'Request body must include a non-empty string in query, question, or prompt.',
      );
    }

    return raw.trim();
  }
}
