import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AuditLogDocument = AuditLog & Document;

@Schema({ collection: 'mp_logs', timestamps: true })
export class AuditLog {
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
  metadata?: Record<string, any>;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
