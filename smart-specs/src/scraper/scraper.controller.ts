import { Controller, Post } from '@nestjs/common';
import { ScraperService } from './scraper.service';

@Controller('scraper')
export class ScraperController {
  constructor(private readonly scraperService: ScraperService) {}

  @Post('run')
  async runScraper() {
    const { phones, excelFilePath } =
      await this.scraperService.scrapeAndExportPhones();

    return {
      count: phones.length,
      excelFilePath,
      phones,
    };
  }
}
