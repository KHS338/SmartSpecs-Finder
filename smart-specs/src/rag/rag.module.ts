import { Module } from '@nestjs/common';
import { RagService } from './rag.service';
import { RagController } from './rag.controller';
import { ScraperModule } from '../scraper/scraper.module';
import { SqlAnalyticsService } from './sql-analytics.service';

@Module({
  imports: [ScraperModule],
  controllers: [RagController],
  providers: [RagService, SqlAnalyticsService],
})
export class RagModule {}
