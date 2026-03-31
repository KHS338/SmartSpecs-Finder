import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ScraperModule } from './scraper/scraper.module';
import { RagModule } from './rag/rag.module';

@Module({
  imports: [ScraperModule, RagModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
