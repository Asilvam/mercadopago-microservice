import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { Connection } from 'mongoose';
import { getConnectionToken } from '@nestjs/mongoose';
import { AuditLogService } from './audit-log/audit-log.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');
  const auditLogService = app.get(AuditLogService);
  const configService = app.get(ConfigService);
  const connection = app.get<Connection>(getConnectionToken());

  // ── Global Pipes ──────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // ── CORS ──────────────────────────────────────────────
  const frontendUrl = configService.get<string>('FRONTEND_URL');
  app.enableCors({
    origin: frontendUrl || '*',
  });

  // ── MongoDB connection status tracking ────────────────
  const updateStatus = (isConnected: boolean) => {
    auditLogService.setMongoConnectionStatus(isConnected);
    if (isConnected) {
      logger.log('MongoDB: conexión establecida. Audit logs habilitados.');
    }
  };

  connection.on('connected', () => updateStatus(true));
  connection.on('disconnected', () => {
    auditLogService.setMongoConnectionStatus(false);
    logger.warn('MongoDB: conexión perdida. Mongoose reintentará automáticamente.');
  });
  connection.on('error', (error) => {
    auditLogService.setMongoConnectionStatus(false);
    logger.error('MongoDB: error de conexión', error);
  });

  updateStatus(connection.readyState === 1);

  // ── Start server ──────────────────────────────────────
  const port = configService.get<number>('PORT') ?? 3000;
  await app.listen(port);
  logger.log(`Microservicio MercadoPago escuchando en puerto ${port}`);
}
bootstrap();
