import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { sanitizeRecord } from './audit-log.sanitizer';
import { WebhookEffect, WebhookEffectDocument, WebhookEffectStatus, WebhookInbox, WebhookInboxDocument, WebhookInboxStatus } from './webhook-inbox.entity';

export type EnqueueWebhookInput = {
  eventKey: string;
  paymentId: string;
  eventType: string;
  requestId?: string;
  payload: Record<string, unknown>;
};

type InboxMetrics = {
  enqueued: number;
  duplicates: number;
  claimed: number;
  processed: number;
  failedAttempts: number;
  permanentlyFailed: number;
  sideEffectsSkipped: number;
};

@Injectable()
export class WebhookInboxService {
  private readonly logger = new Logger(WebhookInboxService.name);
  private readonly metrics: InboxMetrics = {
    enqueued: 0,
    duplicates: 0,
    claimed: 0,
    processed: 0,
    failedAttempts: 0,
    permanentlyFailed: 0,
    sideEffectsSkipped: 0,
  };

  constructor(
    @InjectModel(WebhookInbox.name)
    private readonly inboxModel: Model<WebhookInbox>,
    @InjectModel(WebhookEffect.name)
    private readonly effectModel: Model<WebhookEffect>,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  getMetrics(): Readonly<InboxMetrics> {
    return { ...this.metrics };
  }

  async enqueue(input: EnqueueWebhookInput): Promise<{ created: boolean; eventKey: string }> {
    const retentionDays = this.configService?.get<number>('WEBHOOK_INBOX_RETENTION_DAYS') ?? 30;
    const maxAttempts = this.configService?.get<number>('WEBHOOK_MAX_ATTEMPTS') ?? 6;

    try {
      await this.inboxModel.create({
        ...input,
        provider: 'MERCADOPAGO',
        payload: sanitizeRecord(input.payload),
        status: WebhookInboxStatus.PENDING,
        attempts: 0,
        maxAttempts,
        nextAttemptAt: new Date(),
        expiresAt: new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1_000),
      });
      this.metrics.enqueued += 1;
      return { created: true, eventKey: input.eventKey };
    } catch (error) {
      if (this.isDuplicateKey(error)) {
        this.metrics.duplicates += 1;
        this.logger.debug(`[INBOX] Webhook duplicado eventKey=${input.eventKey}`);
        return { created: false, eventKey: input.eventKey };
      }
      throw error;
    }
  }

  async claimNext(): Promise<WebhookInboxDocument | null> {
    const now = new Date();
    const lockTimeoutMs = this.configService?.get<number>('WEBHOOK_LOCK_TIMEOUT_MS') ?? 120_000;
    const staleLock = new Date(now.getTime() - lockTimeoutMs);

    const claimed = await this.inboxModel
      .findOneAndUpdate(
        {
          $expr: { $lt: ['$attempts', '$maxAttempts'] },
          $or: [
            {
              status: { $in: [WebhookInboxStatus.PENDING, WebhookInboxStatus.FAILED] },
              nextAttemptAt: { $lte: now },
            },
            {
              status: WebhookInboxStatus.PROCESSING,
              lockedAt: { $lte: staleLock },
            },
          ],
        },
        {
          $set: {
            status: WebhookInboxStatus.PROCESSING,
            lockedAt: now,
            lastError: null,
          },
          $inc: { attempts: 1 },
        },
        { new: true, sort: { nextAttemptAt: 1, createdAt: 1 } },
      )
      .exec();

    if (claimed) this.metrics.claimed += 1;
    return claimed as WebhookInboxDocument | null;
  }

  async markProcessed(eventKey: string): Promise<void> {
    await this.inboxModel
      .updateOne(
        { eventKey, status: WebhookInboxStatus.PROCESSING },
        {
          $set: {
            status: WebhookInboxStatus.PROCESSED,
            processedAt: new Date(),
            nextAttemptAt: null,
            lockedAt: null,
            lastError: null,
          },
        },
      )
      .exec();
    this.metrics.processed += 1;
  }

  async markFailed(event: WebhookInboxDocument, error: unknown): Promise<void> {
    const message = this.errorMessage(error);
    const permanentlyFailed = event.attempts >= event.maxAttempts;
    const baseDelayMs = this.configService?.get<number>('WEBHOOK_RETRY_BASE_MS') ?? 5_000;
    const maxDelayMs = this.configService?.get<number>('WEBHOOK_RETRY_MAX_MS') ?? 15 * 60_000;
    const delayMs = Math.min(baseDelayMs * 2 ** Math.max(event.attempts - 1, 0), maxDelayMs);

    await this.inboxModel
      .updateOne(
        { eventKey: event.eventKey, status: WebhookInboxStatus.PROCESSING },
        {
          $set: {
            status: WebhookInboxStatus.FAILED,
            lastError: message.slice(0, 2_000),
            lockedAt: null,
            nextAttemptAt: permanentlyFailed ? null : new Date(Date.now() + delayMs),
          },
        },
      )
      .exec();

    this.metrics.failedAttempts += 1;
    if (permanentlyFailed) this.metrics.permanentlyFailed += 1;
  }

  async executeEffectOnce(effectKey: string, eventKey: string, effectType: string, handler: () => Promise<void>): Promise<boolean> {
    const claimed = await this.claimEffect(effectKey, eventKey, effectType);
    if (!claimed) {
      this.metrics.sideEffectsSkipped += 1;
      this.logger.debug(`[INBOX] Efecto duplicado omitido effectKey=${effectKey}`);
      return false;
    }

    try {
      await handler();
      await this.effectModel
        .updateOne(
          { effectKey, status: WebhookEffectStatus.PROCESSING },
          {
            $set: {
              status: WebhookEffectStatus.SUCCEEDED,
              completedAt: new Date(),
              lockedAt: null,
              lastError: null,
            },
          },
        )
        .exec();
      return true;
    } catch (error) {
      await this.effectModel
        .updateOne(
          { effectKey, status: WebhookEffectStatus.PROCESSING },
          {
            $set: {
              status: WebhookEffectStatus.FAILED,
              lockedAt: null,
              lastError: this.errorMessage(error).slice(0, 2_000),
            },
          },
        )
        .exec();
      throw error;
    }
  }

  private async claimEffect(effectKey: string, eventKey: string, effectType: string): Promise<WebhookEffectDocument | null> {
    const retentionDays = this.configService?.get<number>('WEBHOOK_EFFECT_RETENTION_DAYS') ?? 365;
    const now = new Date();
    const staleLock = new Date(now.getTime() - 120_000);

    try {
      return (await this.effectModel.create({
        effectKey,
        eventKey,
        effectType,
        status: WebhookEffectStatus.PROCESSING,
        attempts: 1,
        lockedAt: now,
        expiresAt: new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1_000),
      })) as WebhookEffectDocument;
    } catch (error) {
      if (!this.isDuplicateKey(error)) throw error;
    }

    return this.effectModel
      .findOneAndUpdate(
        {
          effectKey,
          $or: [{ status: WebhookEffectStatus.FAILED }, { status: WebhookEffectStatus.PROCESSING, lockedAt: { $lte: staleLock } }],
        },
        {
          $set: {
            eventKey,
            status: WebhookEffectStatus.PROCESSING,
            lockedAt: now,
            lastError: null,
          },
          $inc: { attempts: 1 },
        },
        { new: true },
      )
      .exec() as Promise<WebhookEffectDocument | null>;
  }

  private isDuplicateKey(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
