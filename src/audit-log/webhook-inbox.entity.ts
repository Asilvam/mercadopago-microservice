import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export enum WebhookInboxStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  PROCESSED = 'PROCESSED',
  FAILED = 'FAILED',
}

export type WebhookInboxDocument = HydratedDocument<WebhookInbox>;

@Schema({ collection: 'mp_webhook_inbox', timestamps: true })
export class WebhookInbox {
  @Prop({ required: true, unique: true, index: true })
  eventKey: string;

  @Prop({ required: true, default: 'MERCADOPAGO' })
  provider: string;

  @Prop({ required: true, index: true })
  paymentId: string;

  @Prop({ required: true })
  eventType: string;

  @Prop({ required: false, index: true })
  requestId?: string;

  @Prop({ type: Object, required: true })
  payload: Record<string, unknown>;

  @Prop({
    required: true,
    enum: Object.values(WebhookInboxStatus),
    default: WebhookInboxStatus.PENDING,
    index: true,
  })
  status: WebhookInboxStatus;

  @Prop({ required: true, default: 0 })
  attempts: number;

  @Prop({ required: true, default: 6 })
  maxAttempts: number;

  @Prop({ required: false, index: true })
  nextAttemptAt?: Date;

  @Prop({ required: false })
  lockedAt?: Date;

  @Prop({ required: false })
  processedAt?: Date;

  @Prop({ required: false })
  lastError?: string;

  @Prop({ required: true })
  expiresAt: Date;
}

export const WebhookInboxSchema = SchemaFactory.createForClass(WebhookInbox);
WebhookInboxSchema.index({ status: 1, nextAttemptAt: 1, lockedAt: 1 });
WebhookInboxSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export enum WebhookEffectStatus {
  PROCESSING = 'PROCESSING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

export type WebhookEffectDocument = HydratedDocument<WebhookEffect>;

@Schema({ collection: 'mp_webhook_effects', timestamps: true })
export class WebhookEffect {
  @Prop({ required: true, unique: true, index: true })
  effectKey: string;

  @Prop({ required: true, index: true })
  eventKey: string;

  @Prop({ required: true })
  effectType: string;

  @Prop({ required: true, enum: Object.values(WebhookEffectStatus) })
  status: WebhookEffectStatus;

  @Prop({ required: true, default: 1 })
  attempts: number;

  @Prop({ required: false })
  lockedAt?: Date;

  @Prop({ required: false })
  completedAt?: Date;

  @Prop({ required: false })
  lastError?: string;

  @Prop({ required: true })
  expiresAt: Date;
}

export const WebhookEffectSchema = SchemaFactory.createForClass(WebhookEffect);
WebhookEffectSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
