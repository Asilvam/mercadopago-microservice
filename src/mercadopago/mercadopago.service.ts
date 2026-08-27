import { Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvalidWebhookSignatureError, MercadoPagoConfig, Payment, Preference, WebhookSignatureValidator } from 'mercadopago';
import { CreateMpDto } from './dto/create-mp.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-log/audit-log.constants';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { WebhookInboxService } from '../audit-log/webhook-inbox.service';
import { WebhookInboxDocument } from '../audit-log/webhook-inbox.entity';

type WebhookMetadata = Record<string, unknown>;

type AcceptWebhookInput = {
  paymentId: string;
  eventType: string;
  requestId?: string;
  dataId?: string;
  xSignature?: string | string[];
  metadata: WebhookMetadata;
  payload: Record<string, unknown>;
};

@Injectable()
export class MercadopagoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MercadopagoService.name);
  private readonly client: MercadoPagoConfig;
  private workerTimer?: ReturnType<typeof setInterval>;
  private isDraining = false;
  private readonly metrics = {
    signaturesAccepted: 0,
    signaturesRejected: 0,
    persistenceUnavailable: 0,
    workerErrors: 0,
  };

  constructor(
    private configService: ConfigService,
    private auditLogService: AuditLogService,
    private webhookInboxService: WebhookInboxService,
  ) {
    const accessToken = this.configService.get<string>('MP_ACCESS_TOKEN');
    if (!accessToken) {
      throw new Error('MP_ACCESS_TOKEN no está definido en las variables de entorno');
    }
    this.client = new MercadoPagoConfig({
      accessToken: accessToken,
    });
  }

  onModuleInit(): void {
    const pollIntervalMs = this.configService.get<number>('WEBHOOK_POLL_INTERVAL_MS') ?? 5_000;
    this.workerTimer = setInterval(() => void this.drainInbox(), pollIntervalMs);
    this.workerTimer.unref?.();
    void this.drainInbox();
  }

  onModuleDestroy(): void {
    if (this.workerTimer) clearInterval(this.workerTimer);
  }

  async acceptWebhook(input: AcceptWebhookInput): Promise<{
    accepted: true;
    duplicate: boolean;
    eventKey: string;
  }> {
    this.validateWebhookSignature(input);

    const eventKey = this.buildEventKey(input);
    let result: { created: boolean; eventKey: string };
    try {
      result = await this.webhookInboxService.enqueue({
        eventKey,
        paymentId: input.paymentId,
        eventType: input.eventType,
        requestId: input.requestId,
        payload: {
          ...input.payload,
          metadata: input.metadata,
        },
      });
    } catch (error) {
      this.metrics.persistenceUnavailable += 1;
      this.logger.error(`[Webhook] No fue posible persistir eventKey=${eventKey}`, this.errorMessage(error));
      throw new ServiceUnavailableException('Webhook persistence unavailable');
    }

    queueMicrotask(() => void this.drainInbox());
    return { accepted: true, duplicate: !result.created, eventKey };
  }

  private validateWebhookSignature(input: AcceptWebhookInput): void {
    const secret = this.configService.get<string>('MP_WEBHOOK_SECRET');
    if (!secret) {
      this.metrics.signaturesRejected += 1;
      throw new ServiceUnavailableException('MP_WEBHOOK_SECRET is not configured');
    }

    try {
      WebhookSignatureValidator.validate({
        xSignature: input.xSignature,
        xRequestId: input.requestId,
        dataId: input.dataId,
        secret,
        toleranceSeconds: this.configService.get<number>('MP_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS') ?? 300,
      });
      this.metrics.signaturesAccepted += 1;
    } catch (error) {
      this.metrics.signaturesRejected += 1;
      const reason = error instanceof InvalidWebhookSignatureError ? error.reason : 'unknown';
      this.logger.warn(`[Webhook] Firma inválida requestId=${input.requestId || 'n/a'} reason=${reason}`);
      throw new UnauthorizedException('Invalid Mercado Pago webhook signature');
    }
  }

  private buildEventKey(input: AcceptWebhookInput): string {
    const payload = input.payload as { body?: Record<string, unknown> };
    const bodyNotificationId = payload.body?.id;
    const discriminator = input.requestId || String(bodyNotificationId || 'no-request-id');
    return createHash('sha256').update(`mercadopago:${input.eventType}:${input.paymentId}:${discriminator}`).digest('hex');
  }

  private async drainInbox(): Promise<void> {
    if (this.isDraining) return;
    this.isDraining = true;

    let processedCount = 0;
    try {
      for (let processed = 0; processed < 20; processed += 1) {
        const event = await this.webhookInboxService.claimNext();
        if (!event) break;

        try {
          await this.processInboxEvent(event);
          await this.webhookInboxService.markProcessed(event.eventKey);
          processedCount += 1;
        } catch (error) {
          await this.webhookInboxService.markFailed(event, error);
          this.logger.error(`[Webhook] Intento ${event.attempts}/${event.maxAttempts} falló eventKey=${event.eventKey}`, this.errorMessage(error));
        }
      }
    } catch (error) {
      this.metrics.workerErrors += 1;
      this.logger.error('[WebhookWorker] No fue posible consultar o actualizar el inbox', this.errorMessage(error));
    } finally {
      this.isDraining = false;
    }

    if (processedCount > 0) {
      this.logger.log(`[WebhookWorker] Lote completado processed=${processedCount}`);
    }
  }

  getReliabilityMetrics() {
    return {
      audit: this.auditLogService.getMetrics(),
      inbox: this.webhookInboxService.getMetrics(),
      webhook: { ...this.metrics },
    };
  }

  private async processInboxEvent(event: WebhookInboxDocument): Promise<void> {
    const metadata = event.payload?.metadata;
    const requestMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as WebhookMetadata) : {};

    await this.handleWebhook(event.paymentId, event.eventType, {
      ...requestMetadata,
      eventKey: event.eventKey,
      requestId: event.requestId,
      attempt: event.attempts,
    });
  }

  private async updateReservationState(reservationId: string, metadata: WebhookMetadata = {}, idempotencyKey?: string) {
    try {
      const mainBackendUrl = this.configService.get<string>('BACKEND_URL');
      const response = await fetch(`${mainBackendUrl}/court-reserve/UpdateStateReserve/${reservationId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      this.logger.log(`[updateReservationState] Reserva ${reservationId} actualizada exitosamente`);
      await this.createAuditLog({
        entityType: 'COURT_RESERVE',
        entityId: reservationId,
        action: AUDIT_ACTIONS.RESERVATION_UPDATE_OK,
        description: `Reserva ${reservationId} actualizada exitosamente`,
        metadata,
      });
    } catch (error) {
      this.logger.error(`[updateReservationState] Error actualizando reserva ${reservationId}:`, error.message);
      await this.createAuditLog({
        entityType: 'COURT_RESERVE',
        entityId: reservationId,
        action: AUDIT_ACTIONS.RESERVATION_UPDATE_ERROR,
        description: `Error actualizando reserva ${reservationId}`,
        metadata: {
          ...metadata,
          error: error?.message,
        },
      });
      throw error;
    }
  }

  private async emailConfirmation(reservationId: string, paymentStatus: string, metadata: WebhookMetadata = {}, idempotencyKey?: string) {
    try {
      const mainBackendUrl = this.configService.get<string>('BACKEND_URL');
      const response = await fetch(`${mainBackendUrl}/court-reserve/emailconfirmation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: JSON.stringify({
          reservationId: reservationId,
          paymentStatus: paymentStatus,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      this.logger.log(`[emailConfirmation] Reserva ${reservationId} correo status enviado exitosamente`);
      await this.createAuditLog({
        entityType: 'COURT_RESERVE',
        entityId: reservationId,
        action: AUDIT_ACTIONS.EMAIL_CONFIRMATION_OK,
        description: `Correo de confirmacion enviado para reserva ${reservationId}`,
        metadata: {
          ...metadata,
          paymentStatus,
        },
      });
    } catch (error) {
      this.logger.error(`[emailConfirmation] Error enviando correo de estatus reserva ${reservationId}:`, error.message);
      await this.createAuditLog({
        entityType: 'COURT_RESERVE',
        entityId: reservationId,
        action: AUDIT_ACTIONS.EMAIL_CONFIRMATION_ERROR,
        description: `Error enviando correo de confirmacion para reserva ${reservationId}`,
        metadata: {
          ...metadata,
          paymentStatus,
          error: error?.message,
        },
      });
      throw error;
    }
  }

  async createPaymentPreference(paymentDTO: CreateMpDto) {
    const successUrl = this.configService.get<string>('MP_SUCCESS_URL');
    const failureUrl = this.configService.get<string>('MP_FAILURE_URL');
    const pendingUrl = this.configService.get<string>('MP_PENDING_URL');
    const notificationUrl = this.configService.get<string>('NOTIFICATION_URL');
    this.logger.log('[createPaymentPreference] Creando preferencia de pago...');
    try {
      const { courtId, date, time, player1, amount, idCourtReserve } = paymentDTO;
      const preferenceBody = {
        items: [
          {
            id: uuidv4().replace(/-/g, '').substring(0, 6),
            title: `Reserva Jugador: ${player1}`,
            description: `Fecha: ${date} - Turno: ${time} - Jugador: ${player1} - Cancha: ${courtId}`,
            quantity: 1,
            currency_id: 'CLP',
            unit_price: amount,
            category_id: 'services',
          },
        ],
        external_reference: idCourtReserve, // ID único de tu sistema
        back_urls: {
          success: successUrl,
          failure: failureUrl,
          pending: pendingUrl,
        },
        auto_return: 'approved',
        notification_url: notificationUrl,
        metadata: {
          courtId,
          date,
          time,
          player1,
        },
      };
      const preference = new Preference(this.client);
      const result = await preference.create({ body: preferenceBody });
      this.logger.log('[createPaymentPreference] Preferencia creada exitosamente.');
      return {
        preferenceId: result.id,
        initPoint: result.init_point,
      };
    } catch (error) {
      this.logger.error('Error al crear la preferencia', error.message);
      throw new Error(error.message);
    }
  }

  /**
   * Maneja la notificación de Webhook recibida de Mercado Pago.
   * @param paymentId El ID del pago notificado (viene de body.data.id)
   */
  async handleWebhook(paymentId: string, eventType = 'unknown', requestMetadata: WebhookMetadata = {}): Promise<void> {
    this.logger.log(`[Webhook] Recibiendo Payment ID: ${paymentId} (eventType: ${eventType || 'unknown'})`);

    await this.createAuditLog({
      entityType: 'PAYMENT',
      entityId: paymentId,
      action: AUDIT_ACTIONS.WEBHOOK_RECEIVED,
      description: `Webhook recibido para paymentId ${paymentId}`,
      metadata: {
        ...requestMetadata,
        eventType: eventType || 'unknown',
      },
    });

    try {
      const paymentSDK = new Payment(this.client);
      const paymentInfo = await paymentSDK.get({ id: paymentId });

      this.logger.log(`[Webhook] Estado del pago: ${paymentInfo.status}`);
      this.logger.log(`[Webhook] External Reference: ${paymentInfo.external_reference}`);
      this.logger.log(`[Webhook] Email del pagador: ${paymentInfo.payer?.email || 'unknown'}`);
      this.logger.log(`[Webhook] Monto: ${paymentInfo.transaction_amount} ${paymentInfo.currency_id}`);

      const baseMetadata = {
        ...requestMetadata,
        paymentId,
        eventType: eventType || 'unknown',
        status: paymentInfo.status,
        externalReference: paymentInfo.external_reference,
        amount: paymentInfo.transaction_amount,
        currency: paymentInfo.currency_id,
      };

      await this.createAuditLog({
        entityType: 'PAYMENT',
        entityId: paymentId,
        action:
          paymentInfo.status === 'approved'
            ? AUDIT_ACTIONS.WEBHOOK_PAYMENT_APPROVED
            : paymentInfo.status === 'pending'
              ? AUDIT_ACTIONS.WEBHOOK_PAYMENT_PENDING
              : AUDIT_ACTIONS.WEBHOOK_PAYMENT_REJECTED,
        description: `Webhook procesado con estado ${paymentInfo.status}`,
        metadata: baseMetadata,
      });

      if (!paymentInfo.external_reference) {
        this.logger.warn('[Webhook] External Reference vacío o indefinido.');
      }

      if (paymentInfo.status === 'approved') {
        this.logger.log('¡PAGO APROBADO!');
        this.logger.log(`ID Reserva (external_reference): ${paymentInfo.external_reference}`);
        if (!paymentInfo.external_reference) {
          throw new Error('Approved payment has no external_reference');
        }
        const effectKey = `mercadopago:${paymentId}:reservation-approved`;
        await this.webhookInboxService.executeEffectOnce(effectKey, String(requestMetadata.eventKey || paymentId), 'RESERVATION_UPDATE', () =>
          this.updateReservationState(paymentInfo.external_reference, baseMetadata, effectKey),
        );
      } else {
        // El pago no fue aprobado (ej. "rejected", "pending")
        this.logger.warn(`[Webhook] Pago NO aprobado. Estado: ${paymentInfo.status}`);
      }
      if (paymentInfo.external_reference) {
        const effectKey = `mercadopago:${paymentId}:email:${paymentInfo.status}`;
        await this.webhookInboxService.executeEffectOnce(effectKey, String(requestMetadata.eventKey || paymentId), 'EMAIL_CONFIRMATION', () =>
          this.emailConfirmation(paymentInfo.external_reference, paymentInfo.status, baseMetadata, effectKey),
        );
      } else {
        this.logger.warn('[Webhook] Email confirmation omitido: external_reference vacío.');
      }
    } catch (error) {
      this.logger.error(`[Webhook] Error al procesar el pago ${paymentId}`, error.message);
      await this.createAuditLog({
        entityType: 'PAYMENT',
        entityId: paymentId,
        action: AUDIT_ACTIONS.WEBHOOK_ERROR,
        description: `Error procesando webhook para paymentId ${paymentId}`,
        metadata: {
          ...requestMetadata,
          eventType: eventType || 'unknown',
          error: error?.message,
        },
      });
      throw error;
    }
  }

  private createAuditLog(payload: Parameters<AuditLogService['createAuditLog']>[0]): Promise<void> {
    const metadata = payload.metadata ?? {};
    return this.auditLogService.createAuditLog({
      ...payload,
      correlationId: payload.correlationId ?? this.stringValue(metadata.eventKey),
      requestId: payload.requestId ?? this.stringValue(metadata.requestId),
      source: payload.source ?? this.stringValue(metadata.source),
      status: payload.status ?? this.stringValue(metadata.status),
    });
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
