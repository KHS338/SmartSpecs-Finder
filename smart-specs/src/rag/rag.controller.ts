import { Controller, Post, Body } from '@nestjs/common';
import { RagService } from './rag.service';

@Controller('rag')
export class RagController {
  constructor(private readonly ragService: RagService) {}

  // Trigger this to ingest the latest Excel export into the vector database
  @Post('update-database')
  async updateDatabase() {
    return await this.ragService.ingestLatestExcelExport();
  }

  // The chat endpoint for the frontend
  @Post('ask')
  async ask(@Body('query') query: string) {
    return await this.ragService.askOracle(query);
  }
}
