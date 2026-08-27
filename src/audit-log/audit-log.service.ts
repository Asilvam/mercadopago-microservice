import { Injectable, Logger, OnModuleInit, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { AuditLog } from './audit-log.entity';
import { sanitizeRecord, SanitizationStats } from './audit-log.sanitizer';

export type AuditLogPayload = {
  eventId?: string;
  entityType: string;
  entityId?: string;
  action: string;
  performedBy?: string;
  description: string;
  timestamp?: Date;
  metadata?: Record<string, unknown>;
  correlationId?: string;
  requestId?: string;
  source?: string;
  status?: string;
};

type AuditMetrics = {
  persisted: number;
  failed: number;
  rejectedWhileDisconnected: number;
  redactedFields: number;
  truncatedValues: number;
};

@Injectable()
export class AuditLogService implements OnModuleInit {
  private readonly logger = new Logger(AuditLogService.name);
  private isMongoConnected = true;
  private hasWarnedDisconnected = false;
  private readonly metrics: AuditMetrics = {
    persisted: 0,
    failed: 0,
    rejectedWhileDisconnected: 0,
    redactedFields: 0,
    truncatedValues: 0,
  };

  constructor(
    @InjectModel('AuditLog')
    private readonly auditLogModel: Model<AuditLog>,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.auditLogModel.collection.dropIndex('entityType_1_entityId_1_action_1');
      this.logger.log('[AUDIT] Índice de deduplicación anterior eliminado; auditoría append-only habilitada.');
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      const codeName = typeof error === 'object' && error !== null && 'codeName' in error ? error.codeName : undefined;
      if (code !== 26 && code !== 27 && codeName !== 'NamespaceNotFound' && codeName !== 'IndexNotFound') {
        throw error;
      }
    }
  }

  setMongoConnectionStatus(isConnected: boolean) {
    this.isMongoConnected = isConnected;
    if (isConnected) {
      this.hasWarnedDisconnected = false;
    }
  }

  getMetrics(): Readonly<AuditMetrics & { connected: boolean }> {
    return { ...this.metrics, connected: this.isMongoConnected };
  }

  async createAuditLog(payload: AuditLogPayload): Promise<void> {
    if (!this.isMongoConnected) {
      this.metrics.rejectedWhileDisconnected += 1;
      if (!this.hasWarnedDisconnected) {
        this.logger.warn('[AUDIT] MongoDB desconectado. El evento será reintentado por el inbox.');
        this.hasWarnedDisconnected = true;
      }
      throw new ServiceUnavailableException('Audit persistence unavailable');
    }

    const sanitizationStats: SanitizationStats = {
      redactedFields: 0,
      truncatedValues: 0,
    };
    const retentionDays = this.configService?.get<number>('AUDIT_LOG_RETENTION_DAYS') ?? 365;
    const expiresAt = retentionDays > 0 ? new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1_000) : undefined;

    try {
      const audit = new this.auditLogModel({
        eventId: payload.eventId ?? randomUUID(),
        entityType: payload.entityType,
        entityId: payload.entityId,
        action: payload.action,
        performedBy: payload.performedBy || 'SYSTEM',
        description: payload.description,
        timestamp: payload.timestamp || new Date(),
        metadata: sanitizeRecord(payload.metadata, sanitizationStats),
        correlationId: payload.correlationId,
        requestId: payload.requestId,
        source: payload.source,
        status: payload.status,
        expiresAt,
      });

      await audit.save();
      this.metrics.persisted += 1;
      this.metrics.redactedFields += sanitizationStats.redactedFields;
      this.metrics.truncatedValues += sanitizationStats.truncatedValues;
      this.logger.log(`[AUDIT] Logged eventId=${audit.eventId} action=${payload.action} entityId=${payload.entityId || 'n/a'}`);
    } catch (error) {
      this.metrics.failed += 1;
      this.logger.error('[AUDIT] Error persistiendo evento', error?.stack || error);
      throw error;
    }
  }
}
