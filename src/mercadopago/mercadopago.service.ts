import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvalidWebhookSignatureError, MercadoPagoConfig, Payment, Preference, WebhookSignatureValidator } from 'mercadopago';
import { CreateMpDto } from './dto/create-mp.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-log/audit-log.constants';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { WebhookInboxService } from '../audit-log/webhook-inbox.service';
import { WebhookInboxDocument } from '../audit-log/webhook-inbox.entity';
import { CreateMembershipPreferenceDto } from './dto/membership-payment.dto';

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
          'x-api-key': this.internalApiKey(),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const reservation = await response.json();
      this.logger.log(`[updateReservationState] Reserva ${reservationId} actualizada exitosamente`);
      await this.createAuditLog({
        entityType: 'COURT_RESERVE',
        entityId: reservationId,
        action: AUDIT_ACTIONS.RESERVATION_UPDATE_OK,
        description: `Reserva ${reservationId} actualizada exitosamente`,
        metadata,
      });
      return reservation;
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
          'x-api-key': this.internalApiKey(),
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
      const result = await response.json();
      if (result.skipped === 'PAYMENT_REVIEW_REQUIRED') {
        this.logger.warn(`[emailConfirmation] Reserva ${reservationId} requiere revisión; no se envió confirmación.`);
        return;
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

  private async membershipAccount() {
    const response = await fetch('https://api.mercadopago.com/users/me', {
      headers: { Authorization: `Bearer ${this.configService.get<string>('MP_ACCESS_TOKEN')}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new ServiceUnavailableException('Could not verify Mercado Pago account.');
    const account = await response.json();
    if (!/^\d+$/.test(String(account.id || '')) || account.site_id !== 'MLC') throw new ServiceUnavailableException('A verified Chile account is required.');
    return String(account.id);
  }

  async membershipConfiguration() {
    const collectorId = await this.membershipAccount();
    this.checkedUrl(this.configService.get<string>('BACKEND_URL'));
    this.checkedUrl(this.configService.get<string>('MP_SUCCESS_URL'));
    const notification = new URL(this.checkedUrl(this.configService.get<string>('NOTIFICATION_URL')));
    if (notification.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(notification.hostname) || !this.configService.get<string>('MP_WEBHOOK_SECRET'))
      throw new ServiceUnavailableException('A signed public HTTPS webhook is required.');
    this.internalApiKey();
    return { ready: true, collectorId, currency: 'CLP' };
  }

  private async membershipPreference(reference: string, collectorId: string, preferenceId?: string) {
    const result = await new Preference(this.client).search({ options: { external_reference: reference, limit: 100 } });
    if (!Array.isArray(result.elements) || result.total !== 1 || result.elements.length !== 1)
      throw new ServiceUnavailableException('The monthly preference could not be verified uniquely.');
    const preference = result.elements[0];
    if (
      !preference.id ||
      (preferenceId && preference.id !== preferenceId) ||
      preference.external_reference !== reference ||
      String(preference.collector_id) !== collectorId ||
      typeof preference.live_mode !== 'boolean'
    )
      throw new ServiceUnavailableException('Monthly preference account or mode could not be verified.');
    return { id: preference.id, collectorId, liveMode: preference.live_mode };
  }

  private async verifiedMembershipSnapshot(paymentId: string, payment: any) {
    const snapshot = this.membershipSnapshot(paymentId, payment);
    const collectorId = await this.membershipAccount();
    const preference = await this.membershipPreference(snapshot.reference, collectorId);
    if (snapshot.collectorId !== collectorId || snapshot.liveMode !== preference.liveMode)
      throw new ServiceUnavailableException('Payment does not match its verified account or preference mode.');
    return { ...snapshot, preference };
  }

  private checkedUrl(value: string) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ServiceUnavailableException('Monthly URL is not configured.');
    }
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
      throw new ServiceUnavailableException('An HTTPS or local development URL is required.');
    return url.toString();
  }

  async createMembershipPreference(dto: CreateMembershipPreferenceDto) {
    if (
      dto.purpose !== 'MEMBERSHIP' ||
      !/^membership-[a-f\d-]{36}$/i.test(dto.reference) ||
      !Number.isSafeInteger(dto.amount) ||
      dto.amount <= 0 ||
      !['TEST', 'STANDARD'].includes(dto.pricingMode) ||
      !Number.isFinite(Date.parse(dto.expiresAt)) ||
      Date.parse(dto.expiresAt) <= Date.now()
    )
      throw new BadRequestException('Invalid monthly checkout.');
    const { collectorId } = await this.membershipConfiguration();
    const returnUrl = new URL('/monthlypayments', this.checkedUrl(this.configService.get<string>('MP_SUCCESS_URL')));
    returnUrl.searchParams.set('reference', dto.reference);
    const notificationUrl = this.checkedUrl(this.configService.get<string>('NOTIFICATION_URL'));
    const monthlyClient = new MercadoPagoConfig({
      accessToken: this.configService.get<string>('MP_ACCESS_TOKEN'),
      options: { timeout: 15000, idempotencyKey: dto.reference },
    });
    const result = await new Preference(monthlyClient).create({
      body: {
        items: [{ id: dto.reference, title: 'Mensualidades Club de Tenis Quintero', quantity: 1, currency_id: 'CLP', unit_price: dto.amount, category_id: 'services' }],
        external_reference: dto.reference,
        metadata: { purpose: 'MEMBERSHIP', membership_reference: dto.reference, pricing_mode: dto.pricingMode },
        back_urls: { success: returnUrl.toString(), failure: returnUrl.toString(), pending: returnUrl.toString() },
        ...(returnUrl.protocol === 'https:' ? { auto_return: 'approved' as const } : {}),
        notification_url: notificationUrl,
        expires: true,
        expiration_date_from: new Date().toISOString(),
        expiration_date_to: dto.expiresAt,
      },
    });
    if (String(result.collector_id) !== collectorId) throw new ServiceUnavailableException('Unexpected monthly preference collector.');
    const context = await this.membershipPreference(dto.reference, collectorId, String(result.id));
    if (!context.liveMode && dto.pricingMode !== 'TEST') throw new ServiceUnavailableException('Sandbox is restricted to authorized test dues.');
    const initPoint = context.liveMode ? result.init_point : result.sandbox_init_point;
    if (!result.id || !initPoint) throw new ServiceUnavailableException('Incomplete monthly preference response.');
    const checkout = new URL(initPoint);
    if (checkout.protocol !== 'https:' || checkout.username || checkout.password || !/^(www\.|sandbox\.)?mercadopago\.(cl|com|com\.ar|com\.br)$/.test(checkout.hostname))
      throw new ServiceUnavailableException('Unexpected Mercado Pago checkout URL.');
    return { preferenceId: String(result.id), initPoint, collectorId, liveMode: context.liveMode };
  }

  private membershipSnapshot(paymentId: string, payment: any) {
    const metadata = payment.metadata;
    if (
      !/^\d+$/.test(paymentId) ||
      String(payment.id) !== paymentId ||
      !/^membership-[a-f\d-]{36}$/i.test(payment.external_reference || '') ||
      metadata?.purpose !== 'MEMBERSHIP' ||
      metadata?.membership_reference !== payment.external_reference ||
      !['TEST', 'STANDARD'].includes(metadata?.pricing_mode) ||
      !Number.isSafeInteger(payment.transaction_amount) ||
      payment.transaction_amount <= 0 ||
      typeof payment.currency_id !== 'string' ||
      typeof payment.status !== 'string' ||
      !/^\d+$/.test(String(payment.collector_id || '')) ||
      typeof payment.live_mode !== 'boolean'
    )
      throw new ServiceUnavailableException('Incomplete or inconsistent monthly provider evidence.');
    return {
      paymentId,
      reference: payment.external_reference,
      purpose: metadata.purpose,
      amount: payment.transaction_amount,
      currency: payment.currency_id,
      status: payment.status,
      collectorId: String(payment.collector_id),
      liveMode: payment.live_mode,
      pricingMode: metadata.pricing_mode,
      ...(payment.date_approved ? { approvedAt: payment.date_approved } : {}),
      ...(payment.date_last_updated ? { updatedAt: payment.date_last_updated } : {}),
      refundedAmount: payment.transaction_amount_refunded || 0,
    };
  }

  async getMembershipPayment(paymentId: string) {
    if (!/^\d+$/.test(paymentId)) throw new BadRequestException('Invalid payment ID.');
    return this.verifiedMembershipSnapshot(paymentId, await new Payment(this.client).get({ id: paymentId }));
  }

  async reconcileMembership(reference: string) {
    if (!/^membership-[a-f\d-]{36}$/i.test(reference)) throw new BadRequestException('Invalid monthly reference.');
    const collectorId = await this.membershipAccount();
    const result = await new Payment(this.client).search({ options: { external_reference: reference, sort: 'date_created', criteria: 'desc', limit: 100 } });
    if (!Array.isArray(result.results) || !Number.isSafeInteger(result.paging?.total) || result.paging.total !== result.results.length)
      throw new ServiceUnavailableException('Incomplete reconciliation; do not create a second checkout.');
    const preference = result.results.length ? await this.membershipPreference(reference, collectorId) : null;
    for (const payment of result.results) {
      const snapshot = this.membershipSnapshot(String(payment.id), payment);
      if (snapshot.reference !== reference || snapshot.collectorId !== collectorId || snapshot.liveMode !== preference.liveMode)
        throw new ServiceUnavailableException('Mismatched reconciliation reference, account or mode.');
      const eventKey = createHash('sha256')
        .update(`membership-reconcile:${JSON.stringify(snapshot)}`)
        .digest('hex');
      await this.webhookInboxService.enqueue({ eventKey, paymentId: snapshot.paymentId, eventType: 'payment', payload: { metadata: { source: 'membership-reconciliation' } } });
    }
    queueMicrotask(() => void this.drainInbox());
    return { queued: result.results.length };
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
        ...(paymentDTO.expiresAt
          ? {
              expires: true,
              expiration_date_from: new Date().toISOString(),
              expiration_date_to: paymentDTO.expiresAt,
            }
          : {}),
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
      throw new ServiceUnavailableException('No se pudo crear la preferencia de pago. Intente nuevamente.');
    }
  }

  async reconcileReservation(reservationId: string): Promise<{ status: string }> {
    const result = await new Payment(this.client).search({
      options: {
        external_reference: reservationId,
        sort: 'date_created',
        criteria: 'desc',
        limit: 100,
      },
    });
    const payments = result.results;
    const total = result.paging?.total;
    // Never release on a malformed or partial response.
    if (!Array.isArray(payments) || !Number.isSafeInteger(total) || total < 0 || total !== payments.length) return { status: 'processing' };
    if (payments.some((payment) => !payment || payment.external_reference !== reservationId || typeof payment.status !== 'string')) return { status: 'processing' };
    const approved = payments.find((payment) => payment.status === 'approved');
    if (approved?.id) {
      const paymentId = String(approved.id);
      const eventKey = createHash('sha256').update(`hold-reconciliation:mercadopago:${paymentId}`).digest('hex');
      // Internal authenticated reconciliation also needs durable retries, especially
      // when the reservation is activated but the email service is unavailable.
      await this.webhookInboxService.enqueue({
        eventKey,
        paymentId,
        eventType: 'payment',
        payload: { metadata: { source: 'hold-expiration' } },
      });
      queueMicrotask(() => void this.drainInbox());
      return { status: 'approved' };
    }
    if (payments.some((payment) => !['rejected', 'cancelled', 'refunded', 'charged_back'].includes(payment.status))) return { status: 'processing' };
    return { status: payments.length ? 'rejected' : 'unpaid' };
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

      // Monthly references never reach reservation activation or reservation email callbacks.
      if (paymentInfo.metadata?.purpose === 'MEMBERSHIP' || paymentInfo.external_reference?.startsWith('membership-')) {
        const snapshot = await this.verifiedMembershipSnapshot(paymentId, paymentInfo);
        const fingerprint = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
        const effectKey = `membership:${paymentId}:${fingerprint}`;
        await this.webhookInboxService.executeEffectOnce(effectKey, String(requestMetadata.eventKey || paymentId), 'MEMBERSHIP_PAYMENT', async () => {
          const backend = this.checkedUrl(this.configService.get<string>('BACKEND_URL'));
          const response = await fetch(`${backend.replace(/\/$/, '')}/membership-billing/internal/mercado-pago`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': this.internalApiKey() },
            body: JSON.stringify({ paymentId }),
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) throw new Error(`Membership callback HTTP ${response.status}`);
        });
        return;
      }

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
        let needsReview = false;
        await this.webhookInboxService.executeEffectOnce(effectKey, String(requestMetadata.eventKey || paymentId), 'RESERVATION_UPDATE', async () => {
          const reserve = await this.updateReservationState(paymentInfo.external_reference, baseMetadata, effectKey);
          needsReview = reserve.reservationStatus === 'PAYMENT_REVIEW_REQUIRED';
        });
        if (needsReview) {
          this.logger.error(`[Webhook] Pago ${paymentId} recibido para un horario ocupado. Reserva ${paymentInfo.external_reference} requiere revisión del club.`);
          return;
        }
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

  private internalApiKey(): string {
    const apiKey = this.configService.get<string>('INTERNAL_API_KEY');
    if (!apiKey) {
      throw new Error('INTERNAL_API_KEY is not configured');
    }
    return apiKey;
  }
}
