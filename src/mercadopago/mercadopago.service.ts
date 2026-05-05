import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig, Payment, Preference } from 'mercadopago';
import { CreateMpDto } from './dto/create-mp.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-log/audit-log.constants';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class MercadopagoService {
  private readonly logger = new Logger(MercadopagoService.name);
  private readonly client: MercadoPagoConfig;

  constructor(
    private configService: ConfigService,
    private auditLogService: AuditLogService,
  ) {
    const accessToken = this.configService.get<string>('MP_ACCESS_TOKEN');
    if (!accessToken) {
      throw new Error('MP_ACCESS_TOKEN no está definido en las variables de entorno');
    }
    this.client = new MercadoPagoConfig({
      accessToken: accessToken,
    });
  }

  private async updateReservationState(reservationId: string, metadata?: Record<string, any>) {
    try {
      const mainBackendUrl = this.configService.get<string>('BACKEND_URL');
      const response = await fetch(`${mainBackendUrl}/court-reserve/UpdateStateReserve/${reservationId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      this.logger.log(`[updateReservationState] Reserva ${reservationId} actualizada exitosamente`);
      await this.auditLogService.createAuditLog({
        entityType: 'COURT_RESERVE',
        entityId: reservationId,
        action: AUDIT_ACTIONS.RESERVATION_UPDATE_OK,
        description: `Reserva ${reservationId} actualizada exitosamente`,
        metadata,
      });
    } catch (error) {
      this.logger.error(`[updateReservationState] Error actualizando reserva ${reservationId}:`, error.message);
      await this.auditLogService.createAuditLog({
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

  private async emailConfirmation(reservationId: string, paymentStatus: string, metadata?: Record<string, any>) {
    try {
      const mainBackendUrl = this.configService.get<string>('BACKEND_URL');
      const response = await fetch(`${mainBackendUrl}/court-reserve/emailconfirmation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reservationId: reservationId,
          paymentStatus: paymentStatus,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      this.logger.log(`[emailConfirmation] Reserva ${reservationId} correo status enviado exitosamente`);
      await this.auditLogService.createAuditLog({
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
      await this.auditLogService.createAuditLog({
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
  async handleWebhook(paymentId: string, eventType?: string, requestMetadata?: Record<string, any>) {
    this.logger.log(`[Webhook] Recibiendo Payment ID: ${paymentId} (eventType: ${eventType || 'unknown'})`);

    await this.auditLogService.createAuditLog({
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

      await this.auditLogService.createAuditLog({
        entityType: 'PAYMENT',
        entityId: paymentId,
        action: paymentInfo.status === 'approved' ? AUDIT_ACTIONS.WEBHOOK_PAYMENT_APPROVED : paymentInfo.status === 'pending' ? AUDIT_ACTIONS.WEBHOOK_PAYMENT_PENDING : AUDIT_ACTIONS.WEBHOOK_PAYMENT_REJECTED,
        description: `Webhook procesado con estado ${paymentInfo.status}`,
        metadata: baseMetadata,
      });

      if (!paymentInfo.external_reference) {
        this.logger.warn('[Webhook] External Reference vacío o indefinido.');
      }

      if (paymentInfo.status === 'approved') {
        this.logger.log('¡PAGO APROBADO!');
        this.logger.log(`ID Reserva (external_reference): ${paymentInfo.external_reference}`);
        await this.updateReservationState(paymentInfo.external_reference, baseMetadata);
      } else {
        // El pago no fue aprobado (ej. "rejected", "pending")
        this.logger.warn(`[Webhook] Pago NO aprobado. Estado: ${paymentInfo.status}`);
      }
      if (paymentInfo.external_reference) {
        await this.emailConfirmation(paymentInfo.external_reference, paymentInfo.status, baseMetadata);
      } else {
        this.logger.warn('[Webhook] Email confirmation omitido: external_reference vacío.');
      }
    } catch (error) {
      this.logger.error(`[Webhook] Error al procesar el pago ${paymentId}`, error.message);
      await this.auditLogService.createAuditLog({
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
    }
  }
}
