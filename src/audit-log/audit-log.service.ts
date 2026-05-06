import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuditLog } from './audit-log.entity';

export type AuditLogPayload = {
  entityType: string;
  entityId?: string;
  action: string;
  performedBy?: string;
  description: string;
  timestamp?: Date;
  metadata?: Record<string, any>;
};

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);
  private isMongoConnected = true;
  private hasWarnedDisconnected = false;

  constructor(
    @InjectModel('AuditLog')
    private readonly auditLogModel: Model<AuditLog>,
  ) {}

  setMongoConnectionStatus(isConnected: boolean) {
    this.isMongoConnected = isConnected;
    if (isConnected) {
      this.hasWarnedDisconnected = false;
    }
  }

  async createAuditLog(payload: AuditLogPayload) {
    try {
      if (!this.isMongoConnected) {
        if (!this.hasWarnedDisconnected) {
          this.logger.warn('[AUDIT] MongoDB desconectado. Audit logs deshabilitados temporalmente.');
          this.hasWarnedDisconnected = true;
        }
        return;
      }
      if (payload.entityId) {
        const existingAudit = await this.auditLogModel.exists({
          entityType: payload.entityType,
          entityId: payload.entityId,
          action: payload.action,
        });
        if (existingAudit) {
          this.logger.debug(
            `[AUDIT] Duplicate ignored action=${payload.action} entityId=${payload.entityId}`,
          );
          return;
        }
      }
      const audit = new this.auditLogModel({
        entityType: payload.entityType,
        entityId: payload.entityId,
        action: payload.action,
        performedBy: payload.performedBy || 'SYSTEM',
        description: payload.description,
        timestamp: payload.timestamp || new Date(),
        metadata: payload.metadata || {},
      });

      await audit.save();
      this.logger.log(
        `[AUDIT] Logged action=${payload.action} entityId=${payload.entityId || 'n/a'}`,
      );
    } catch (error) {
      if (error?.code === 11000) {
        this.logger.debug('[AUDIT] Duplicate ignored on insert');
        return;
      }
      this.logger.warn('[AUDIT] Error logging audit entry', error?.stack || error);
    }
  }
}
