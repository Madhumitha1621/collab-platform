import 'reflect-metadata';
import 'dotenv/config';
import { Logger, NestApplicationOptions, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { appConfig } from './config';

export async function createApp(options: NestApplicationOptions = {}) {
  const app = await NestFactory.create(AppModule, options);
  app.enableCors({ origin: appConfig().corsOrigins, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();
  return app;
}

async function bootstrap() {
  const app = await createApp();
  const port = appConfig().port;
  await app.listen(port);
  Logger.log(`API listening on http://localhost:${port}/graphql`, 'Bootstrap');
}

if (require.main === module) void bootstrap();
