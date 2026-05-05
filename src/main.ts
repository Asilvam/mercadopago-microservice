import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { Connection } from 'mongoose';
import { getConnectionToken } from '@nestjs/mongoose';
import { AuditLogService } from './audit-log/audit-log.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Mongo');
  const auditLogService = app.get(AuditLogService);
  const configService = app.get(ConfigService);
  const connection = app.get<Connection>(getConnectionToken());
  const mongoUri = configService.get<string>('MONGODB_URI');

  const updateStatus = (isConnected: boolean) => {
    auditLogService.setMongoConnectionStatus(isConnected);
    if (isConnected) {
      logger.log('Conexion restaurada. Audit logs habilitados.');
    }
  };

  connection.on('connected', () => updateStatus(true));
  connection.on('disconnected', () => {
    auditLogService.setMongoConnectionStatus(false);
    logger.warn('Conexion perdida. Reintentando en background...');
  });
  connection.on('error', (error) => {
    auditLogService.setMongoConnectionStatus(false);
    logger.error('Error de conexion', error);
  });

  updateStatus(connection.readyState === 1);

  setInterval(async () => {
    if (connection.readyState === 1) return;
    if (!mongoUri) return;
    try {
      await connection.openUri(mongoUri);
      updateStatus(true);
    } catch (error) {
      auditLogService.setMongoConnectionStatus(false);
    }
  }, 60000);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
