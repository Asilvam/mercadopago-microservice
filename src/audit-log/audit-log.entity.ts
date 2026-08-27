import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AuditLogDocument = HydratedDocument<AuditLog>;

@Schema({ collection: 'mp_logs', timestamps: true })
export class AuditLog {
  @Prop({ required: true, unique: true, index: true })
  eventId: string;

  @Prop({ required: true })
  entityType: string;

  @Prop({ required: false })
  entityId?: string;

  @Prop({ required: true })
  action: string;

  @Prop({ required: true, default: 'SYSTEM' })
  performedBy: string;

  @Prop({ required: true })
  description: string;

  @Prop({ default: Date.now })
  timestamp: Date;

  @Prop({ type: Object, required: false })
  metadata?: Record<string, unknown>;

  @Prop({ required: false, index: true })
  correlationId?: string;

  @Prop({ required: false, index: true })
  requestId?: string;

  @Prop({ required: false })
  source?: string;

  @Prop({ required: false })
  status?: string;

  @Prop({ required: false })
  expiresAt?: Date;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
AuditLogSchema.index({ entityType: 1, entityId: 1, timestamp: -1 });
AuditLogSchema.index({ action: 1, timestamp: -1 });
AuditLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
